#!/bin/bash
# AccessBridge VPS Deployment Script
# Usage: ./deploy.sh [--skip-build] [--skip-push] [--skip-tests] [--no-check]
#
# Pipeline: build → test → push → rsync artifacts → VPS sync → health check
# SSH alias: a11yos-vps

set -euo pipefail

REMOTE="a11yos-vps"
REMOTE_DIR="/opt/accessbridge"
WWW_DIR="/var/www/accessbridge"
BRANCH="main"
HEALTH_URL="${HEALTH_URL:-https://accessbridge.space/api/version}"

SKIP_BUILD=false
SKIP_PUSH=false
SKIP_TESTS=false
SKIP_CHECK=false

for arg in "$@"; do
  case "$arg" in
    --skip-build)  SKIP_BUILD=true  ;;
    --skip-push)   SKIP_PUSH=true   ;;
    --skip-tests)  SKIP_TESTS=true  ;;
    --no-check)    SKIP_CHECK=true  ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

VERSION=$(node -p "require('./packages/extension/manifest.json').version")
echo "=== AccessBridge Deploy v${VERSION} ==="

# ─────────────────────────────────────────────────────────
# [1/6] typecheck + build + test (parallel)
# ─────────────────────────────────────────────────────────
# typecheck: ALWAYS runs — fast, catches a different class of bugs than vitest
# test: smart skip — --skip-tests only honored if HEAD matches last-tested and tree clean
# Tier 3 #9 — parallelized; Tier 2 #5 — errors no longer swallowed

LAST_TESTED_FILE="/tmp/accessbridge-last-tested.sha"
CURRENT_HEAD=$(git rev-parse HEAD)
DIRTY=$(git status --porcelain)
LAST_TESTED=$(cat "$LAST_TESTED_FILE" 2>/dev/null || echo "")

SHOULD_RUN_TESTS=true
if [ "$SKIP_TESTS" = true ]; then
  if [ -n "$DIRTY" ]; then
    echo "  ⚠ --skip-tests requested but working tree is dirty — running tests anyway."
  elif [ "$LAST_TESTED" = "$CURRENT_HEAD" ]; then
    SHOULD_RUN_TESTS=false
  else
    echo "  ⚠ --skip-tests requested but no cached pass for $CURRENT_HEAD — running tests."
  fi
fi

echo "[1/6] typecheck + build + test (parallel)..."
PIDS=()
LABELS=()

( pnpm typecheck ) > /tmp/accessbridge-typecheck.log 2>&1 &
PIDS+=($!); LABELS+=("typecheck")

if [ "$SKIP_BUILD" = false ]; then
  ( pnpm build ) > /tmp/accessbridge-build.log 2>&1 &
  PIDS+=($!); LABELS+=("build")
fi

if [ "$SHOULD_RUN_TESTS" = true ]; then
  ( npx vitest run --reporter=dot ) > /tmp/accessbridge-test.log 2>&1 &
  PIDS+=($!); LABELS+=("test")
else
  echo "  ✓ test — cached pass for ${CURRENT_HEAD:0:7}, skipping"
fi

FAILED=0
for i in "${!PIDS[@]}"; do
  if wait "${PIDS[$i]}"; then
    echo "  ✓ ${LABELS[$i]} passed"
  else
    echo "  ✗ ${LABELS[$i]} failed — tail of /tmp/accessbridge-${LABELS[$i]}.log:"
    tail -20 "/tmp/accessbridge-${LABELS[$i]}.log"
    FAILED=1
  fi
done

if [ "$FAILED" = "1" ]; then exit 1; fi

if [ "$SHOULD_RUN_TESTS" = true ]; then
  echo "$CURRENT_HEAD" > "$LAST_TESTED_FILE"
fi

# ─────────────────────────────────────────────────────────
# [2/6] Push to GitHub
# ─────────────────────────────────────────────────────────
if [ "$SKIP_PUSH" = false ]; then
  echo "[2/6] Pushing to GitHub..."
  git push origin "$BRANCH"
  echo "  ✓ Pushed to origin/$BRANCH."
else
  echo "[2/6] Skipping push"
fi

# ─────────────────────────────────────────────────────────
# [3/6] Rsync built artifacts to VPS
# ─────────────────────────────────────────────────────────
# Improvement: Tier 1 #1 — no more VPS-side build. Build once locally, ship artifacts.
# Improvement: Tier 1 #3 — extension zip now synced (was missing)
echo "[3/6] Syncing artifacts to VPS..."

if [ ! -f accessbridge-extension.zip ]; then
  echo "  ✗ accessbridge-extension.zip not found. Run build first."
  exit 1
fi

rsync -az --progress accessbridge-extension.zip \
  "$REMOTE:$REMOTE_DIR/docs/downloads/"
echo "  ✓ Extension zip synced (${VERSION})."

rsync -az --delete deploy/ "$REMOTE:$WWW_DIR/"
echo "  ✓ Landing page synced."

# ─────────────────────────────────────────────────────────
# [4/6] Sync code on VPS (for API / version file / etc.)
# ─────────────────────────────────────────────────────────
# Improvement: Tier 2 #6 — fetch+reset instead of pull (idempotent, no merge conflicts)
# Improvement: Tier 1 #2 — conditional install (skip if lockfile unchanged)
# Improvement: Tier 2 #4 — no more `|| npm install` silent fallback
echo "[4/6] Syncing VPS git state + conditional install..."
ssh "$REMOTE" bash -s <<REMOTE_SCRIPT
  set -euo pipefail
  cd "$REMOTE_DIR"

  echo "  Fetching origin..."
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"

  # Only install if lockfile changed since last deploy
  LOCK_HASH_FILE="/tmp/accessbridge-lock.sha256"
  CURRENT_HASH=\$(sha256sum pnpm-lock.yaml | awk '{print \$1}')
  STORED_HASH=\$(cat "\$LOCK_HASH_FILE" 2>/dev/null || echo "")

  if [ "\$CURRENT_HASH" != "\$STORED_HASH" ]; then
    echo "  Lockfile changed — installing..."
    pnpm install --frozen-lockfile
    echo "\$CURRENT_HASH" > "\$LOCK_HASH_FILE"
    echo "  ✓ Dependencies installed."
  else
    echo "  ✓ Lockfile unchanged — skipping install."
  fi
REMOTE_SCRIPT

# ─────────────────────────────────────────────────────────
# [5/6] Post-deploy health check
# ─────────────────────────────────────────────────────────
# Improvement: Tier 2 #8 — verify deploy landed + version matches
if [ "$SKIP_CHECK" = false ]; then
  echo "[5/6] Health check against $HEALTH_URL ..."
  sleep 2
  if RESPONSE=$(curl -fsS --max-time 10 "$HEALTH_URL" 2>&1); then
    if echo "$RESPONSE" | grep -q "$VERSION"; then
      echo "  ✓ Site is live with v${VERSION}."
    else
      echo "  ⚠ Site responding but version mismatch. API returned:"
      echo "    $RESPONSE"
      echo "  Expected version: $VERSION"
      exit 1
    fi
  else
    echo "  ✗ Site not responding. Check nginx / API."
    exit 1
  fi
else
  echo "[5/6] Skipping health check"
fi

# ─────────────────────────────────────────────────────────
# [6/6] Summary
# ─────────────────────────────────────────────────────────
echo "[6/6] Deploy complete!"
echo ""
echo "  Version:   $VERSION"
echo "  VPS repo:  $REMOTE:$REMOTE_DIR"
echo "  Landing:   $REMOTE:$WWW_DIR"
echo "  Download:  $REMOTE:$REMOTE_DIR/docs/downloads/accessbridge-extension.zip"
echo ""
echo "  Load in Chrome: chrome://extensions → Developer Mode → Load Unpacked"
