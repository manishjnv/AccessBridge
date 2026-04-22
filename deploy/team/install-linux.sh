#!/usr/bin/env bash
# =============================================================================
# AccessBridge v0.22.0 — Linux Team Installer
# Author : Manish Kumar
# Purpose: Install the AccessBridge Chrome extension (and optional desktop
#          agent) on Linux workstations managed by IT/team leads.
#
# Usage:
#   bash install-linux.sh [OPTIONS]
#
# Options:
#   --profile=<name>       Profile name (must exist in deploy/team/profiles/)
#   --observatory=yes|no   Enable Observatory telemetry (default: yes)
#   --agent=yes|no         Install Tauri desktop agent (default: no)
#   --log-level=verbose|info|warn|error  (default: info)
#   --pilot-id=<id>        Pilot cohort identifier (optional)
#   --dry-run              Print plan and exit 0 without making changes
#   --help                 Show this help and exit 0
#
# Exit codes:
#   0  success
#   1  generic error
#   2  Chrome/Chromium not found
#   3  download failed
#   4  sudo required but unavailable
#   5  unsupported distro (reserved; AppImage fallback used instead)
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
readonly VERSION="0.22.0"
readonly EXTENSION_ID="abcdefghijklmnopqrstuvwxyzabcdef"  # REPLACE BEFORE PRODUCTION DEPLOY
readonly UPDATE_URL="https://accessbridge.space/chrome/updates.xml"

readonly EXT_ZIP_URL="https://accessbridge.space/downloads/accessbridge-extension.zip?v=${VERSION}"
readonly AGENT_DEB_URL="https://accessbridge.space/downloads/linux/accessbridge-desktop-agent_${VERSION}_amd64.deb?v=${VERSION}"
readonly AGENT_RPM_URL="https://accessbridge.space/downloads/linux/accessbridge-desktop-agent-${VERSION}-1.x86_64.rpm?v=${VERSION}"
readonly AGENT_APPIMAGE_URL="https://accessbridge.space/downloads/linux/accessbridge-desktop-agent-${VERSION}-x86_64.AppImage?v=${VERSION}"

# SHA-256 placeholders — replace with real hashes before production deploy.
# The installer emits a warning (not a failure) when a placeholder is detected.
readonly SHA256_EXT_ZIP="0000000000000000000000000000000000000000000000000000000000000000"
readonly SHA256_AGENT_DEB="0000000000000000000000000000000000000000000000000000000000000000"
readonly SHA256_AGENT_RPM="0000000000000000000000000000000000000000000000000000000000000000"
readonly SHA256_AGENT_APPIMAGE="0000000000000000000000000000000000000000000000000000000000000000"

# Repo root used for profile validation (resolved relative to this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROFILES_DIR="${SCRIPT_DIR}/profiles"

# XDG-compliant paths
readonly CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
readonly STATE_HOME="${XDG_STATE_HOME:-${HOME}/.local/state}"
readonly PROFILE_FILE="${CONFIG_HOME}/accessbridge/default-profile.json"
readonly LOG_DIR="${STATE_HOME}/accessbridge/logs"
readonly LOG_FILE="${LOG_DIR}/install-$(date +%Y%m%d%H%M%S).log"

# ---------------------------------------------------------------------------
# Argument defaults
# ---------------------------------------------------------------------------
ARG_PROFILE=""
ARG_OBSERVATORY="yes"
ARG_AGENT="no"
ARG_LOG_LEVEL="info"
ARG_PILOT_ID=""
ARG_DRY_RUN=false

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
# _log_raw writes to stdout AND the log file (appended after log dir is made).
# We buffer early messages in _EARLY_LOG and flush once the log dir exists.
_EARLY_LOG=""

_log_raw() {
  local line="$1"
  if [[ -d "${LOG_DIR}" ]]; then
    printf '%s\n' "${line}" | tee -a "${LOG_FILE}"
  else
    _EARLY_LOG+="${line}"$'\n'
    printf '%s\n' "${line}"
  fi
}

_flush_early_log() {
  mkdir -p "${LOG_DIR}"
  if [[ -n "${_EARLY_LOG}" ]]; then
    printf '%s' "${_EARLY_LOG}" >> "${LOG_FILE}"
    _EARLY_LOG=""
  fi
}

info()    { _log_raw "[INFO]  $*"; }
warn()    { _log_raw "[WARN]  $*" >&2; true; }
verbose() { [[ "${ARG_LOG_LEVEL}" == "verbose" ]] && _log_raw "[DEBUG] $*" || true; }
error()   { _log_raw "[ERROR] $*" >&2; }

die() {
  local code="${1}"; shift
  error "$*"
  exit "${code}"
}

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
AccessBridge v${VERSION} — Linux Team Installer
Author: Manish Kumar

Usage: bash install-linux.sh [OPTIONS]

Options:
  --profile=<name>              Profile slug matching deploy/team/profiles/<name>.json
  --observatory=yes|no          Enable Observatory telemetry (default: yes)
  --agent=yes|no                Install Tauri desktop agent (default: no)
  --log-level=verbose|info|warn|error
  --pilot-id=<id>               Pilot cohort ID (optional, alphanumeric)
  --dry-run                     Print plan, exit 0, make no changes
  --help                        Show this help

Exit codes:
  0  success         3  download failed
  1  generic error   4  sudo required but unavailable
  2  Chrome not found
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
parse_args() {
  for arg in "$@"; do
    case "${arg}" in
      --help)                    usage; exit 0 ;;
      --dry-run)                 ARG_DRY_RUN=true ;;
      --profile=*)               ARG_PROFILE="${arg#*=}" ;;
      --observatory=*)           ARG_OBSERVATORY="${arg#*=}" ;;
      --agent=*)                 ARG_AGENT="${arg#*=}" ;;
      --log-level=*)             ARG_LOG_LEVEL="${arg#*=}" ;;
      --pilot-id=*)              ARG_PILOT_ID="${arg#*=}" ;;
      *) die 1 "Unknown argument: ${arg}. Use --help for usage." ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------
validate_args() {
  # --profile: must be ^[a-z0-9-]+$ AND profiles/<name>.json must exist
  if [[ -n "${ARG_PROFILE}" ]]; then
    if ! [[ "${ARG_PROFILE}" =~ ^[a-z0-9-]+$ ]]; then
      die 1 "--profile value '${ARG_PROFILE}' is invalid. Only lowercase letters, digits, and hyphens are allowed."
    fi
    local profile_path="${PROFILES_DIR}/${ARG_PROFILE}.json"
    if [[ ! -f "${profile_path}" ]]; then
      die 1 "Profile '${ARG_PROFILE}' not found at ${profile_path}."
    fi
  fi

  case "${ARG_OBSERVATORY}" in yes|no) ;; *)
    die 1 "--observatory must be 'yes' or 'no'." ;;
  esac

  case "${ARG_AGENT}" in yes|no) ;; *)
    die 1 "--agent must be 'yes' or 'no'." ;;
  esac

  case "${ARG_LOG_LEVEL}" in verbose|info|warn|error) ;; *)
    die 1 "--log-level must be one of: verbose, info, warn, error." ;;
  esac
}

# ---------------------------------------------------------------------------
# Distro detection
# ---------------------------------------------------------------------------
# Returns: sets DISTRO_ID, DISTRO_VERSION_ID, DISTRO_FAMILY
detect_distro() {
  DISTRO_ID=""
  DISTRO_VERSION_ID=""
  DISTRO_FAMILY="unknown"

  if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    DISTRO_ID="${ID:-}"
    DISTRO_VERSION_ID="${VERSION_ID:-}"
  else
    warn "/etc/os-release not found — treating as unknown distro."
    return
  fi

  case "${DISTRO_ID}" in
    ubuntu|debian|linuxmint|pop|elementary|zorin|kali)
      DISTRO_FAMILY="debian" ;;
    fedora|rhel|centos|rocky|almalinux|ol)
      DISTRO_FAMILY="rpm" ;;
    opensuse*|sles)
      DISTRO_FAMILY="zypper" ;;
    arch|manjaro|endeavouros|garuda)
      DISTRO_FAMILY="arch" ;;
    *)
      DISTRO_FAMILY="unknown" ;;
  esac

  verbose "Detected distro: ${DISTRO_ID} ${DISTRO_VERSION_ID} (family: ${DISTRO_FAMILY})"
}

# ---------------------------------------------------------------------------
# Chrome/Chromium detection
# ---------------------------------------------------------------------------
detect_chrome() {
  CHROME_BIN=""
  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      CHROME_BIN="$(command -v "${candidate}")"
      verbose "Found Chrome binary: ${CHROME_BIN}"
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# sudo availability
# ---------------------------------------------------------------------------
have_sudo() {
  sudo -n true 2>/dev/null
}

require_sudo() {
  if ! have_sudo; then
    die 4 "This step requires sudo privileges. Re-run with sudo or add your user to the sudoers file."
  fi
}

# ---------------------------------------------------------------------------
# Symlink safety check (BUG-018)
# ---------------------------------------------------------------------------
# Usage: symlink_safe <path>
# Checks both the path itself and its parent directory for symlinks.
symlink_safe() {
  local p="${1}"
  local parent
  parent="$(dirname "${p}")"
  if [[ -L "${p}" || -L "${parent}" ]]; then
    die 1 "Refusing to touch symlink: ${p} (or its parent ${parent} is a symlink)."
  fi
}

# ---------------------------------------------------------------------------
# Download helper
# ---------------------------------------------------------------------------
# Usage: download_file <url> <dest> <expected_sha256>
download_file() {
  local url="${1}"
  local dest="${2}"
  local expected_sha="${3}"

  verbose "Downloading ${url} -> ${dest}"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 120 -o "${dest}" "${url}" \
      || die 3 "Download failed: ${url}"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=120 -O "${dest}" "${url}" \
      || die 3 "Download failed: ${url}"
  else
    die 3 "Neither curl nor wget found. Cannot download artifacts."
  fi

  # SHA-256 verification
  local actual_sha
  actual_sha="$(sha256sum "${dest}" | awk '{print $1}')"
  verbose "SHA-256: expected=${expected_sha}, actual=${actual_sha}"

  local placeholder_re='^0+$'
  if [[ "${expected_sha}" =~ ${placeholder_re} ]]; then
    warn "SHA-256 placeholder detected for ${dest}. Skipping checksum verification."
    warn "Set real hash constants in this script before production deployment."
  elif [[ "${actual_sha}" != "${expected_sha}" ]]; then
    rm -f "${dest}"
    die 3 "SHA-256 mismatch for ${dest}. Expected: ${expected_sha}. Got: ${actual_sha}."
  else
    verbose "SHA-256 verified OK for ${dest}."
  fi
}

# ---------------------------------------------------------------------------
# Chrome Extension policy — per-user
# ---------------------------------------------------------------------------
install_ext_per_user() {
  local ext_dir="${CONFIG_HOME}/google-chrome/External Extensions"
  local ext_file="${ext_dir}/${EXTENSION_ID}.json"

  symlink_safe "${ext_file}"
  symlink_safe "${ext_dir}"

  if [[ "${ARG_DRY_RUN}" == true ]]; then
    info "[DRY-RUN] Would write per-user external extension JSON:"
    info "  ${ext_file}"
    return
  fi

  mkdir -p "${ext_dir}"
  umask 077
  printf '{\n  "external_update_url": "%s"\n}\n' "${UPDATE_URL}" \
    | install -m 600 /dev/stdin "${ext_file}"

  info "Per-user extension policy written: ${ext_file}"
}

# ---------------------------------------------------------------------------
# Chrome Extension policy — system-wide
# ---------------------------------------------------------------------------
install_ext_system() {
  local policy_dir="/etc/opt/chrome/policies/managed"
  local policy_file="${policy_dir}/accessbridge.json"

  symlink_safe "${policy_file}"
  symlink_safe "${policy_dir}"

  if [[ "${ARG_DRY_RUN}" == true ]]; then
    info "[DRY-RUN] Would write system-wide Chrome policy (requires sudo):"
    info "  ${policy_file}"
    return
  fi

  require_sudo
  sudo mkdir -p "${policy_dir}"
  # Write to a temp file owned by root, then move atomically
  local tmp_policy
  tmp_policy="$(mktemp)"
  printf '{\n  "ExtensionInstallForcelist": [\n    "%s;%s"\n  ]\n}\n' \
    "${EXTENSION_ID}" "${UPDATE_URL}" > "${tmp_policy}"
  sudo install -m 644 "${tmp_policy}" "${policy_file}"
  rm -f "${tmp_policy}"

  info "System-wide Chrome policy written: ${policy_file}"
}

# ---------------------------------------------------------------------------
# Default profile (XDG-compliant, BUG-017/019 mode-on-creation)
# ---------------------------------------------------------------------------
write_default_profile() {
  local profile_name="${ARG_PROFILE:-default}"

  symlink_safe "${PROFILE_FILE}"
  symlink_safe "$(dirname "${PROFILE_FILE}")"

  if [[ "${ARG_DRY_RUN}" == true ]]; then
    info "[DRY-RUN] Would write default profile (mode 600):"
    info "  ${PROFILE_FILE}"
    return
  fi

  mkdir -p "$(dirname "${PROFILE_FILE}")"

  umask 077
  printf '{\n  "profile": "%s",\n  "observatory": %s,\n  "pilotId": "%s",\n  "version": "%s",\n  "installedAt": "%s"\n}\n' \
    "${profile_name}" \
    "$( [[ "${ARG_OBSERVATORY}" == "yes" ]] && echo "true" || echo "false" )" \
    "${ARG_PILOT_ID}" \
    "${VERSION}" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    | install -m 600 /dev/stdin "${PROFILE_FILE}"

  info "Default profile written (mode 600): ${PROFILE_FILE}"
}

# ---------------------------------------------------------------------------
# Agent installation helpers
# ---------------------------------------------------------------------------
install_agent_deb() {
  local tmp_dir="${1}"
  local deb_file="${tmp_dir}/accessbridge-desktop-agent_${VERSION}_amd64.deb"

  symlink_safe "${deb_file}"
  symlink_safe "${tmp_dir}"

  if [[ "${ARG_DRY_RUN}" == true ]]; then
    info "[DRY-RUN] Would download and install .deb agent package:"
    info "  URL: ${AGENT_DEB_URL}"
    info "  sudo dpkg -i ${deb_file}"
    info "  sudo apt-get install -f -y"
    return
  fi

  require_sudo
  download_file "${AGENT_DEB_URL}" "${deb_file}" "${SHA256_AGENT_DEB}"
  sudo dpkg -i "${deb_file}" || true  # dpkg -i may exit non-zero on dep issues
  sudo apt-get install -f -y          # resolve any missing deps (never pipe-exec)
  info "Desktop agent installed via .deb."
}

install_agent_rpm_dnf() {
  local tmp_dir="${1}"
  local rpm_file="${tmp_dir}/accessbridge-desktop-agent-${VERSION}-1.x86_64.rpm"

  symlink_safe "${rpm_file}"
  symlink_safe "${tmp_dir}"

  if [[ "${ARG_DRY_RUN}" == true ]]; then
    info "[DRY-RUN] Would download and install .rpm agent package via dnf:"
    info "  URL: ${AGENT_RPM_URL}"
    info "  sudo dnf install -y ${rpm_file}"
    return
  fi

  require_sudo
  download_file "${AGENT_RPM_URL}" "${rpm_file}" "${SHA256_AGENT_RPM}"
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y "${rpm_file}"
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y "${rpm_file}"
  else
    die 1 "Neither dnf nor yum found on this RPM-based system."
  fi
  info "Desktop agent installed via .rpm (dnf/yum)."
}

install_agent_rpm_zypper() {
  local tmp_dir="${1}"
  local rpm_file="${tmp_dir}/accessbridge-desktop-agent-${VERSION}-1.x86_64.rpm"

  symlink_safe "${rpm_file}"
  symlink_safe "${tmp_dir}"

  if [[ "${ARG_DRY_RUN}" == true ]]; then
    info "[DRY-RUN] Would download and install .rpm agent package via zypper:"
    info "  URL: ${AGENT_RPM_URL}"
    info "  sudo zypper install --no-confirm ${rpm_file}"
    return
  fi

  require_sudo
  download_file "${AGENT_RPM_URL}" "${rpm_file}" "${SHA256_AGENT_RPM}"
  sudo zypper install --no-confirm "${rpm_file}"
  info "Desktop agent installed via .rpm (zypper)."
}

install_agent_appimage() {
  local tmp_dir="${1}"
  local appimage_src="${tmp_dir}/accessbridge-desktop-agent-${VERSION}-x86_64.AppImage"
  local appimage_dest="${CONFIG_HOME}/accessbridge/accessbridge-agent.AppImage"

  symlink_safe "${appimage_src}"
  symlink_safe "${tmp_dir}"

  if [[ "${ARG_DRY_RUN}" == true ]]; then
    info "[DRY-RUN] Would download AppImage and install to:"
    info "  ${appimage_dest}"
    return
  fi

  download_file "${AGENT_APPIMAGE_URL}" "${appimage_src}" "${SHA256_AGENT_APPIMAGE}"

  local dest_dir
  dest_dir="$(dirname "${appimage_dest}")"
  symlink_safe "${appimage_dest}"
  symlink_safe "${dest_dir}"

  mkdir -p "${dest_dir}"
  install -m 755 "${appimage_src}" "${appimage_dest}"
  info "Desktop agent AppImage installed: ${appimage_dest}"

  # Create a minimal XDG .desktop entry so the agent is launchable
  local desktop_dir="${HOME}/.local/share/applications"
  local desktop_file="${desktop_dir}/accessbridge-agent.desktop"
  mkdir -p "${desktop_dir}"
  printf '[Desktop Entry]\nName=AccessBridge Agent\nExec=%s\nType=Application\nCategories=Utility;Accessibility;\nComment=AccessBridge desktop accessibility agent v%s\n' \
    "${appimage_dest}" "${VERSION}" \
    > "${desktop_file}"
  verbose "XDG desktop entry written: ${desktop_file}"
}

# ---------------------------------------------------------------------------
# systemd user service activation
# ---------------------------------------------------------------------------
# The service file is shipped by the .deb/.rpm package at:
#   /usr/lib/systemd/user/accessbridge.service
# We only enable+start it here; we do NOT install the service file.
activate_systemd_service() {
  if [[ "${ARG_DRY_RUN}" == true ]]; then
    info "[DRY-RUN] Would activate systemd user service:"
    info "  systemctl --user daemon-reload"
    info "  systemctl --user enable --now accessbridge.service"
    return
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found — skipping service activation (non-systemd system)."
    return
  fi

  if ! systemctl --user daemon-reload 2>/dev/null; then
    warn "systemctl --user daemon-reload failed (no user bus?). Skipping service activation."
    return
  fi

  if systemctl --user enable --now accessbridge.service 2>/dev/null; then
    info "systemd user service enabled and started: accessbridge.service"
  else
    warn "Could not enable/start accessbridge.service — service file may not yet be installed."
    warn "Run 'systemctl --user enable --now accessbridge.service' after confirming package install."
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  parse_args "$@"
  validate_args

  # Set up log directory now (early messages were buffered above)
  _flush_early_log

  info "============================================================"
  info " AccessBridge v${VERSION} — Linux Team Installer"
  info " Author : Manish Kumar"
  info " Date   : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  info " Log    : ${LOG_FILE}"
  info "============================================================"
  info "Options:"
  info "  profile      = ${ARG_PROFILE:-<none>}"
  info "  observatory  = ${ARG_OBSERVATORY}"
  info "  agent        = ${ARG_AGENT}"
  info "  log-level    = ${ARG_LOG_LEVEL}"
  info "  pilot-id     = ${ARG_PILOT_ID:-<none>}"
  info "  dry-run      = ${ARG_DRY_RUN}"

  # ── Step 1: Distro detection ─────────────────────────────────────────────
  info ""
  info "── Step 1/5: Distro detection ──────────────────────────────"
  detect_distro
  info "Distro: ${DISTRO_ID:-unknown} ${DISTRO_VERSION_ID:-} (family: ${DISTRO_FAMILY})"

  # ── Step 2: Chrome detection ─────────────────────────────────────────────
  info ""
  info "── Step 2/5: Chrome/Chromium detection ─────────────────────"
  if ! detect_chrome; then
    die 2 "Chrome or Chromium not found in PATH. Install Google Chrome or Chromium before running this installer."
  fi
  info "Found Chrome binary: ${CHROME_BIN}"

  # ── Step 3: Extension policy ─────────────────────────────────────────────
  info ""
  info "── Step 3/5: Chrome extension policy ───────────────────────"

  # Policy strategy:
  #   • Default:                    per-user (no sudo needed)
  #   • --agent=yes AND sudo avail: system-wide (IT-managed machines)
  local use_system_policy=false
  if [[ "${ARG_AGENT}" == "yes" ]] && have_sudo; then
    use_system_policy=true
  fi

  if [[ "${use_system_policy}" == true ]]; then
    info "Using system-wide Chrome policy (agent=yes, sudo available)."
    install_ext_system
  else
    info "Using per-user Chrome external extension JSON."
    install_ext_per_user
  fi

  # ── Step 4: Default profile ───────────────────────────────────────────────
  info ""
  info "── Step 4/5: Default profile ───────────────────────────────"
  write_default_profile

  # ── Step 5: Desktop agent (optional) ─────────────────────────────────────
  info ""
  info "── Step 5/5: Desktop agent ─────────────────────────────────"
  if [[ "${ARG_AGENT}" != "yes" ]]; then
    info "Skipping agent install (pass --agent=yes to enable)."
  else
    # Create a secure temp dir — removed on EXIT trap
    local tmp_dir
    tmp_dir="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "rm -rf '${tmp_dir}'" EXIT

    local agent_installed_via_package=false

    case "${DISTRO_FAMILY}" in
      debian)
        info "Installing .deb agent package (Debian/Ubuntu family)."
        install_agent_deb "${tmp_dir}"
        agent_installed_via_package=true
        ;;
      rpm)
        info "Installing .rpm agent package (Fedora/RHEL/CentOS family)."
        install_agent_rpm_dnf "${tmp_dir}"
        agent_installed_via_package=true
        ;;
      zypper)
        info "Installing .rpm agent package (openSUSE family)."
        install_agent_rpm_zypper "${tmp_dir}"
        agent_installed_via_package=true
        ;;
      arch)
        info "Arch/Manjaro detected — no native package available. Falling back to AppImage."
        install_agent_appimage "${tmp_dir}"
        ;;
      unknown|*)
        info "Unknown distro — falling back to AppImage."
        install_agent_appimage "${tmp_dir}"
        ;;
    esac

    # Activate systemd user service when installed via .deb/.rpm
    # (AppImage installations self-contain their own launch mechanism)
    if [[ "${agent_installed_via_package}" == true ]]; then
      activate_systemd_service
    fi
  fi

  # ── Summary ───────────────────────────────────────────────────────────────
  info ""
  info "============================================================"
  if [[ "${ARG_DRY_RUN}" == true ]]; then
    info " DRY-RUN complete — no changes were made."
  else
    info " Installation complete!"
  fi
  info ""
  info " Extension ID : ${EXTENSION_ID}"
  info " Update URL   : ${UPDATE_URL}"
  info " Profile file : ${PROFILE_FILE}"
  info " Log file     : ${LOG_FILE}"
  info ""
  info " Next step: Open Chrome and visit chrome://policy to verify"
  info " ExtensionInstallForcelist or chrome://extensions for the"
  info " loaded extension."
  info "============================================================"
}

main "$@"
