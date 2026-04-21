#!/usr/bin/env bash
# Orchestration wrapper: build the Desktop Agent for the current OS.
#
# On Windows: invokes build-agent-installer.sh → produces MSI.
# On macOS:   invokes build-agent-installer.sh → produces DMG + PKG.
# On Linux:   build-agent-installer.sh emits a warning and exits 0 (no-op).
#
# Cross-building (Windows installer from macOS or vice-versa) is NOT
# supported locally — it requires the CI matrix in:
#   .github/workflows/agent-build.yml
#
# Tip: run ./deploy.sh --with-agent-all-platforms to invoke this automatically
#      before the VPS sync step.
#
# Session 21 Part 4 — cross-platform bundle config.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER_SCRIPT="$SCRIPT_DIR/build-agent-installer.sh"

if [ ! -f "$INSTALLER_SCRIPT" ]; then
  printf '\033[31m✗  %s\033[0m\n' "build-agent-installer.sh not found at $INSTALLER_SCRIPT" >&2
  exit 1
fi

printf '\033[1m%s\033[0m\n' "=== AccessBridge Desktop Agent — local platform build ==="
printf '\033[33m%s\033[0m\n' \
  "Cross-building requires CI matrix; see .github/workflows/agent-build.yml." \
  "Local dev only builds for the current OS."
echo ""

bash "$INSTALLER_SCRIPT"
