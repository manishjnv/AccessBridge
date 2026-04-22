#!/usr/bin/env bash
# =============================================================================
# AccessBridge Team-tier Universal Installer — macOS + Linux dispatcher
#
# Author  : Manish Kumar
# Project : AccessBridge v0.25.0
# Session : 24 — Team-tier installer
# Updated : 2026-04-21
#
# USAGE (local checkout):
#   bash deploy/team/install.sh [--help] [--profile=NAME] [--dry-run] ...
#
# USAGE (curl | bash):
#   curl -fsSL https://accessbridge.space/team/install.sh \
#     | bash -s -- --profile=pilot-tamil --dry-run
#
# On Windows Git Bash: exits 1 with instructions to run install.ps1 instead.
#
# SHA-256 MANIFEST:
#   When placeholders are present the script uses LOCAL files from the same
#   directory as this script (git checkout or unpacked tarball).
#   Replace placeholders with real hex hashes for signed release builds.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# SHA-256 manifest — replace PLACEHOLDER_* before publishing a signed release
# ---------------------------------------------------------------------------
declare -A EXPECTED_SHA256=(
  [install-macos.sh]="PLACEHOLDER_MACOS_SHA256"
  [install-linux.sh]="PLACEHOLDER_LINUX_SHA256"
)

ACCESSBRIDGE_VERSION="0.25.0"
BASE_URL="https://accessbridge.space/team"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
_cyan()  { printf '\033[0;36m%s\033[0m\n' "$*"; }
_green() { printf '\033[0;32m%s\033[0m\n' "$*"; }

die() { _red "ERROR: $*" >&2; exit 1; }

print_help() {
  cat <<'HELP'
AccessBridge Team Installer — Universal Bash Dispatcher v0.25.0
Author: Manish Kumar

USAGE
  bash deploy/team/install.sh [OPTIONS]
  curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- [OPTIONS]

OPTIONS
  --profile=NAME          Preset profile name (must exist in deploy/team/profiles/)
                          Default: pilot-default
  --observatory=VALUE     opt-in | off   Enable anonymous observatory metrics
                          Default: off
  --agent=VALUE           yes | no       Install desktop agent
                          Default: no
  --log-level=VALUE       quiet | normal | verbose
                          Default: normal
  --pilot-id=STRING       Pilot cohort identifier baked into the profile
  --dry-run               Print what would happen; write nothing
  --help                  Show this help and exit

EXIT CODES
  0   success
  1   generic error / unsupported OS
  2   Chrome not found
  3   download / integrity failure
  4   admin rights needed

EXAMPLES
  bash deploy/team/install.sh --profile=pilot-dyslexia --dry-run --log-level=verbose
  bash deploy/team/install.sh --profile=pilot-tamil --observatory=opt-in --agent=yes
HELP
}

# ---------------------------------------------------------------------------
# Detect OS
# ---------------------------------------------------------------------------
detect_os() {
  local kernel
  kernel="$(uname -s 2>/dev/null || true)"
  case "$kernel" in
    Darwin)              echo "macos" ;;
    Linux)               echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "gitbash" ;;
    *)                   echo "unknown:$kernel" ;;
  esac
}

# ---------------------------------------------------------------------------
# SHA-256 verification
# ---------------------------------------------------------------------------
sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "No sha256sum or shasum found — cannot verify integrity."
  fi
}

is_placeholder() {
  local val="$1"
  [[ "$val" == PLACEHOLDER_* ]]
}

# ---------------------------------------------------------------------------
# Resolve OS-specific script: local first, then download + verify
# ---------------------------------------------------------------------------
resolve_script() {
  local script_name="$1"
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local local_path="${script_dir}/${script_name}"
  local expected_hash="${EXPECTED_SHA256[$script_name]:-}"

  if is_placeholder "$expected_hash"; then
    # Manifest not populated — use local file if available
    if [[ -f "$local_path" ]]; then
      _cyan "INFO: SHA-256 manifest not populated; using local file: $local_path"
      echo "$local_path"
      return 0
    else
      die "SHA-256 manifest not populated and local file not found: $local_path
Clone the repo and run deploy/team/install.sh directly, or populate the SHA-256 manifest."
    fi
  fi

  # Populated manifest: prefer local file if hash matches; else download
  if [[ -f "$local_path" ]]; then
    local actual_hash
    actual_hash="$(sha256_file "$local_path")"
    if [[ "${actual_hash,,}" == "${expected_hash,,}" ]]; then
      _cyan "INFO: Verified local ${script_name} (SHA-256 OK)"
      echo "$local_path"
      return 0
    else
      _cyan "INFO: Local ${script_name} hash mismatch — will download fresh copy."
    fi
  fi

  # Download to a tempdir
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
  local tmp_file="${tmp_dir}/${script_name}"
  local url="${BASE_URL}/${script_name}?v=${ACCESSBRIDGE_VERSION}"

  _cyan "INFO: Downloading ${script_name} from ${url}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 -o "$tmp_file" "$url" \
      || die "curl download failed: $url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$tmp_file" "$url" \
      || die "wget download failed: $url"
  else
    die "Neither curl nor wget found — cannot download installer."
  fi

  # Verify integrity
  local actual_hash
  actual_hash="$(sha256_file "$tmp_file")"
  if [[ "${actual_hash,,}" != "${expected_hash,,}" ]]; then
    die "SHA-256 integrity check FAILED for ${script_name}
  Expected : ${expected_hash}
  Got      : ${actual_hash}
Aborting — the downloaded file may have been tampered with."
  fi
  _green "INFO: SHA-256 verified for ${script_name}"

  # Make executable and hand back path (trap will clean up on exit)
  chmod +x "$tmp_file"
  echo "$tmp_file"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  # Show help when no args passed
  if [[ $# -eq 0 ]]; then
    print_help
    exit 0
  fi

  # Honour --help anywhere in args
  for arg in "$@"; do
    if [[ "$arg" == "--help" || "$arg" == "-h" ]]; then
      print_help
      exit 0
    fi
  done

  local os
  os="$(detect_os)"

  case "$os" in
    gitbash)
      _red "Detected Git Bash on Windows."
      _red "Please run install.ps1 instead:"
      _red "  pwsh -File deploy/team/install.ps1 [OPTIONS]"
      exit 1
      ;;
    unknown:*)
      die "Unrecognised OS kernel '${os#unknown:}'. Supported: macOS, Linux."
      ;;
    macos)
      local script
      script="$(resolve_script "install-macos.sh")"
      bash "$script" "$@"
      ;;
    linux)
      local script
      script="$(resolve_script "install-linux.sh")"
      bash "$script" "$@"
      ;;
  esac
}

main "$@"
