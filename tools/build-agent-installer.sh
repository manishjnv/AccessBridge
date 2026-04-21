#!/usr/bin/env bash
# Build the AccessBridge Desktop Agent MSI installer and stage it for deploy.
#
# Requires Rust toolchain + MSVC Build Tools + WiX Toolset v4 installed.
# See packages/desktop-agent/README.md for toolchain setup.
#
# Session 19 — MVP.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$REPO_ROOT/packages/desktop-agent"
MSI_SRC_DIR="$AGENT_DIR/src-tauri/target/release/bundle/msi"
DEPLOY_DIR="$REPO_ROOT/deploy/downloads"
DEPLOY_MSI="$DEPLOY_DIR/accessbridge-desktop-agent.msi"
DEPLOY_HASH="$DEPLOY_DIR/accessbridge-desktop-agent.msi.sha256"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# ---- Toolchain check ----
bold "[1/4] Verifying Rust + MSVC + WiX toolchain"
command -v cargo >/dev/null 2>&1 || { err "cargo not found — install Rust via https://rustup.rs"; exit 1; }
command -v cl    >/dev/null 2>&1 || warn "MSVC cl not in PATH — Tauri will invoke it via Cargo's link.exe detection; proceed anyway"
command -v wix   >/dev/null 2>&1 || warn "WiX v4 not in PATH — Tauri bundler will try to download it; install via 'dotnet tool install --global wix' if this fails"

# ---- Build ----
bold "[2/4] Building desktop-agent MSI"
(
  cd "$AGENT_DIR"
  pnpm --filter @accessbridge/desktop-agent tauri build --target x86_64-pc-windows-msvc
)

# ---- Locate MSI output ----
bold "[3/4] Locating MSI"
msi=$(ls -t "$MSI_SRC_DIR"/*.msi 2>/dev/null | head -n 1 || true)
if [ -z "${msi:-}" ]; then
  err "No MSI produced — check Tauri build output above"
  exit 1
fi
info "Found: $msi"

# ---- Stage for deploy ----
bold "[4/4] Staging MSI + sha256 into deploy/downloads/"
mkdir -p "$DEPLOY_DIR"
cp -f "$msi" "$DEPLOY_MSI"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$DEPLOY_DIR" && sha256sum "$(basename "$DEPLOY_MSI")" > "$(basename "$DEPLOY_HASH")")
elif command -v shasum >/dev/null 2>&1; then
  (cd "$DEPLOY_DIR" && shasum -a 256 "$(basename "$DEPLOY_MSI")" > "$(basename "$DEPLOY_HASH")")
else
  warn "sha256sum / shasum not available — skipping hash file"
fi

info "MSI staged:   $DEPLOY_MSI"
info "Hash file:    $DEPLOY_HASH"
info "Size:         $(du -h "$DEPLOY_MSI" | cut -f1)"
info "Ready to deploy via ./deploy.sh (which rsyncs deploy/ to VPS)."
