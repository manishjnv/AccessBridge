#!/bin/bash
# AccessBridge VPS Deployment Script
# Usage: ./deploy.sh [--skip-build] [--skip-push]
#
# Deploys to VPS at /opt/accessbridge
# SSH alias: a11yos-vps or accessbridge-vps

set -euo pipefail

REMOTE="a11yos-vps"
REMOTE_DIR="/opt/accessbridge"
BRANCH="main"

SKIP_BUILD=false
SKIP_PUSH=false

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --skip-push) SKIP_PUSH=true ;;
  esac
done

echo "=== AccessBridge Deploy ==="

# 1. Build locally
if [ "$SKIP_BUILD" = false ]; then
  echo "[1/5] Building extension..."
  pnpm build
  echo "  Build succeeded."
else
  echo "[1/5] Skipping build (--skip-build)"
fi

# 2. Run tests
echo "[2/5] Running tests..."
npx vitest run --reporter=dot 2>&1 || {
  echo "  Tests failed! Aborting deploy."
  exit 1
}
echo "  All tests passed."

# 3. Push to GitHub
if [ "$SKIP_PUSH" = false ]; then
  echo "[3/5] Pushing to GitHub..."
  git push origin "$BRANCH" 2>&1
  echo "  Pushed to origin/$BRANCH."
else
  echo "[3/5] Skipping push (--skip-push)"
fi

# 4. Deploy to VPS
echo "[4/5] Deploying to VPS ($REMOTE)..."
ssh "$REMOTE" bash -s <<'REMOTE_SCRIPT'
  set -euo pipefail
  cd /opt/accessbridge

  echo "  Pulling latest..."
  git pull origin main

  echo "  Installing dependencies..."
  pnpm install --frozen-lockfile 2>/dev/null || npm install

  echo "  Building on VPS..."
  pnpm build 2>/dev/null || npm run build

  # Copy landing page to nginx serve directory
  if [ -d /var/www/accessbridge ]; then
    cp -r deploy/* /var/www/accessbridge/ 2>/dev/null || true
    echo "  Landing page copied to /var/www/accessbridge/"
  fi

  echo "  Deploy complete on VPS."
REMOTE_SCRIPT

echo "[5/5] Deployment complete!"
echo ""
echo "Extension dist at: $REMOTE_DIR/packages/extension/dist/"
echo "Load in Chrome: chrome://extensions > Developer Mode > Load Unpacked"
