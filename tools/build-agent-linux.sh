#!/usr/bin/env bash
# Build Linux agent packages (.deb + .rpm + AppImage) and publish to the
# downloads tree. Requires running on a Linux host with Rust, Cargo,
# tauri-cli, and the appropriate libdev packages installed:
#
#   Debian/Ubuntu:
#     libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev at-spi2-core
#   Fedora/RHEL:
#     webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel at-spi2-core-devel
#
# Also emits SHA-256 hashes and updates deploy/downloads/agent-manifest.json
# with the new Linux entries (merges into existing manifest if present).
#
# NOTE (Windows host): this script cannot be executed on Windows. The git
# executable bit must be set before running on Linux:
#   git update-index --chmod=+x tools/build-agent-linux.sh
# Or run: chmod +x tools/build-agent-linux.sh on the Linux build machine.
#
# Session 22 — Linux packaging (deb + rpm + AppImage).

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
AGENT_DIR="$REPO_ROOT/packages/desktop-agent"
CARGO_TOML="$AGENT_DIR/src-tauri/Cargo.toml"
OUT_DIR="$REPO_ROOT/deploy/downloads/linux"
MANIFEST="$REPO_ROOT/deploy/downloads/agent-manifest.json"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠  %s\033[0m\n' "$*"; }
err()  { printf '\033[31m✗  %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[32m✓  %s\033[0m\n' "$*"; }

# ── Fail fast if not Linux ────────────────────────────────────────────────────
bold "[0/5] Checking host platform"
if [[ "$(uname -s)" != "Linux" ]]; then
    err "This script must run on Linux. Detected: $(uname -s)"
    err "Cross-building Linux packages from macOS/Windows is not supported."
    err "Use the CI matrix in .github/workflows/agent-build.yml instead."
    exit 1
fi

# Distro detection (informational only; tauri handles the actual build)
if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_VERSION="${VERSION_ID:-unknown}"
else
    DISTRO_ID="unknown"
    DISTRO_VERSION="unknown"
fi
ok "Detected: $DISTRO_ID $DISTRO_VERSION"

# ── Parse version from Cargo.toml ────────────────────────────────────────────
bold "[1/5] Parsing version"
VERSION=$(grep -m1 '^version\s*=' "$CARGO_TOML" | sed 's/.*= *"\(.*\)"/\1/')
if [[ -z "${VERSION:-}" ]]; then
    err "Could not parse version from $CARGO_TOML"
    exit 1
fi
ok "Version: $VERSION"

mkdir -p "$OUT_DIR"

# ── Build ─────────────────────────────────────────────────────────────────────
bold "[2/5] Running tauri build for Linux targets (deb + rpm + appimage)..."
(
    cd "$AGENT_DIR"
    pnpm tauri build --target x86_64-unknown-linux-gnu
)

TAURI_OUT="$AGENT_DIR/src-tauri/target/release/bundle"

# ── Collect artifacts ─────────────────────────────────────────────────────────
bold "[3/5] Collecting artifacts..."
declare -A COLLECTED  # basename → destination path

for pattern in "deb/*.deb" "rpm/*.rpm" "appimage/*.AppImage"; do
    for f in "$TAURI_OUT"/$pattern; do
        [[ -f "$f" ]] || continue
        dest="$OUT_DIR/$(basename "$f")"
        cp "$f" "$dest"
        COLLECTED["$(basename "$f")"]="$dest"
        ok "Copied: $(basename "$f")"
    done
done

if [[ ${#COLLECTED[@]} -eq 0 ]]; then
    err "No artifacts found under $TAURI_OUT. Check tauri build output above."
    exit 1
fi

# ── Compute SHA-256 ───────────────────────────────────────────────────────────
bold "[4/5] Computing SHA-256..."
declare -A HASHES
for basename in "${!COLLECTED[@]}"; do
    hash=$(sha256sum "${COLLECTED[$basename]}" | awk '{print $1}')
    HASHES["$basename"]="$hash"
    info "  $basename  $hash"
done

# ── Update agent-manifest.json ────────────────────────────────────────────────
bold "[5/5] Updating $MANIFEST..."

if [[ ! -f "$MANIFEST" ]]; then
    cat > "$MANIFEST" <<EOF
{
  "version": "$VERSION",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "artifacts": {}
}
EOF
    ok "Created skeleton manifest."
fi

if ! command -v jq >/dev/null 2>&1; then
    warn "jq not installed — manifest not updated. Install jq and rerun."
else
    # Resolve filenames (first match of each type; there's normally only one)
    DEB_FILE=$(find "$OUT_DIR" -maxdepth 1 -name '*.deb' | sort | head -1)
    RPM_FILE=$(find "$OUT_DIR" -maxdepth 1 -name '*.rpm' | sort | head -1)
    IMG_FILE=$(find "$OUT_DIR" -maxdepth 1 -name '*.AppImage' | sort | head -1)

    DEB_BASE=$(basename "${DEB_FILE:-}")
    RPM_BASE=$(basename "${RPM_FILE:-}")
    IMG_BASE=$(basename "${IMG_FILE:-}")

    DEB_HASH="${HASHES[$DEB_BASE]:-}"
    RPM_HASH="${HASHES[$RPM_BASE]:-}"
    IMG_HASH="${HASHES[$IMG_BASE]:-}"

    TMP=$(mktemp)
    jq \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg deb_file "$DEB_BASE" \
      --arg deb_hash "$DEB_HASH" \
      --arg rpm_file "$RPM_BASE" \
      --arg rpm_hash "$RPM_HASH" \
      --arg appimage_file "$IMG_BASE" \
      --arg appimage_hash "$IMG_HASH" \
      '.updatedAt = $ts
       | .artifacts["linux-x86_64"] = {
           "deb":      { "file": (if $deb_file      != "" then $deb_file      else null end), "sha256": (if $deb_hash      != "" then $deb_hash      else null end) },
           "rpm":      { "file": (if $rpm_file      != "" then $rpm_file      else null end), "sha256": (if $rpm_hash      != "" then $rpm_hash      else null end) },
           "appimage": { "file": (if $appimage_file != "" then $appimage_file else null end), "sha256": (if $appimage_hash != "" then $appimage_hash else null end) }
         }' \
      "$MANIFEST" > "$TMP"
    mv "$TMP" "$MANIFEST"
    ok "Manifest updated: $MANIFEST"
fi

echo ""
bold "Done. Linux artifacts at $OUT_DIR"
info "Sync to VPS via ./deploy.sh (--with-agent-linux flag coming in next session)"
