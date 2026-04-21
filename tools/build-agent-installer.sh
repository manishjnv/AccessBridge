#!/usr/bin/env bash
# Build the AccessBridge Desktop Agent installer and stage it for deploy.
#
# Detects host platform and builds the appropriate Tauri bundle target(s):
#   Windows  → MSI  (x86_64-pc-windows-msvc)
#   macOS    → DMG + PKG + .app  (universal binary: x86_64 + aarch64)
#   Linux    → skipped with a warning (not yet supported)
#
# Output naming convention:
#   accessbridge-desktop-agent_<version>_<arch>.{msi,dmg,pkg}
#
# After build, copies artifacts into deploy/downloads/ and updates
# deploy/downloads/agent-manifest.json with SHA-256 hashes.
#
# Requires:
#   Windows — Rust/MSVC/WiX toolchain  (see packages/desktop-agent/README.md)
#   macOS   — Rust universal targets:
#               rustup target add x86_64-apple-darwin aarch64-apple-darwin
#
# Idempotent: re-running with the same version overwrites artifacts cleanly.
#
# Session 21 Part 4 — cross-platform bundle config.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$REPO_ROOT/packages/desktop-agent"
CARGO_TOML="$AGENT_DIR/src-tauri/Cargo.toml"
DEPLOY_DIR="$REPO_ROOT/deploy/downloads"
MANIFEST_JSON="$DEPLOY_DIR/agent-manifest.json"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠  %s\033[0m\n' "$*"; }
err()  { printf '\033[31m✗  %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[32m✓  %s\033[0m\n' "$*"; }

# ── Parse version from Cargo.toml ────────────────────────────────────────────
bold "[0] Parsing version from Cargo.toml"
VERSION=$(grep -m1 '^version\s*=' "$CARGO_TOML" | sed 's/.*= *"\(.*\)"/\1/')
if [ -z "${VERSION:-}" ]; then
  err "Could not parse version from $CARGO_TOML"
  exit 1
fi
ok "Version: $VERSION"

mkdir -p "$DEPLOY_DIR"

# ── Cross-platform SHA-256 shim ───────────────────────────────────────────────
# Returns the hex digest (no filename) of the given file.
sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    # Linux, WSL, Git Bash with GNU coreutils
    sha256sum "$file" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    # macOS (BSD shasum ships with Xcode CLT)
    shasum -a 256 "$file" | cut -d' ' -f1
  elif command -v certutil >/dev/null 2>&1; then
    # Windows native fallback (Git Bash without sha256sum)
    certutil -hashfile "$file" SHA256 \
      | grep -v '^CertUtil' | grep -v '^SHA256' \
      | tr -d '[:space:]'
  else
    warn "No SHA-256 utility found (sha256sum / shasum / certutil) — hash will be empty"
    echo ""
  fi
}

# ── ISO-8601 timestamp (portable) ────────────────────────────────────────────
iso_timestamp() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))"
  elif command -v date >/dev/null 2>&1; then
    date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ"
  else
    echo "unknown"
  fi
}

# ── Detect platform ───────────────────────────────────────────────────────────
OS="$(uname -s 2>/dev/null || echo "Windows")"
case "$OS" in
  Darwin)  PLATFORM="macos" ;;
  Linux)   PLATFORM="linux" ;;
  MINGW*|MSYS*|CYGWIN*|Windows*)  PLATFORM="windows" ;;
  *)       PLATFORM="unknown" ;;
esac
bold "[1] Platform detected: $PLATFORM"

# Manifest fields — populated per-platform below
WIN_FILE="null"
WIN_SHA="null"
MAC_DMG_FILE="null"
MAC_DMG_SHA="null"
MAC_PKG_FILE="null"
MAC_PKG_SHA="null"
LINUX_STATUS='"not-yet-supported"'

# ── Windows build ─────────────────────────────────────────────────────────────
if [ "$PLATFORM" = "windows" ]; then
  bold "[2] Verifying Windows toolchain"
  command -v cargo >/dev/null 2>&1 || { err "cargo not found — install Rust: https://rustup.rs"; exit 1; }
  command -v cl >/dev/null 2>&1 \
    || warn "MSVC cl not in PATH — Tauri will discover it via Cargo link.exe detection; proceeding"
  command -v wix >/dev/null 2>&1 \
    || warn "WiX v4 not in PATH — Tauri bundler will attempt to download it; install with: dotnet tool install --global wix"

  bold "[3] Building Desktop Agent MSI"
  (
    cd "$AGENT_DIR"
    pnpm --filter @accessbridge/desktop-agent tauri build --target x86_64-pc-windows-msvc
  )

  bold "[4] Locating MSI output"
  MSI_SRC_DIR="$AGENT_DIR/src-tauri/target/release/bundle/msi"
  msi_raw=$(ls -t "$MSI_SRC_DIR"/*.msi 2>/dev/null | head -n 1 || true)
  if [ -z "${msi_raw:-}" ]; then
    err "No MSI produced — review Tauri build output above"
    exit 1
  fi
  info "Found: $msi_raw"

  ARCH="x86_64"
  WIN_DEST_FILE="accessbridge-desktop-agent_${VERSION}_${ARCH}.msi"
  cp -f "$msi_raw" "$DEPLOY_DIR/$WIN_DEST_FILE"
  WIN_HASH=$(sha256_of "$DEPLOY_DIR/$WIN_DEST_FILE")
  WIN_FILE="\"$WIN_DEST_FILE\""
  WIN_SHA="\"$WIN_HASH\""
  ok "MSI staged: $DEPLOY_DIR/$WIN_DEST_FILE"
  [ -n "$WIN_HASH" ] && ok "SHA-256: $WIN_HASH"

# ── macOS build ───────────────────────────────────────────────────────────────
elif [ "$PLATFORM" = "macos" ]; then
  bold "[2] Verifying macOS toolchain"
  command -v cargo >/dev/null 2>&1 || { err "cargo not found — install Rust: https://rustup.rs"; exit 1; }

  # Ensure both Apple Silicon and Intel targets are present
  if ! rustup target list --installed 2>/dev/null | grep -q "aarch64-apple-darwin"; then
    warn "aarch64-apple-darwin target missing — adding via rustup"
    rustup target add aarch64-apple-darwin
  fi
  if ! rustup target list --installed 2>/dev/null | grep -q "x86_64-apple-darwin"; then
    warn "x86_64-apple-darwin target missing — adding via rustup"
    rustup target add x86_64-apple-darwin
  fi

  bold "[3] Building Desktop Agent universal macOS bundle (DMG + PKG + .app)"
  (
    cd "$AGENT_DIR"
    pnpm --filter @accessbridge/desktop-agent tauri build --target universal-apple-darwin
  )

  bold "[4] Locating macOS bundle outputs"
  MAC_BASE="$AGENT_DIR/src-tauri/target/universal-apple-darwin/release/bundle"

  # DMG
  dmg_raw=$(ls -t "$MAC_BASE/dmg"/*.dmg 2>/dev/null | head -n 1 || true)
  if [ -n "${dmg_raw:-}" ]; then
    MAC_DMG_DEST="accessbridge-desktop-agent_${VERSION}_universal.dmg"
    cp -f "$dmg_raw" "$DEPLOY_DIR/$MAC_DMG_DEST"
    MAC_DMG_HASH=$(sha256_of "$DEPLOY_DIR/$MAC_DMG_DEST")
    MAC_DMG_FILE="\"$MAC_DMG_DEST\""
    MAC_DMG_SHA="\"$MAC_DMG_HASH\""
    ok "DMG staged: $DEPLOY_DIR/$MAC_DMG_DEST"
    [ -n "$MAC_DMG_HASH" ] && ok "SHA-256 (DMG): $MAC_DMG_HASH"
  else
    warn "No DMG produced — Tauri may require --bundles dmg explicitly on this system"
  fi

  # PKG
  pkg_raw=$(ls -t "$MAC_BASE/pkg"/*.pkg 2>/dev/null | head -n 1 || true)
  if [ -n "${pkg_raw:-}" ]; then
    MAC_PKG_DEST="accessbridge-desktop-agent_${VERSION}_universal.pkg"
    cp -f "$pkg_raw" "$DEPLOY_DIR/$MAC_PKG_DEST"
    MAC_PKG_HASH=$(sha256_of "$DEPLOY_DIR/$MAC_PKG_DEST")
    MAC_PKG_FILE="\"$MAC_PKG_DEST\""
    MAC_PKG_SHA="\"$MAC_PKG_HASH\""
    ok "PKG staged: $DEPLOY_DIR/$MAC_PKG_DEST"
    [ -n "$MAC_PKG_HASH" ] && ok "SHA-256 (PKG): $MAC_PKG_HASH"
  else
    warn "No PKG produced — Tauri may require --bundles pkg explicitly on this system"
  fi

  if [ "$MAC_DMG_FILE" = "null" ] && [ "$MAC_PKG_FILE" = "null" ]; then
    err "Neither DMG nor PKG was produced. Check Tauri build output above."
    exit 1
  fi

# ── Linux placeholder ─────────────────────────────────────────────────────────
elif [ "$PLATFORM" = "linux" ]; then
  warn "Linux agent build not implemented yet; use Windows MSI or macOS PKG."
  warn "Skipping agent bundle step — deploy/downloads/ unchanged."

else
  err "Unrecognised platform: $OS. Supported: macOS, Windows (Git Bash / MSYS2 / WSL), Linux (no-op)."
  exit 1
fi

# ── Write agent-manifest.json ─────────────────────────────────────────────────
bold "[5] Updating $MANIFEST_JSON"
TIMESTAMP=$(iso_timestamp)

cat > "$MANIFEST_JSON" <<EOF
{
  "version": "$VERSION",
  "artifacts": {
    "windows-x86_64": {
      "file": $WIN_FILE,
      "sha256": $WIN_SHA
    },
    "macos-universal": {
      "file": $MAC_DMG_FILE,
      "sha256": $MAC_DMG_SHA
    },
    "macos-universal-pkg": {
      "file": $MAC_PKG_FILE,
      "sha256": $MAC_PKG_SHA
    },
    "linux-x86_64": {
      "file": null,
      "sha256": null,
      "status": $LINUX_STATUS
    }
  },
  "updatedAt": "$TIMESTAMP"
}
EOF

ok "agent-manifest.json written (v${VERSION}, ${TIMESTAMP})"
info "Artifacts are in $DEPLOY_DIR — sync to VPS via ./deploy.sh"
