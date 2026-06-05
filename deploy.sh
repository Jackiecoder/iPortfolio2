#!/bin/bash
# Deploy iPortfolio2 to Cloud Run with automatic rollback safety.
#
# What it does:
#   1. Auto-detects your Cloud Run service + region (or uses the vars below).
#   2. Records the currently-serving revision to .last_good_revision so
#      rollback.sh can instantly switch back.
#   3. Builds from source (uses the Dockerfile) and deploys a new revision.
#   4. Prints the URL + a one-line rollback command.
#
# The database (Cloud SQL) is NOT touched — only the code image is replaced.
#
# Usage:  ./deploy.sh
# If auto-detect picks the wrong service, set SERVICE / REGION below.

set -euo pipefail
cd "$(dirname "$0")"

# ---- Optional: hard-code these if you have more than one Cloud Run service ----
SERVICE="${SERVICE:-}"
REGION="${REGION:-}"
# ------------------------------------------------------------------------------

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud CLI not found. Install it / run 'gcloud auth login' first." >&2
  exit 1
fi

# Auto-detect the service if not provided.
if [ -z "$SERVICE" ] || [ -z "$REGION" ]; then
  echo "Detecting Cloud Run services..."
  mapfile -t LINES < <(gcloud run services list --platform=managed \
      --format='value(metadata.name,region)' 2>/dev/null)
  if [ "${#LINES[@]}" -eq 0 ]; then
    echo "ERROR: No Cloud Run services found for the active project." >&2
    echo "Check: gcloud config get-value project" >&2
    exit 1
  elif [ "${#LINES[@]}" -eq 1 ]; then
    SERVICE="$(echo "${LINES[0]}" | awk '{print $1}')"
    REGION="$(echo "${LINES[0]}"  | awk '{print $2}')"
    echo "Using service '$SERVICE' in region '$REGION'."
  else
    echo "Multiple services found — set SERVICE and REGION at the top of deploy.sh:" >&2
    printf '  %s\n' "${LINES[@]}" >&2
    exit 1
  fi
fi

# Record the current good revision for rollback.
CURRENT_REV="$(gcloud run services describe "$SERVICE" --region "$REGION" \
    --format='value(status.latestReadyRevisionName)' 2>/dev/null || true)"
if [ -n "$CURRENT_REV" ]; then
  echo "$SERVICE $REGION $CURRENT_REV" > .last_good_revision
  echo "Recorded current revision for rollback: $CURRENT_REV"
else
  echo "WARNING: could not read current revision (first deploy?). Rollback file not written."
fi

echo ""
echo ">>> Deploying $SERVICE to Cloud Run (region $REGION) from source..."
gcloud run deploy "$SERVICE" --source . --region "$REGION"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" \
    --format='value(status.url)' 2>/dev/null || true)"
echo ""
echo "============================================================"
echo "Deployed. URL: ${URL:-<unknown>}"
if [ -n "${CURRENT_REV:-}" ]; then
  echo "If something is wrong, roll back with:"
  echo "  ./rollback.sh"
  echo "(or: gcloud run services update-traffic $SERVICE --region $REGION --to-revisions $CURRENT_REV=100)"
fi
echo "============================================================"
