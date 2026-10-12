#!/bin/bash
# Deploy iPortfolio2 to Cloud Run with automatic rollback safety.
#
# What it does:
#   1. Auto-detects your Cloud Run service + region (or uses the vars below).
#   2. Records the currently-serving revision to .last_good_revision so
#      rollback.sh can instantly switch back.
#   3. Builds a uniquely named request-billed revision without changing traffic.
#   4. Verifies the exact revision and configures the five-minute OIDC Scheduler.
#   5. Promotes it unless DEPLOY_TAG is set, and confirms traffic before success.
#
# Application startup applies the idempotent schema.sql migration to Cloud SQL.
#
# Usage:  ./deploy.sh
# If auto-detect picks the wrong service, set SERVICE / REGION below.
# Optional: REVISION_SUFFIX=release-name ./deploy.sh (must be a fresh name).
# DEPLOY_TAG=preview ./deploy.sh creates a tagged preview without promotion.

set -euo pipefail
cd "$(dirname "$0")"

# ---- Optional: hard-code these if you have more than one Cloud Run service ----
SERVICE="${SERVICE:-}"
REGION="${REGION:-}"
PROJECT_ID="${PROJECT_ID:-${CLOUDSDK_CORE_PROJECT:-}}"
DEPLOY_TAG="${DEPLOY_TAG:-}"
# ------------------------------------------------------------------------------

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud CLI not found. Install it / run 'gcloud auth login' first." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required to verify Cloud Run deployment status." >&2
  exit 1
fi

if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID="$(gcloud config get-value project)"
fi
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  echo "ERROR: Set PROJECT_ID or configure a gcloud project first." >&2
  exit 1
fi

# Auto-detect the service if not provided.
if [ -z "$SERVICE" ] || [ -z "$REGION" ]; then
  echo "Detecting Cloud Run services..."
  LINES="$(gcloud run services list --platform=managed --project="$PROJECT_ID" \
      --format='value(metadata.name,region)' 2>/dev/null)"
  LINE_COUNT="$(printf '%s\n' "$LINES" | awk 'NF { count++ } END { print count + 0 }')"
  if [ "$LINE_COUNT" -eq 0 ]; then
    echo "ERROR: No Cloud Run services found for the active project." >&2
    echo "Check: gcloud config get-value project" >&2
    exit 1
  elif [ "$LINE_COUNT" -eq 1 ]; then
    SERVICE="$(printf '%s\n' "$LINES" | awk 'NF {print $1; exit}')"
    REGION="$(printf '%s\n' "$LINES" | awk 'NF {print $2; exit}')"
    echo "Using service '$SERVICE' in region '$REGION'."
  else
    echo "Multiple services found — set SERVICE and REGION at the top of deploy.sh:" >&2
    printf '%s\n' "$LINES" | sed 's/^/  /' >&2
    exit 1
  fi
fi

# Require a fresh revision name so a stale latestReadyRevisionName cannot be
# mistaken for this deployment. Cloud Run revision names must fit in 63 chars.
REVISION_SUFFIX="${REVISION_SUFFIX:-release-$(date -u +%Y%m%d-%H%M%S)-$RANDOM}"
TARGET_REV="$SERVICE-$REVISION_SUFFIX"
if [ "${#TARGET_REV}" -gt 63 ] || ! [[ "$TARGET_REV" =~ ^[a-z][a-z0-9-]*[a-z0-9]$ ]]; then
  echo "ERROR: invalid revision name '$TARGET_REV'; use a shorter lowercase REVISION_SUFFIX." >&2
  exit 1
fi
if gcloud run revisions describe "$TARGET_REV" --project="$PROJECT_ID" --region="$REGION" \
    --format='value(metadata.name)' >/dev/null 2>&1; then
  echo "ERROR: revision '$TARGET_REV' already exists; choose a fresh REVISION_SUFFIX." >&2
  exit 1
fi

# Read resolved traffic, because latestReady may be a revision serving no traffic.
serving_revision() {
  python3 -c '
import json, sys
try:
    traffic = json.load(sys.stdin).get("status", {}).get("traffic", [])
    serving = [entry for entry in traffic if int(entry.get("percent", 0)) > 0]
    if len(serving) == 1 and int(serving[0]["percent"]) == 100:
        print(serving[0].get("revisionName", ""))
except (ValueError, TypeError, AttributeError):
    pass
'
}
traffic_distribution() {
  python3 -c '
import json, sys
traffic = json.load(sys.stdin).get("status", {}).get("traffic", [])
distribution = {}
for entry in traffic:
    percent = int(entry.get("percent", 0))
    if percent > 0:
        revision = entry.get("revisionName")
        if not revision:
            sys.exit("Traffic has no resolved revision name.")
        distribution[revision] = distribution.get(revision, 0) + percent
if sum(distribution.values()) != 100:
    sys.exit("Traffic percentages are not confirmed.")
print(json.dumps(distribution, sort_keys=True))
'
}
CURRENT_STATUS="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
    --format='json(status.traffic,status.url)')"
CURRENT_REV="$(printf '%s' "$CURRENT_STATUS" | serving_revision)"
if [ -n "$DEPLOY_TAG" ]; then
  # Preview traffic must be verifiable, and a preview must not replace the
  # rollback snapshot from the last production release.
  CURRENT_TRAFFIC="$(printf '%s' "$CURRENT_STATUS" | traffic_distribution)"
elif [ -n "$CURRENT_REV" ]; then
  echo "$SERVICE $REGION $CURRENT_REV" > .last_good_revision
  echo "Recorded current revision for rollback: $CURRENT_REV"
else
  rm -f .last_good_revision
  echo "WARNING: no single revision is confirmed at 100% traffic; automatic rollback is unavailable." >&2
fi

# Scheduler uses its own identity and no application API token. The public web
# service keeps its existing IAM policy; the app verifies Google's signature and
# permits this account only on /api/internal/refresh, returning no portfolio data.
SCHEDULER_ACCOUNT_ID="${SERVICE}-scheduler"
SCHEDULER_SERVICE_ACCOUNT="${SCHEDULER_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_JOB="${SERVICE}-market-refresh"
URL="$(printf '%s' "$CURRENT_STATUS" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("status", {}).get("url", ""))')"
if [ -z "$URL" ]; then
  echo "ERROR: the existing Cloud Run service URL is required for the Scheduler audience." >&2
  exit 1
fi
SCHEDULER_AUDIENCE="${URL}/api/internal/refresh"

gcloud services enable cloudscheduler.googleapis.com --project="$PROJECT_ID" --quiet
if ! gcloud iam service-accounts describe "$SCHEDULER_SERVICE_ACCOUNT" \
    --project="$PROJECT_ID" --format='value(email)' >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SCHEDULER_ACCOUNT_ID" --project="$PROJECT_ID" \
      --display-name="$SERVICE scheduled market refresh" --quiet
fi

echo ""
echo ">>> Deploying $SERVICE to Cloud Run (region $REGION) from source..."
# Keep at most one instance for process-local ledger/cache consistency. Clear
# BOTH service- and revision-level minimums; CPU is allocated only for requests.
# Scheduler owns the timer, and its response waits for persisted minute bars.
DEPLOY_ARGS=(--no-traffic --revision-suffix "$REVISION_SUFFIX")
if [ -n "$DEPLOY_TAG" ]; then
  DEPLOY_ARGS+=(--tag "$DEPLOY_TAG")
fi
gcloud run deploy "$SERVICE" "${DEPLOY_ARGS[@]}" --source . --project="$PROJECT_ID" --region "$REGION" \
    --min 0 --max 1 --min-instances 0 --max-instances 1 --cpu-throttling \
    --timeout=240s \
    --update-env-vars="MARKET_REFRESH_MODE=scheduler,SCHEDULER_SERVICE_ACCOUNT=${SCHEDULER_SERVICE_ACCOUNT},SCHEDULER_AUDIENCE=${SCHEDULER_AUDIENCE}"

# Verify the requested revision, rather than trusting the deploy command's
# latestReady success message. If this fails, the old traffic stays in place.
if ! gcloud run revisions describe "$TARGET_REV" --project="$PROJECT_ID" --region="$REGION" \
    --format='json(metadata.name,status.conditions)' | python3 -c '
import json, sys
revision = json.load(sys.stdin)
ready = any(condition.get("type") == "Ready" and condition.get("status") == "True"
            for condition in revision.get("status", {}).get("conditions", []))
if revision.get("metadata", {}).get("name") != sys.argv[1] or not ready:
    sys.exit("The requested revision is not ready.")
' "$TARGET_REV"; then
  echo "ERROR: revision '$TARGET_REV' was not confirmed ready; current traffic was left unchanged." >&2
  exit 1
fi

SCHEDULER_ACTION=create
if gcloud scheduler jobs describe "$SCHEDULER_JOB" --project="$PROJECT_ID" \
    --location="$REGION" --format='value(name)' >/dev/null 2>&1; then
  SCHEDULER_ACTION=update
fi
gcloud scheduler jobs "$SCHEDULER_ACTION" http "$SCHEDULER_JOB" \
    --project="$PROJECT_ID" --location="$REGION" \
    --schedule='*/5 * * * *' --time-zone='Etc/UTC' \
    --uri="$SCHEDULER_AUDIENCE" --http-method=POST --message-body='{}' \
    --oidc-service-account-email="$SCHEDULER_SERVICE_ACCOUNT" \
    --oidc-token-audience="$SCHEDULER_AUDIENCE" \
    --attempt-deadline=240s --max-retry-attempts=1 --min-backoff=30s \
    --description='Fetch and persist iPortfolio minute bars every five minutes' \
    --quiet

if [ -z "$DEPLOY_TAG" ]; then
  gcloud run services update-traffic "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
      --to-revisions "$TARGET_REV=100"
fi

DEPLOYED_STATUS="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
    --format='json(status.traffic,status.url)')"
if [ -n "$DEPLOY_TAG" ]; then
  DEPLOYED_TRAFFIC="$(printf '%s' "$DEPLOYED_STATUS" | traffic_distribution)"
  if [ "$DEPLOYED_TRAFFIC" != "$CURRENT_TRAFFIC" ]; then
    echo "ERROR: production traffic changed during the preview deployment." >&2
    exit 1
  fi
  URL="$(printf '%s' "$DEPLOYED_STATUS" | python3 -c '
import json, sys
traffic = json.load(sys.stdin).get("status", {}).get("traffic", [])
matches = [entry for entry in traffic if entry.get("tag") == sys.argv[1]
           and entry.get("revisionName") == sys.argv[2] and entry.get("url")]
if len(matches) != 1:
    sys.exit("The preview tag was not confirmed on the requested revision.")
print(matches[0]["url"])
' "$DEPLOY_TAG" "$TARGET_REV")"
else
  DEPLOYED_REV="$(printf '%s' "$DEPLOYED_STATUS" | serving_revision)"
  if [ "$DEPLOYED_REV" != "$TARGET_REV" ]; then
    echo "ERROR: traffic update was requested, but 100% traffic to '$TARGET_REV' has not been confirmed." >&2
    exit 1
  fi
  URL="$(printf '%s' "$DEPLOYED_STATUS" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("status", {}).get("url", ""))')"
fi
echo ""
echo "============================================================"
if [ -n "$DEPLOY_TAG" ]; then
  echo "Preview revision: $TARGET_REV (production traffic unchanged). URL: $URL"
else
  echo "Deployed revision: $TARGET_REV (100% traffic). URL: ${URL:-<unknown>}"
fi
echo "Scheduler: $SCHEDULER_JOB (every five minutes, $REGION)"
if [ -z "$DEPLOY_TAG" ] && [ -n "${CURRENT_REV:-}" ]; then
  echo "If something is wrong, roll back with:"
  echo "  ./rollback.sh"
  echo "(or: gcloud run services update-traffic $SERVICE --project=$PROJECT_ID --region $REGION --to-revisions $CURRENT_REV=100)"
fi
echo "============================================================"
