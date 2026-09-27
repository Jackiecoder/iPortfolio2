#!/bin/bash
# Deploy iPortfolio2 to Cloud Run with automatic rollback safety.
#
# What it does:
#   1. Auto-detects your Cloud Run service + region (or uses the vars below).
#   2. Records the currently-serving revision to .last_good_revision so
#      rollback.sh can instantly switch back.
#   3. Deploys a request-billed revision that can scale to zero.
#   4. Creates/updates the OIDC-authenticated five-minute Scheduler job.
#   5. Prints the URL + a one-line rollback command.
#
# Application startup applies the idempotent schema.sql migration to Cloud SQL.
#
# Usage:  ./deploy.sh
# If auto-detect picks the wrong service, set SERVICE / REGION below.

set -euo pipefail
cd "$(dirname "$0")"

# ---- Optional: hard-code these if you have more than one Cloud Run service ----
SERVICE="${SERVICE:-}"
REGION="${REGION:-}"
PROJECT_ID="${PROJECT_ID:-${CLOUDSDK_CORE_PROJECT:-}}"
# ------------------------------------------------------------------------------

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud CLI not found. Install it / run 'gcloud auth login' first." >&2
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

# Scheduler uses its own identity and no application API token. The public web
# service keeps its existing IAM policy; the app verifies Google's signature and
# permits this account only on /api/internal/refresh, returning no portfolio data.
SCHEDULER_ACCOUNT_ID="${SERVICE}-scheduler"
SCHEDULER_SERVICE_ACCOUNT="${SCHEDULER_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_JOB="${SERVICE}-market-refresh"
URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
    --format='value(status.url)')"
SCHEDULER_AUDIENCE="${URL}/api/internal/refresh"

gcloud services enable cloudscheduler.googleapis.com --project="$PROJECT_ID" --quiet
if ! gcloud iam service-accounts describe "$SCHEDULER_SERVICE_ACCOUNT" \
    --project="$PROJECT_ID" --format='value(email)' >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SCHEDULER_ACCOUNT_ID" --project="$PROJECT_ID" \
      --display-name="$SERVICE scheduled market refresh" --quiet
fi

# Record the current good revision for rollback.
CURRENT_REV="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region "$REGION" \
    --format='value(status.latestReadyRevisionName)' 2>/dev/null || true)"
if [ -n "$CURRENT_REV" ]; then
  echo "$SERVICE $REGION $CURRENT_REV" > .last_good_revision
  echo "Recorded current revision for rollback: $CURRENT_REV"
else
  echo "WARNING: could not read current revision (first deploy?). Rollback file not written."
fi

echo ""
echo ">>> Deploying $SERVICE to Cloud Run (region $REGION) from source..."
# Keep at most one instance for process-local ledger/cache consistency. Clear
# BOTH service- and revision-level minimums; CPU is allocated only for requests.
# Scheduler owns the timer, and its response waits for persisted minute bars.
DEPLOY_ARGS=()
if [ -n "${DEPLOY_TAG:-}" ]; then
  DEPLOY_ARGS+=(--no-traffic --tag "$DEPLOY_TAG")
fi
gcloud run deploy "$SERVICE" "${DEPLOY_ARGS[@]}" --source . --project="$PROJECT_ID" --region "$REGION" \
    --min 0 --max 1 --min-instances 0 --max-instances 1 --cpu-throttling \
    --timeout=240s \
    --update-env-vars="MARKET_REFRESH_MODE=scheduler,SCHEDULER_SERVICE_ACCOUNT=${SCHEDULER_SERVICE_ACCOUNT},SCHEDULER_AUDIENCE=${SCHEDULER_AUDIENCE}"

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

URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region "$REGION" \
    --format='value(status.url)' 2>/dev/null || true)"
echo ""
echo "============================================================"
echo "Deployed. URL: ${URL:-<unknown>}"
echo "Scheduler: $SCHEDULER_JOB (every five minutes, $REGION)"
if [ -n "${CURRENT_REV:-}" ]; then
  echo "If something is wrong, roll back with:"
  echo "  ./rollback.sh"
  echo "(or: gcloud run services update-traffic $SERVICE --region $REGION --to-revisions $CURRENT_REV=100)"
fi
echo "============================================================"
