#!/bin/bash
# AccessBridge VPS Deployment Script
# Usage: ./deploy.sh [--skip-build] [--skip-push] [--skip-tests] [--no-check]
#
# Pipeline: build → test → push → rsync artifacts → VPS sync → health check
# SSH alias: a11yos-vps

set -euo pipefail

REMOTE="a11yos-vps"
REMOTE_DIR="/opt/accessbridge"
WWW_DIR="/opt/accessbridge/docs"
BRANCH="main"
HEALTH_URL="${HEALTH_URL:-https://accessbridge.space/api/version}"

SKIP_BUILD=false
SKIP_PUSH=false
SKIP_TESTS=false
SKIP_CHECK=false
SKIP_BUMP=false

for arg in "$@"; do
  case "$arg" in
    --skip-build)  SKIP_BUILD=true  ;;
    --skip-push)   SKIP_PUSH=true   ;;
    --skip-tests)  SKIP_TESTS=true  ;;
    --no-check)    SKIP_CHECK=true  ;;
    --skip-bump)   SKIP_BUMP=true   ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ─────────────────────────────────────────────────────────
# [0/6] Auto-bump version from conventional commits since last v* tag
# ─────────────────────────────────────────────────────────
# feat:  -> minor, BREAKING/!: -> major, everything else -> patch.
# Skipped if no commits since last tag, or --skip-bump.
# The bumped commit + tag are pushed together via --follow-tags below.
PRE_BUMP_VERSION=$(node -p "require('./packages/extension/manifest.json').version")
if [ "$SKIP_BUMP" = false ]; then
  echo "[0/6] Auto-bump version (from conventional commits)..."
  set +e
  bash scripts/bump-version.sh --auto
  BUMP_RC=$?
  set -e
  case "$BUMP_RC" in
    0)  echo "  ✓ Version bumped" ;;
    42) echo "  ✓ No commits since last tag — staying on v${PRE_BUMP_VERSION}" ;;
    *)  echo "  ✗ scripts/bump-version.sh failed with exit $BUMP_RC"; exit "$BUMP_RC" ;;
  esac
else
  echo "[0/6] Skipping auto-bump (--skip-bump)"
fi

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
  ( pnpm test ) > /tmp/accessbridge-test.log 2>&1 &
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
# [1.5/6] Re-zip dist/ — guarantees zip manifest matches
# the freshly-bumped version. Runs even on --skip-build so
# that a manual dist/ edit or a post-bump no-op build still
# results in a version-consistent zip.
# See RCA BUG-011.
# ─────────────────────────────────────────────────────────
echo "[1.5/6] Re-packaging extension zip from dist/ ..."
DIST_DIR="packages/extension/dist"
if [ ! -d "$DIST_DIR" ]; then
  echo "  ✗ $DIST_DIR not found. Run pnpm build first or drop --skip-build."
  exit 1
fi
rm -f accessbridge-extension.zip
if command -v zip >/dev/null 2>&1; then
  (cd "$DIST_DIR" && zip -rq ../../../accessbridge-extension.zip .)
else
  # Windows Git Bash without zip — fall back to PowerShell Compress-Archive
  powershell -NoProfile -Command \
    "Compress-Archive -Path '$DIST_DIR\\*' -DestinationPath 'accessbridge-extension.zip' -Force" \
    >/dev/null
fi

# Cross-check: zip's manifest.json version must equal $VERSION.
# Guards against a stale dist/ being re-packaged.
ZIP_MANIFEST_VERSION=$(python -c "import zipfile,json; z=zipfile.ZipFile('accessbridge-extension.zip'); print(json.loads(z.read('manifest.json').decode())['version'])" 2>/dev/null)
if [ "$ZIP_MANIFEST_VERSION" != "$VERSION" ]; then
  echo "  ✗ Zip manifest says v${ZIP_MANIFEST_VERSION:-unknown}; release is v${VERSION}."
  echo "    dist/ was not rebuilt after the version bump. Run pnpm build and retry."
  exit 1
fi
echo "  ✓ Zip re-packaged (v${VERSION}, $(stat -c%s accessbridge-extension.zip 2>/dev/null || wc -c < accessbridge-extension.zip) bytes)."

# Also sync to deploy/downloads for the local landing-page preview
cp -f accessbridge-extension.zip deploy/downloads/accessbridge-extension.zip

# ─────────────────────────────────────────────────────────
# [2/6] Push to GitHub
# ─────────────────────────────────────────────────────────
if [ "$SKIP_PUSH" = false ]; then
  echo "[2/6] Pushing to GitHub..."
  # --follow-tags pushes annotated tags reachable from HEAD so the v* tag
  # written by scripts/bump-version.sh lands alongside the release commit.
  git push --follow-tags origin "$BRANCH"
  echo "  ✓ Pushed to origin/$BRANCH (with tags)."
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

sync_via_scp() {
  # Idempotent fallback: zip via scp, deploy/ via tar-over-ssh.
  # In-place extract over $WWW_DIR — overwrites matching files but won't
  # remove stale ones (no --delete semantic). Safe for landing-page content.
  scp -q accessbridge-extension.zip "$REMOTE:$REMOTE_DIR/docs/downloads/"
  echo "  ✓ Extension zip synced (${VERSION})."

  ssh "$REMOTE" "mkdir -p '$WWW_DIR'"
  tar -C deploy -czf - . | ssh "$REMOTE" "tar -xzf - -C '$WWW_DIR'"
  echo "  ✓ Landing page synced (in-place, no delete)."
}

RSYNC_OK=false
if command -v rsync >/dev/null 2>&1; then
  # rsync IS installed but may fail at runtime on Windows Git Bash
  # ("dup() in/out/err failed"). We try it, catch runtime failure, and
  # fall through to the scp+tar path. See RCA BUG-011.
  if rsync -az --no-progress accessbridge-extension.zip \
       "$REMOTE:$REMOTE_DIR/docs/downloads/" 2>/dev/null \
     && rsync -az --delete deploy/ "$REMOTE:$WWW_DIR/" 2>/dev/null; then
    echo "  ✓ Extension zip synced (${VERSION})."
    echo "  ✓ Landing page synced."
    RSYNC_OK=true
  else
    echo "  ⚠ rsync failed at runtime — falling back to scp + tar-over-ssh."
  fi
fi

if [ "$RSYNC_OK" = false ]; then
  if ! command -v rsync >/dev/null 2>&1; then
    echo "  ℹ rsync not found — using scp + tar-over-ssh."
  fi
  sync_via_scp
fi

# Ship CHANGELOG.md + API main.py + restart API — all in one SSH session
# so we pay one handshake instead of three. On Windows Git Bash where
# ControlMaster multiplex fails, each avoided handshake saves ~1-2s.
BATCH_FILES=()
[ -f CHANGELOG.md ] && BATCH_FILES+=("CHANGELOG.md")
[ -f scripts/vps/main.py ] && BATCH_FILES+=("scripts/vps/main.py")

if [ "${#BATCH_FILES[@]}" -gt 0 ]; then
  # Stage into a tempdir with the final relative layout, then tar-over-ssh
  # in one pipe. The remote side extracts to the correct destinations and
  # restarts the API container if main.py changed.
  STAGE=$(mktemp -d)
  trap "rm -rf '$STAGE'" EXIT
  mkdir -p "$STAGE/docs" "$STAGE/api"
  [ -f CHANGELOG.md ] && cp CHANGELOG.md "$STAGE/docs/CHANGELOG.md"
  [ -f scripts/vps/main.py ] && cp scripts/vps/main.py "$STAGE/api/main.py"

  tar -C "$STAGE" -czf - . | ssh "$REMOTE" "
    set -euo pipefail
    tar -xzf - -C '$REMOTE_DIR'
    if [ -f '$REMOTE_DIR/api/main.py' ]; then
      docker restart accessbridge-api > /dev/null
    fi
  "
  [ -f CHANGELOG.md ] && echo "  ✓ CHANGELOG.md synced."
  if [ -f scripts/vps/main.py ]; then
    echo "  ✓ API main.py synced — accessbridge-api restarted."
  fi
fi

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
# [5/6] Post-deploy health check (API + end-to-end zip)
# ─────────────────────────────────────────────────────────
# Two assertions:
#   (a) /api/version reports $VERSION (catches main.py cache / restart issues)
#   (b) the publicly-served /downloads/accessbridge-extension.zip actually
#       contains manifest.version == $VERSION (catches rsync no-op, Caddy
#       cache staleness, or any future CDN layer serving an old artifact —
#       i.e. the "stale zip on download page" scenario)
if [ "$SKIP_CHECK" = false ]; then
  echo "[5/6] Health check against $HEALTH_URL ..."
  sleep 2
  if RESPONSE=$(curl -fsS --max-time 10 "$HEALTH_URL" 2>&1); then
    if echo "$RESPONSE" | grep -q "$VERSION"; then
      echo "  ✓ API reports v${VERSION}."
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

  # Derive the served-zip URL from $HEALTH_URL so overrides stay consistent:
  # https://host/api/version → https://host/downloads/accessbridge-extension.zip
  ZIP_URL="${HEALTH_URL%/api/version}/downloads/accessbridge-extension.zip"
  TMP_ZIP=$(mktemp --suffix=.zip)
  trap 'rm -f "$TMP_ZIP"' EXIT
  echo "  Verifying served zip at $ZIP_URL ..."
  if ! curl -fsS --max-time 30 -H "Cache-Control: no-cache" -o "$TMP_ZIP" "$ZIP_URL"; then
    echo "  ✗ Failed to download served zip."
    exit 1
  fi
  if ! SERVED_MANIFEST=$(unzip -p "$TMP_ZIP" manifest.json 2>/dev/null); then
    echo "  ✗ Served artifact is not a valid zip with manifest.json."
    exit 1
  fi
  SERVED_VERSION=$(node -p "JSON.parse(process.argv[1]).version" "$SERVED_MANIFEST" 2>/dev/null || echo "")
  if [ "$SERVED_VERSION" = "$VERSION" ]; then
    echo "  ✓ Served zip contains manifest.version=${SERVED_VERSION}."
  else
    echo "  ✗ Served zip version mismatch."
    echo "    Expected: $VERSION"
    echo "    Got:      ${SERVED_VERSION:-<unparseable>}"
    echo "  Likely cause: rsync no-op, Caddy cache, or CDN serving stale artifact."
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
