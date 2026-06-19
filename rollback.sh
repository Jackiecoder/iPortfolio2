#!/bin/bash
# Roll Cloud Run traffic back to the revision recorded by deploy.sh.
# Instant, traffic-only switch — no rebuild, database untouched.
#
# Usage:  ./rollback.sh

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .last_good_revision ]; then
  echo "ERROR: .last_good_revision not found. Run deploy.sh first, or roll back manually:" >&2
  echo "  gcloud run services list" >&2
  echo "  gcloud run revisions list --service <SERVICE> --region <REGION>" >&2
  echo "  gcloud run services update-traffic <SERVICE> --region <REGION> --to-revisions <REV>=100" >&2
  exit 1
fi

read -r SERVICE REGION REV < .last_good_revision
echo "Rolling $SERVICE (region $REGION) back to revision: $REV"
gcloud run services update-traffic "$SERVICE" --region "$REGION" --to-revisions "$REV=100"
echo "Done. Traffic now served by $REV."
