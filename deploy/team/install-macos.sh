#!/usr/bin/env bash
# =============================================================================
# AccessBridge v0.22.0 — macOS Team Installer
# Author : Manish Kumar
# Project: AccessBridge — Ambient Accessibility Middleware (A11yOS)
# Session: 24 (Team tier — scripted install for 10-1000 users)
#
# Usage:
#   bash install-macos.sh [OPTIONS]
#
# Options:
#   --profile=<name>           Profile name (default: pilot-default)
#                              Must exist in deploy/team/profiles/<name>.json
#   --observatory=<opt-in|off> Observatory analytics (default: off)
#   --agent=<yes|no>           Install desktop agent PKG (default: no)
#   --log-level=<quiet|normal|verbose>
#                              Logging verbosity (default: normal)
#   --pilot-id=<string>        Optional pilot cohort identifier
#   --dry-run                  Print plan without executing side-effects
#   --help                     Show this message and exit
#
# Exit codes:
#   0  Success
#   1  Generic error (bad args, symlink attack detected, validation failure)
#   2  Chrome not found
#   3  Download failure
#   4  sudo required and unavailable (agent install only)
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants — edit these before production deployment
# ---------------------------------------------------------------------------

readonly VERSION="0.22.0"
readonly BUNDLE_ID="com.accessbridge.desktop"
readonly APP_NAME="AccessBridge Desktop Agent"

# Chrome Extension Web Store ID — set to the real 32-char lowercase ID once
# the extension is published on the Chrome Web Store.  While this remains the
# placeholder string the installer falls back to the external update URL path.
readonly EXTENSION_ID="placeholder-extension-id"

readonly EXTENSION_UPDATE_URL="https://accessbridge.space/chrome/updates.xml"

# Agent PKG download URL — cache-busted per BUG-010
readonly AGENT_PKG_URL="https://accessbridge.space/downloads/accessbridge-desktop-agent_${VERSION}_universal.pkg?v=${VERSION}"
readonly AGENT_PKG_TMP="/tmp/accessbridge-desktop-agent.pkg"

# Expected SHA-256 of the agent PKG.
# Set to the real hex digest once CI publishes it; PLACEHOLDER triggers a
# warning but does NOT abort the install so that pre-release pilots can test.
readonly AGENT_PKG_SHA256="PLACEHOLDER"

# App bundle binary path produced by Tauri CI macOS target.
# TODO: The Tauri bundle target key is "pkg"/"app" and Tauri names the
# binary after `productName` from tauri.conf.json with spaces replaced by
# hyphens.  For productName "AccessBridge Desktop Agent" Tauri produces
# "AccessBridge Desktop Agent.app" — the main binary inside the bundle is
# named after the `identifier` binary component "accessbridge-desktop-agent".
# Adjust this constant if the CI renames the binary (e.g. via a
# tauri.conf.json `bundle.macOS.binaries` override).
readonly AGENT_BINARY="/Applications/AccessBridge Desktop Agent.app/Contents/MacOS/accessbridge-desktop-agent"

readonly LAUNCHAGENT_PLIST_LABEL="space.accessbridge.agent"
readonly LAUNCHAGENT_PLIST_PATH="${HOME}/Library/LaunchAgents/${LAUNCHAGENT_PLIST_LABEL}.plist"

readonly LOG_DIR="${HOME}/Library/Logs/AccessBridge"
readonly LOG_FILE="${LOG_DIR}/install-$(date +%Y%m%d%H%M%S).log"

readonly PROFILE_DIR_REL="profiles"  # relative to script's own directory (deploy/team/profiles/)
readonly DEFAULT_PROFILE_NAME="pilot-default"

readonly CHROME_POLICY_DIR="${HOME}/Library/Application Support/Google/Chrome/External Extensions"
readonly ACCESSBRIDGE_CONFIG_DIR="${HOME}/Library/Application Support/AccessBridge"
readonly DEFAULT_PROFILE_JSON="${ACCESSBRIDGE_CONFIG_DIR}/default-profile.json"

# ---------------------------------------------------------------------------
# Defaults for CLI flags
# ---------------------------------------------------------------------------
OPT_PROFILE="${DEFAULT_PROFILE_NAME}"
OPT_OBSERVATORY="off"
OPT_AGENT="no"
OPT_LOG_LEVEL="normal"
OPT_PILOT_ID=""
OPT_DRY_RUN="false"

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------

# _log <level> <message>
# Levels: quiet=0, normal=1, verbose=2
_log_level_num() {
    case "$1" in
        quiet)   printf '0' ;;
        normal)  printf '1' ;;
        verbose) printf '2' ;;
        *)       printf '1' ;;
    esac
}

_log() {
    local level="$1"
    shift
    local msg="$*"
    local req_num
    req_num="$(_log_level_num "${level}")"
    local set_num
    set_num="$(_log_level_num "${OPT_LOG_LEVEL}")"

    if [[ "${set_num}" -ge "${req_num}" ]]; then
        printf '[%s] %s\n' "${level}" "${msg}" | tee -a "${LOG_FILE}"
    else
        printf '[%s] %s\n' "${level}" "${msg}" >> "${LOG_FILE}"
    fi
}

log_q()  { _log "quiet"   "$@"; }
log_n()  { _log "normal"  "$@"; }
log_v()  { _log "verbose" "$@"; }

log_err() {
    printf '[ERROR] %s\n' "$*" | tee -a "${LOG_FILE}" >&2
}

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
    grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed '1,3d'
    exit 0
}

# ---------------------------------------------------------------------------
# Argument parsing — manual while/case (GNU-long-style --key=value)
# ---------------------------------------------------------------------------
parse_args() {
    while [[ $# -gt 0 ]]; do
        local arg="$1"
        case "${arg}" in
            --help|-h)
                usage
                ;;
            --dry-run)
                OPT_DRY_RUN="true"
                ;;
            --profile=*)
                OPT_PROFILE="${arg#--profile=}"
                ;;
            --observatory=*)
                OPT_OBSERVATORY="${arg#--observatory=}"
                ;;
            --agent=*)
                OPT_AGENT="${arg#--agent=}"
                ;;
            --log-level=*)
                OPT_LOG_LEVEL="${arg#--log-level=}"
                ;;
            --pilot-id=*)
                OPT_PILOT_ID="${arg#--pilot-id=}"
                ;;
            *)
                log_err "Unknown option: ${arg}"
                exit 1
                ;;
        esac
        shift
    done
}

# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------
validate_args() {
    # --profile: must match ^[a-z0-9-]+$ (no path traversal)
    if [[ ! "${OPT_PROFILE}" =~ ^[a-z0-9-]+$ ]]; then
        log_err "--profile must match ^[a-z0-9-]+$ (got: '${OPT_PROFILE}')"
        exit 1
    fi

    # --observatory
    case "${OPT_OBSERVATORY}" in
        opt-in|off) ;;
        *)
            log_err "--observatory must be 'opt-in' or 'off' (got: '${OPT_OBSERVATORY}')"
            exit 1
            ;;
    esac

    # --agent
    case "${OPT_AGENT}" in
        yes|no) ;;
        *)
            log_err "--agent must be 'yes' or 'no' (got: '${OPT_AGENT}')"
            exit 1
            ;;
    esac

    # --log-level
    case "${OPT_LOG_LEVEL}" in
        quiet|normal|verbose) ;;
        *)
            log_err "--log-level must be 'quiet', 'normal', or 'verbose' (got: '${OPT_LOG_LEVEL}')"
            exit 1
            ;;
    esac

    # Resolve profile JSON path — relative to script directory to avoid CWD dependency
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local profile_json="${script_dir}/${PROFILE_DIR_REL}/${OPT_PROFILE}.json"

    if [[ ! -f "${profile_json}" ]]; then
        log_err "Profile not found: ${profile_json}"
        log_err "Available profiles: $(ls "${script_dir}/${PROFILE_DIR_REL}"/*.json 2>/dev/null | xargs -I{} basename {} .json | tr '\n' ' ' || printf '(none)')"
        exit 1
    fi

    # Expose for later use
    PROFILE_JSON_PATH="${profile_json}"
}

# ---------------------------------------------------------------------------
# Symlink-attack guard (RCA BUG-018)
# Check that $1 (a target file path) and each of its parent directories
# are not symlinks before writing.
# ---------------------------------------------------------------------------
guard_no_symlink() {
    local target="$1"
    local path="${target}"

    # Walk from the target up through each parent component
    while [[ "${path}" != "/" && "${path}" != "." ]]; do
        if [[ -L "${path}" ]]; then
            log_err "Refusing to write to symlink: potential symlink attack detected at: ${path}"
            exit 1
        fi
        path="$(dirname "${path}")"
    done
}

# ---------------------------------------------------------------------------
# Secure file write helper (RCA BUG-017/019: mode-on-creation via umask)
# Usage: secure_write <target_path> <content>
# Creates parent dirs if needed, then writes with umask 077 so the file
# is created 0600 from the first open() call — no chmod-after-write race.
# ---------------------------------------------------------------------------
secure_write() {
    local target="$1"
    local content="$2"

    guard_no_symlink "${target}"

    local parent_dir
    parent_dir="$(dirname "${target}")"

    # Guard parent dir itself (may already exist)
    guard_no_symlink "${parent_dir}"

    if [[ "${OPT_DRY_RUN}" == "true" ]]; then
        log_n "[dry-run] Would write to: ${target}"
        log_v "[dry-run] Content:\n${content}"
        return
    fi

    mkdir -p "${parent_dir}"

    # mode-on-creation: set umask 077 in subshell so only this write is affected
    (
        umask 077
        printf '%s' "${content}" > "${target}"
    )
    log_v "Wrote (mode 0600 via umask 077): ${target}"
}

# ---------------------------------------------------------------------------
# SHA-256 verification
# Returns 0 if hash matches or expected is PLACEHOLDER (warning only).
# Returns 1 on mismatch.
# ---------------------------------------------------------------------------
verify_sha256() {
    local file="$1"
    local expected="$2"

    if [[ "${expected}" == "PLACEHOLDER" ]]; then
        log_q "WARNING: AGENT_PKG_SHA256 is PLACEHOLDER — skipping integrity check."
        log_q "         Set AGENT_PKG_SHA256 in the script to the real digest before production use."
        return 0
    fi

    local actual
    actual="$(shasum -a 256 "${file}" | awk '{print $1}')"

    if [[ "${actual}" != "${expected}" ]]; then
        log_err "SHA-256 mismatch for ${file}"
        log_err "  Expected: ${expected}"
        log_err "  Got:      ${actual}"
        return 1
    fi

    log_v "SHA-256 verified: ${actual}"
    return 0
}

# ---------------------------------------------------------------------------
# macOS version / arch detection
# ---------------------------------------------------------------------------
detect_platform() {
    local macos_ver
    macos_ver="$(sw_vers -productVersion 2>/dev/null || printf 'unknown')"
    local arch
    arch="$(uname -m)"

    log_v "macOS version : ${macos_ver}"
    log_v "Architecture  : ${arch}"

    # macOS 11+ check (Big Sur = 11.x)
    local major
    major="${macos_ver%%.*}"
    if [[ "${major}" =~ ^[0-9]+$ ]] && [[ "${major}" -lt 11 ]]; then
        log_err "macOS ${macos_ver} is not supported. Minimum: macOS 11 (Big Sur)."
        exit 1
    fi

    # Universal PKG handles both Intel (x86_64) and Apple Silicon (arm64)
    # Just log so operators can confirm what ran where.
    case "${arch}" in
        x86_64)  log_v "Intel CPU detected; universal PKG will use x86_64 slice." ;;
        arm64)   log_v "Apple Silicon detected; universal PKG will use arm64 slice." ;;
        *)       log_n "Unrecognised architecture '${arch}'; proceeding anyway." ;;
    esac
}

# ---------------------------------------------------------------------------
# Chrome detection
# ---------------------------------------------------------------------------
detect_chrome() {
    if [[ -d "/Applications/Google Chrome.app" ]] || \
       [[ -d "${HOME}/Applications/Google Chrome.app" ]]; then
        log_v "Google Chrome found."
        return 0
    fi

    log_err "Google Chrome not found in /Applications or ~/Applications."
    log_err "Install Chrome from https://www.google.com/chrome/ and re-run."
    return 1
}

# ---------------------------------------------------------------------------
# Chrome per-user External Extensions policy
# No admin required; Chrome reads this path for the current user.
# Reference: https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux
#            (same JSON format applies on macOS for the per-user path)
# ---------------------------------------------------------------------------
install_chrome_policy() {
    log_n "Installing Chrome per-user extension policy…"

    local ext_json
    if [[ "${EXTENSION_ID}" == "placeholder-extension-id" ]]; then
        # Fallback: external_update_url form (no extension ID required)
        log_n "  NOTE: EXTENSION_ID is placeholder; using external_update_url form."
        ext_json='{"external_update_url":"'"${EXTENSION_UPDATE_URL}"'"}'
        # When extension ID is a placeholder we cannot create the per-ID policy
        # file; instead write a README noting the operator action required.
        local readme_path="${CHROME_POLICY_DIR}/README-AccessBridge.txt"
        if [[ "${OPT_DRY_RUN}" == "true" ]]; then
            log_n "[dry-run] Would create External Extensions dir: ${CHROME_POLICY_DIR}"
            log_n "[dry-run] Would write placeholder policy note: ${readme_path}"
            log_n "[dry-run] ext_json = ${ext_json}"
            return
        fi
        guard_no_symlink "${CHROME_POLICY_DIR}"
        mkdir -p "${CHROME_POLICY_DIR}"
        secure_write "${readme_path}" \
"AccessBridge Chrome Extension — Operator Action Required
=========================================================
EXTENSION_ID in install-macos.sh is still set to 'placeholder-extension-id'.

Once the extension is published to the Chrome Web Store:
  1. Edit install-macos.sh and set EXTENSION_ID to the real 32-char ID.
  2. Re-run install-macos.sh to write the correct policy JSON file.

Manual fallback:
  Create: ${CHROME_POLICY_DIR}/<real-extension-id>.json
  Content: ${ext_json}
"
        log_n "  Wrote operator action note to ${readme_path}"
        return
    fi

    # Real extension ID path
    local policy_file="${CHROME_POLICY_DIR}/${EXTENSION_ID}.json"
    ext_json='{"external_update_url":"'"${EXTENSION_UPDATE_URL}"'"}'

    log_v "  Policy file : ${policy_file}"
    log_v "  Content     : ${ext_json}"

    if [[ "${OPT_DRY_RUN}" == "true" ]]; then
        log_n "[dry-run] Would write Chrome policy: ${policy_file}"
        log_n "[dry-run] Content: ${ext_json}"
        return
    fi

    guard_no_symlink "${CHROME_POLICY_DIR}"
    mkdir -p "${CHROME_POLICY_DIR}"
    secure_write "${policy_file}" "${ext_json}"
    log_n "  Chrome extension policy installed: ${policy_file}"
    log_n "  Restart Chrome (or wait ~5 h) for the extension to appear."
}

# ---------------------------------------------------------------------------
# Default profile JSON
# ---------------------------------------------------------------------------
install_default_profile() {
    log_n "Writing default profile…"
    log_v "  Source profile: ${PROFILE_JSON_PATH}"
    log_v "  Destination   : ${DEFAULT_PROFILE_JSON}"

    local profile_content
    profile_content="$(cat "${PROFILE_JSON_PATH}")"

    # Inject observatory setting
    # We do a simple key injection rather than a full JSON parse so the script
    # has no external dependencies (no jq required).
    # If the profile already has "observatory" we warn and leave it as-is.
    if printf '%s' "${profile_content}" | grep -q '"observatory"'; then
        log_v "  Profile already contains 'observatory' key; not overriding."
    else
        # Insert before the final closing brace
        profile_content="${profile_content%\}}"
        profile_content="${profile_content},\"observatory\":\"${OPT_OBSERVATORY}\"}"
    fi

    # Inject pilot ID if provided
    if [[ -n "${OPT_PILOT_ID}" ]]; then
        if printf '%s' "${profile_content}" | grep -q '"pilotId"'; then
            log_v "  Profile already contains 'pilotId' key; not overriding."
        else
            profile_content="${profile_content%\}}"
            profile_content="${profile_content},\"pilotId\":\"${OPT_PILOT_ID}\"}"
        fi
    fi

    secure_write "${DEFAULT_PROFILE_JSON}" "${profile_content}"
    log_n "  Default profile written: ${DEFAULT_PROFILE_JSON}"
}

# ---------------------------------------------------------------------------
# Agent PKG download + install
# ---------------------------------------------------------------------------
install_agent() {
    log_n "Installing AccessBridge Desktop Agent (${VERSION})…"

    # Check non-interactive sudo availability
    if ! sudo -n true 2>/dev/null; then
        log_err "Agent install requires sudo but non-interactive sudo is not available."
        log_err "Run the following command manually, then re-run this script with --agent=no:"
        log_err ""
        log_err "  sudo installer -pkg /tmp/accessbridge-desktop-agent.pkg -target /"
        log_err ""
        log_err "Or grant passwordless sudo for /usr/sbin/installer to this user in sudoers."
        exit 4
    fi

    if [[ "${OPT_DRY_RUN}" == "true" ]]; then
        log_n "[dry-run] Would download: ${AGENT_PKG_URL}"
        log_n "[dry-run] Would verify SHA-256 against: ${AGENT_PKG_SHA256}"
        log_n "[dry-run] Would run: sudo installer -pkg ${AGENT_PKG_TMP} -target /"
        log_n "[dry-run] Would write launchd plist: ${LAUNCHAGENT_PLIST_PATH}"
        return
    fi

    # Download (BUG-010: URL already includes ?v= cache-bust)
    log_v "  Downloading: ${AGENT_PKG_URL}"
    if ! curl -fsSL -o "${AGENT_PKG_TMP}" "${AGENT_PKG_URL}"; then
        log_err "Failed to download agent PKG from: ${AGENT_PKG_URL}"
        exit 3
    fi
    log_v "  Downloaded to: ${AGENT_PKG_TMP}"

    # SHA-256 verification
    if ! verify_sha256 "${AGENT_PKG_TMP}" "${AGENT_PKG_SHA256}"; then
        log_err "Agent PKG integrity check failed; aborting install."
        rm -f "${AGENT_PKG_TMP}"
        exit 3
    fi

    # Install PKG (requires sudo — already checked above)
    log_v "  Running: sudo installer -pkg ${AGENT_PKG_TMP} -target /"
    sudo installer -pkg "${AGENT_PKG_TMP}" -target /
    log_n "  Agent PKG installed."

    # Clean up temp PKG
    rm -f "${AGENT_PKG_TMP}"
    log_v "  Removed temp file: ${AGENT_PKG_TMP}"

    install_launchagent
}

# ---------------------------------------------------------------------------
# launchd user agent plist (no sudo required — written to ~/Library/LaunchAgents)
# ---------------------------------------------------------------------------
install_launchagent() {
    log_n "Writing launchd user agent plist…"
    log_v "  Plist path  : ${LAUNCHAGENT_PLIST_PATH}"
    log_v "  Binary path : ${AGENT_BINARY}"

    # NOTE: The binary path is documented in the constant block above.
    # Verify post-install that the binary exists at this path.
    if [[ ! -x "${AGENT_BINARY}" ]]; then
        log_n "  WARNING: Agent binary not found at expected path: ${AGENT_BINARY}"
        log_n "           The launchd plist will still be written; launchctl will"
        log_n "           error on load if the path is wrong. Inspect the installed"
        log_n "           app bundle and update AGENT_BINARY in this script if needed."
    fi

    local plist_content
    plist_content='<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>'"${LAUNCHAGENT_PLIST_LABEL}"'</string>
    <key>ProgramArguments</key>
    <array>
        <string>'"${AGENT_BINARY}"'</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>'"${HOME}/Library/Logs/AccessBridge/agent-stdout.log"'</string>
    <key>StandardErrorPath</key>
    <string>'"${HOME}/Library/Logs/AccessBridge/agent-stderr.log"'</string>
</dict>
</plist>'

    secure_write "${LAUNCHAGENT_PLIST_PATH}" "${plist_content}"

    if [[ "${OPT_DRY_RUN}" != "true" ]]; then
        # Load immediately (harmless if already loaded; errors are non-fatal)
        if launchctl load "${LAUNCHAGENT_PLIST_PATH}" 2>/dev/null; then
            log_n "  launchd agent loaded."
        else
            log_n "  NOTE: launchctl load returned non-zero; agent will load on next login."
        fi
    fi
}

# ---------------------------------------------------------------------------
# Print dry-run plan summary
# ---------------------------------------------------------------------------
print_plan() {
    log_n "=========================================="
    log_n "AccessBridge Team Installer — Dry-run Plan"
    log_n "=========================================="
    log_n "  Version          : ${VERSION}"
    log_n "  Profile          : ${OPT_PROFILE}"
    log_n "  Profile JSON     : ${PROFILE_JSON_PATH}"
    log_n "  Observatory      : ${OPT_OBSERVATORY}"
    log_n "  Agent install    : ${OPT_AGENT}"
    log_n "  Log level        : ${OPT_LOG_LEVEL}"
    [[ -n "${OPT_PILOT_ID}" ]] && log_n "  Pilot ID         : ${OPT_PILOT_ID}"
    log_n ""
    log_n "  Steps:"
    log_n "    1. Validate macOS 11+ and architecture"
    log_n "    2. Detect Google Chrome"
    log_n "    3. Write Chrome per-user extension policy"
    log_n "       -> ${CHROME_POLICY_DIR}/${EXTENSION_ID}.json"
    log_n "    4. Write default profile JSON"
    log_n "       -> ${DEFAULT_PROFILE_JSON}"
    if [[ "${OPT_AGENT}" == "yes" ]]; then
        log_n "    5. Download agent PKG (cache-bust URL)"
        log_n "       -> ${AGENT_PKG_URL}"
        log_n "    6. Verify SHA-256 (expected: ${AGENT_PKG_SHA256})"
        log_n "    7. sudo installer -pkg ... -target /"
        log_n "    8. Write launchd plist"
        log_n "       -> ${LAUNCHAGENT_PLIST_PATH}"
        log_n "    9. launchctl load plist"
    fi
    log_n "=========================================="
}

# ---------------------------------------------------------------------------
# Bootstrap log directory before any logging calls
# ---------------------------------------------------------------------------
bootstrap_log() {
    # Guard: log dir must not be a symlink before we create it
    if [[ -L "${LOG_DIR}" ]]; then
        printf '[ERROR] Refusing to use symlink as log directory: %s\n' "${LOG_DIR}" >&2
        exit 1
    fi
    mkdir -p "${LOG_DIR}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    bootstrap_log

    parse_args "$@"
    validate_args

    log_n "AccessBridge Team Installer v${VERSION} starting…"
    log_v "  Log file: ${LOG_FILE}"

    if [[ "${OPT_DRY_RUN}" == "true" ]]; then
        print_plan
        detect_platform
        detect_chrome || true  # dry-run: warn but don't abort on Chrome absence
        install_chrome_policy
        install_default_profile
        [[ "${OPT_AGENT}" == "yes" ]] && install_agent
        log_n "[dry-run] Plan complete. No changes were made."
        exit 0
    fi

    detect_platform

    if ! detect_chrome; then
        exit 2
    fi

    install_chrome_policy
    install_default_profile

    if [[ "${OPT_AGENT}" == "yes" ]]; then
        install_agent
    fi

    log_q "AccessBridge installation complete."
    log_n "  Log saved to: ${LOG_FILE}"
    log_n "  Restart Chrome to activate the extension."
    [[ "${OPT_AGENT}" == "yes" ]] && log_n "  Desktop agent is running (launchd user agent)."
}

main "$@"
