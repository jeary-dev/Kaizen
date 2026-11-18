#!/usr/bin/env bash
# Builds the web app and installs the standalone server into a folder, for the systemd setup.
#   deploy/build-standalone.sh /opt/kaizen/web
# Then: sudo systemctl restart kaizen-web
set -euo pipefail

target="${1:?usage: build-standalone.sh <install-dir>}"
web="$(cd "$(dirname "${BASH_SOURCE[0]}")/../web" && pwd)"

cd "$web"
npm ci --no-audit --no-fund
NEXT_TELEMETRY_DISABLED=1 npm run build

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
cp -r .next/standalone/. "$staging/"
cp -r .next/static "$staging/.next/static"
cp -r public "$staging/public"
mkdir -p "$staging/.next/cache"

# Swap in one step so a running service never sees a half-copied folder.
sudo mkdir -p "$(dirname "$target")"
if [[ -d "$target" ]]; then sudo rm -rf "$target.old" && sudo mv "$target" "$target.old"; fi
sudo mv "$staging" "$target"
sudo chmod -R a+rX "$target"
trap - EXIT
echo "✓ Installed into $target. Restart with: sudo systemctl restart kaizen-web"
