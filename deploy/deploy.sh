#!/usr/bin/env bash
# Update and restart the Kaizen web app with minimal downtime:
#   1. pull the latest code (fast-forward only)
#   2. build the new image while the old container keeps serving
#   3. swap containers and wait until the new one is healthy (a few seconds of downtime)
#   4. remove dangling images
#
# Usage: deploy/deploy.sh            (from anywhere in the repository)
#        SKIP_PULL=1 deploy/deploy.sh  (deploy the working tree as it is)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"
compose=(docker compose -f "$here/compose.yaml")

if [[ "${SKIP_PULL:-}" != "1" ]]; then
  echo "→ Pulling latest code"
  git -C "$here/.." pull --ff-only
fi

echo "→ Building image (the running container keeps serving)"
"${compose[@]}" build --pull

echo "→ Restarting"
"${compose[@]}" up -d --wait --wait-timeout 90

echo "→ Checking health"
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3100/api/v1/health >/dev/null; then
    echo "✓ Kaizen is up: $("${compose[@]}" images --format '{{.Repository}}:{{.Tag}} {{.ID}}' web 2>/dev/null || true)"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 1
done

echo "✗ Kaizen did not become healthy. Recent logs:" >&2
"${compose[@]}" logs --tail 50 web >&2
exit 1
