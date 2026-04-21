#!/bin/bash
# AccessBridge VPS Deployment Script
#
# Usage: ./deploy.sh [flags]
#   --skip-build  reuse existing dist/ without verification
#   --skip-push   don't push to GitHub
#   --skip-tests  skip tests (honored only when tree clean AND HEAD cached as passing)
#   --skip-bump   don't auto-bump version from conventional commits
#   --no-check    skip post-deploy health check
#   --no-cache    bypass all build-cache shortcuts — rebuild, retest from scratch.
#                 Use when you don't trust the cache or are debugging a suspected
#                 cache-related issue. Equivalent to the old stateless pipeline.
#   --with-agent  also build the Desktop Agent MSI (via tools/build-agent-installer.sh)
#                 and stage it into deploy/downloads/ before the VPS sync step.
#                 Requires Rust + MSVC + WiX toolchain; safe to omit when not shipping
#                 a new agent build — the existing MSI in deploy/downloads/ is synced.
#   --with-agent-all-platforms  Session 21 Part 4: run tools/build-agent-all-platforms.sh
#                      before the VPS sync step. Builds the agent for the CURRENT OS only
#                      (Windows → MSI, macOS → DMG+PKG). Cross-platform builds require
#                      the CI matrix in .github/workflows/agent-build.yml. Safe to omit
#                      when no new agent release is being shipped — the existing artifacts
#                      in deploy/downloads/ are still synced.
#   --with-enterprise  Session 20: package deploy/enterprise/ into admx-bundle.zip
#                      alongside the existing ADMX/ADML/mobileconfig/JSON template files.
#                      The landing page Enterprise section links to the zip for admins
#                      who want one download, and to individual files for surgical deploys.
#                      Safe to omit when enterprise templates haven't changed — the
#                      existing bundle + templates in deploy/enterprise/ still sync.
#
# Pipeline: bump → typecheck+build+test → re-zip → push → sync → VPS-verify → health
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
NO_CACHE=false
WITH_AGENT=0
WITH_AGENT_ALL_PLATFORMS=0
WITH_ENTERPRISE=0

for arg in "$@"; do
  case "$arg" in
    --skip-build)      SKIP_BUILD=true     ;;
    --skip-push)       SKIP_PUSH=true      ;;
    --skip-tests)      SKIP_TESTS=true     ;;
    --no-check)        SKIP_CHECK=true     ;;
    --skip-bump)       SKIP_BUMP=true      ;;
    --no-cache)        NO_CACHE=true       ;;  # restore the old stateless pipeline
    --with-agent)               WITH_AGENT=1               ;;
    --with-agent-all-platforms) WITH_AGENT_ALL_PLATFORMS=1 ;;  # Session 21 Part 4: cross-platform agent build
    --with-enterprise)          WITH_ENTERPRISE=1          ;;  # Session 20: zip ADMX bundle + sync enterprise templates
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
DIST_DIR="packages/extension/dist"
echo "=== AccessBridge Deploy v${VERSION} ==="

# ─────────────────────────────────────────────────────────
# [1/6] typecheck + build + test (parallel)
# ─────────────────────────────────────────────────────────
# typecheck: ALWAYS runs — fast, catches a different class of bugs than vitest
# test: smart skip — --skip-tests only honored if HEAD matches last-tested and tree clean
# build: smart skip — if source+config inputs hash unchanged AND dist/ has a
#        matching manifest.version, reuse the existing dist/. Full rebuild
#        cost is ~15s; this cache hits on every re-deploy that didn't touch
#        package source (docs-only, deploy-script-only, re-run after a
#        transient failure). Save ~15s per hit.
# Tier 3 #9 — parallelized; Tier 2 #5 — errors no longer swallowed

LAST_TESTED_FILE="/tmp/accessbridge-last-tested.sha"
LAST_BUILD_FILE="/tmp/accessbridge-last-build.sha256"
CURRENT_HEAD=$(git rev-parse HEAD)
DIRTY=$(git status --porcelain)
LAST_TESTED=$(cat "$LAST_TESTED_FILE" 2>/dev/null || echo "")

SHOULD_RUN_TESTS=true
if [ "$NO_CACHE" = true ]; then
  :  # --no-cache forces tests to run; fall through
elif [ "$SKIP_TESTS" = true ]; then
  if [ -n "$DIRTY" ]; then
    echo "  ⚠ --skip-tests requested but working tree is dirty — running tests anyway."
  elif [ "$LAST_TESTED" = "$CURRENT_HEAD" ]; then
    SHOULD_RUN_TESTS=false
  else
    echo "  ⚠ --skip-tests requested but no cached pass for $CURRENT_HEAD — running tests."
  fi
fi

# Build-cache hash — two halves:
#
#   INPUT_HASH  = sha256 of source files, configs, lockfile
#   OUTPUT_HASH = sha256 of dist/** after successful build
#
# We store both, and a cache-hit requires BOTH to match current state.
# Why both: if a cache entry only verified inputs, a corrupted or
# partially-deleted dist/ could still look like a cache hit, shipping
# stale code. The output check is a cryptographic proof that dist/ is
# byte-identical to the known-good build. ~200ms overhead, closes the
# statelessness hole we'd otherwise have.
#
# INPUT_HASH deliberately EXCLUDES manifest.json and package.json —
# auto-bump rewrites those on every deploy, but Vite copies manifest.json
# to dist/ unchanged and package.json doesn't affect bundle contents.
# On cache hit we `cp` the new manifest into dist/ so [1.5] sees the
# correct version.
compute_input_hash() {
  find \
    packages/core/src \
    packages/ai-engine/src \
    packages/extension/src \
    packages/extension/vite.config.ts \
    packages/extension/tsconfig.json \
    packages/core/tsconfig.json \
    packages/ai-engine/tsconfig.json \
    tsconfig.base.json \
    pnpm-lock.yaml \
    -type f 2>/dev/null \
  | sort \
  | xargs sha256sum 2>/dev/null \
  | sha256sum \
  | cut -d' ' -f1
}

compute_output_hash() {
  # dist/ file count is ~30; hashing takes <200ms.
  [ -d "$DIST_DIR" ] || return 1
  ( cd "$DIST_DIR" \
    && find . -type f 2>/dev/null \
    | sort \
    | xargs sha256sum 2>/dev/null \
    | sha256sum \
    | cut -d' ' -f1 )
}

BUILD_INPUTS_HASH=$(compute_input_hash)
# Last-build file now stores two fields, space-separated: <input> <output>
STORED_IN=""
STORED_OUT=""
if [ -f "$LAST_BUILD_FILE" ]; then
  read -r STORED_IN STORED_OUT < "$LAST_BUILD_FILE" || true
fi

SHOULD_RUN_BUILD=true
CACHE_SKIP_REASON=""

if [ "$NO_CACHE" = true ]; then
  CACHE_SKIP_REASON="--no-cache: bypassing build cache"
elif [ "$SKIP_BUILD" = true ]; then
  SHOULD_RUN_BUILD=false
  CACHE_SKIP_REASON="--skip-build: reusing dist/ unverified"
elif [ -z "$BUILD_INPUTS_HASH" ]; then
  CACHE_SKIP_REASON="no input hash (find/sha256sum missing?) — rebuilding"
elif [ ! -f "$DIST_DIR/src/content/index.js" ] || [ ! -f "$DIST_DIR/manifest.json" ]; then
  CACHE_SKIP_REASON="dist/ incomplete — rebuilding"
elif [ "$BUILD_INPUTS_HASH" != "$STORED_IN" ]; then
  CACHE_SKIP_REASON="inputs changed (src/config/deps)"
else
  # Inputs match. Verify the output is still intact — guards against
  # corruption, partial deletes, antivirus quarantine, or any post-build
  # tampering the input-hash alone couldn't see.
  CURRENT_OUT=$(compute_output_hash 2>/dev/null || echo "")
  if [ -z "$CURRENT_OUT" ]; then
    CACHE_SKIP_REASON="failed to hash dist/ — rebuilding"
  elif [ "$CURRENT_OUT" != "$STORED_OUT" ]; then
    CACHE_SKIP_REASON="dist/ contents diverged from last known-good — rebuilding"
  else
    SHOULD_RUN_BUILD=false
    CACHE_SKIP_REASON="inputs+outputs match last build (${BUILD_INPUTS_HASH:0:7}/${CURRENT_OUT:0:7})"
    # Patch the freshly-bumped manifest into dist so [1.5] sees the new
    # version. Safe because manifest.json contents aren't consumed by any
    # built JS (popup reads chrome.runtime.getManifest().version at runtime).
    cp -f packages/extension/manifest.json "$DIST_DIR/manifest.json"
  fi
fi

echo "[1/6] typecheck + build + test (parallel)..."
PIDS=()
LABELS=()

( pnpm typecheck ) > /tmp/accessbridge-typecheck.log 2>&1 &
PIDS+=($!); LABELS+=("typecheck")

if [ "$SHOULD_RUN_BUILD" = true ]; then
  [ -n "$CACHE_SKIP_REASON" ] && echo "  ℹ build cache: $CACHE_SKIP_REASON"
  ( pnpm build ) > /tmp/accessbridge-build.log 2>&1 &
  PIDS+=($!); LABELS+=("build")
else
  echo "  ✓ build skipped — $CACHE_SKIP_REASON"
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

# Record successful build so the next invocation can skip it when both
# inputs AND outputs are unchanged. Only write on an actual build run.
# Two-field format: "<input_hash> <output_hash>" (single space separator).
if [ "$SHOULD_RUN_BUILD" = true ] && [ -n "$BUILD_INPUTS_HASH" ]; then
  FRESH_OUTPUT_HASH=$(compute_output_hash 2>/dev/null || echo "")
  if [ -n "$FRESH_OUTPUT_HASH" ]; then
    echo "$BUILD_INPUTS_HASH $FRESH_OUTPUT_HASH" > "$LAST_BUILD_FILE"
  fi
fi

# ─────────────────────────────────────────────────────────
# [1.5/6] Re-zip dist/ — guarantees zip manifest matches
# the freshly-bumped version. Runs even on --skip-build so
# that a manual dist/ edit or a post-bump no-op build still
# results in a version-consistent zip.
# See RCA BUG-011.
# ─────────────────────────────────────────────────────────
echo "[1.5/6] Re-packaging extension zip from dist/ ..."
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
# [1.6/6] (optional) Build Desktop Agent MSI  — only with --with-agent
# ─────────────────────────────────────────────────────────
if [ "${WITH_AGENT}" = "1" ]; then
  echo "[1.6/6] Building desktop-agent MSI (--with-agent)..."
  _AGENT_SCRIPT="$(pwd)/tools/build-agent-installer.sh"
  if [ ! -f "$_AGENT_SCRIPT" ]; then
    echo "  ✗ tools/build-agent-installer.sh not found — skipping agent build"
  elif bash "$_AGENT_SCRIPT"; then
    echo "  ✓ agent MSI built and staged into deploy/downloads/"
  else
    echo "  ⚠ agent MSI build failed — deploy continues without updated MSI"
  fi
else
  echo "[1.6/6] Skipping desktop-agent MSI build (pass --with-agent to enable)"
fi

# ─────────────────────────────────────────────────────────
# [1.6b/6] (optional) Build Desktop Agent for ALL platforms (current OS only)
#           — only with --with-agent-all-platforms
# Delegates to tools/build-agent-all-platforms.sh which internally calls
# build-agent-installer.sh with platform detection. Prints a note that
# cross-building requires the CI matrix in .github/workflows/agent-build.yml.
# ─────────────────────────────────────────────────────────
if [ "${WITH_AGENT_ALL_PLATFORMS}" = "1" ]; then
  echo "[1.6b/6] Building desktop-agent for current platform (--with-agent-all-platforms)..."
  _ALL_PLATFORMS_SCRIPT="$(pwd)/tools/build-agent-all-platforms.sh"
  if [ ! -f "$_ALL_PLATFORMS_SCRIPT" ]; then
    echo "  ✗ tools/build-agent-all-platforms.sh not found — skipping"
  elif bash "$_ALL_PLATFORMS_SCRIPT"; then
    echo "  ✓ agent bundle built and staged into deploy/downloads/"
  else
    echo "  ⚠ agent bundle build failed — deploy continues without updated agent artifacts"
  fi
else
  echo "[1.6b/6] Skipping cross-platform agent build (pass --with-agent-all-platforms to enable)"
fi

# ─────────────────────────────────────────────────────────
# [1.7/6] (optional) Package enterprise ADMX/ADML/mobileconfig bundle — only with --with-enterprise
# Session 20: zips every file under deploy/enterprise/ into
# deploy/enterprise/admx-bundle.zip so the landing page Enterprise section
# can link one download for Windows GP admins. The individual files
# (mobileconfig, chrome-policy.json, etc.) remain individually linkable.
# ─────────────────────────────────────────────────────────
if [ "${WITH_ENTERPRISE}" = "1" ]; then
  echo "[1.7/6] Packaging enterprise deployment bundle (--with-enterprise)..."
  ENTERPRISE_DIR="deploy/enterprise"
  if [ ! -d "$ENTERPRISE_DIR" ]; then
    echo "  ✗ $ENTERPRISE_DIR not found — skipping enterprise bundle"
  else
    # Remove stale bundle so size diffs are visible post-build
    rm -f "$ENTERPRISE_DIR/admx-bundle.zip"
    if command -v zip >/dev/null 2>&1; then
      (cd "$ENTERPRISE_DIR" && zip -rq admx-bundle.zip \
        admx/ chrome-extension/ README.md -x "admx-bundle.zip")
    else
      # Windows Git Bash without zip — fall back to PowerShell Compress-Archive
      powershell -NoProfile -Command \
        "Compress-Archive -Path '$ENTERPRISE_DIR\\admx\\','$ENTERPRISE_DIR\\chrome-extension\\','$ENTERPRISE_DIR\\README.md' -DestinationPath '$ENTERPRISE_DIR\\admx-bundle.zip' -Force" \
        >/dev/null
    fi
    if [ -f "$ENTERPRISE_DIR/admx-bundle.zip" ]; then
      ADMX_SIZE=$(stat -c%s "$ENTERPRISE_DIR/admx-bundle.zip" 2>/dev/null || wc -c < "$ENTERPRISE_DIR/admx-bundle.zip")
      echo "  ✓ admx-bundle.zip packaged (${ADMX_SIZE} bytes)"
    else
      echo "  ⚠ admx-bundle.zip packaging failed — individual files still ship via rsync"
    fi
  fi
else
  echo "[1.7/6] Skipping enterprise bundle (pass --with-enterprise to enable)"
fi

# ─────────────────────────────────────────────────────────
# [2/6] Push to GitHub
# ─────────────────────────────────────────────────────────
if [ "$SKIP_PUSH" = false ]; then
  echo "[2/6] Pushing to GitHub..."
  # --follow-tags pushes annotated tags reachable from HEAD so the v* tag
  # written by scripts/bump-version.sh lands alongside the release commit.
  # --no-verify skips the husky pre-push hook; this pipeline already ran
  # typecheck + build + test at step [1/6], and re-running them via the
  # pre-push hook doubles ~20s of redundant work. For manual pushes
  # (outside deploy.sh) the pre-push hook still fires normally.
  git push --follow-tags --no-verify origin "$BRANCH"
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

upload_zip() {
  # Try rsync, fall through to scp on runtime failure (Windows Git Bash).
  if command -v rsync >/dev/null 2>&1 \
    && rsync -az --no-progress accessbridge-extension.zip \
         "$REMOTE:$REMOTE_DIR/docs/downloads/" 2>/dev/null; then
    return 0
  fi
  scp -q accessbridge-extension.zip "$REMOTE:$REMOTE_DIR/docs/downloads/"
}

upload_landing() {
  # In-place extract over $WWW_DIR. Scp fallback overwrites but won't
  # --delete, which is safe — landing page rarely removes files.
  if command -v rsync >/dev/null 2>&1 \
    && rsync -az --delete deploy/ "$REMOTE:$WWW_DIR/" 2>/dev/null; then
    return 0
  fi
  ssh "$REMOTE" "mkdir -p '$WWW_DIR'"
  tar -C deploy -czf - . | ssh "$REMOTE" "tar -xzf - -C '$WWW_DIR'"
}

# Zip upload — compare local vs remote SHA to skip a no-op transfer.
# The SHA probe is one SSH handshake (~1s) but saves ~3-5s on re-deploys
# where only docs/script/infra files changed and dist/ was rebuilt to the
# same version (identical artifact).
LOCAL_ZIP_SHA=$(sha256sum accessbridge-extension.zip | cut -d' ' -f1)
REMOTE_ZIP_SHA=$(ssh "$REMOTE" "sha256sum '$REMOTE_DIR/docs/downloads/accessbridge-extension.zip' 2>/dev/null | cut -d' ' -f1" 2>/dev/null || echo "")

if [ -n "$LOCAL_ZIP_SHA" ] && [ "$LOCAL_ZIP_SHA" = "$REMOTE_ZIP_SHA" ]; then
  echo "  ✓ Zip unchanged (${LOCAL_ZIP_SHA:0:7}) — skipping upload."
else
  upload_zip
  echo "  ✓ Extension zip synced (${VERSION}, ${LOCAL_ZIP_SHA:0:7})."
fi

upload_landing
echo "  ✓ Landing page synced."

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
echo "[4/6] VPS git state + conditional install..."
ssh "$REMOTE" bash -s <<REMOTE_SCRIPT
  set -euo pipefail

  # $REMOTE_DIR has historically been an artifact-only directory (zip +
  # docs + main.py), not a git working tree. Running git commands against
  # it produces "fatal: not a git repository" and wastes the handshake.
  # Guard against it: only sync+install if a .git dir exists.
  if [ ! -d "$REMOTE_DIR/.git" ]; then
    echo "  ✓ $REMOTE_DIR is artifact-only — no git sync needed."
    exit 0
  fi

  cd "$REMOTE_DIR"
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

  # Active probe: retry every 300ms until the API reports $VERSION or we
  # give up after ~10s. Beats the old fixed `sleep 2` because the container
  # is typically ready <1s after `docker restart`, and a fixed sleep wastes
  # the difference. Also handles occasional slow restarts without flapping.
  RESPONSE=""
  for _ in $(seq 1 30); do
    if RESPONSE=$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null) \
      && echo "$RESPONSE" | grep -q "$VERSION"; then
      break
    fi
    RESPONSE=""
    sleep 0.3
  done

  if [ -n "$RESPONSE" ]; then
    echo "  ✓ API reports v${VERSION}."
  else
    # Final diagnostic probe so we show what we actually got
    LAST=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>&1 || echo "(no response)")
    echo "  ✗ API did not return v${VERSION} within 10s."
    echo "    Last response: $LAST"
    exit 1
  fi

  # Derive the served-zip URL from $HEALTH_URL + append ?v=$VERSION so we
  # hit the same cache key that production clients hit (per BUG-010: the
  # API returns a version-keyed download_url precisely so each release has
  # a distinct Cloudflare edge cache entry). Checking the non-versioned
  # URL would always see stale artifacts for up to 4h after a release —
  # which is the very failure mode BUG-010 was fixed to prevent.
  ZIP_URL="${HEALTH_URL%/api/version}/downloads/accessbridge-extension.zip?v=${VERSION}"
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
