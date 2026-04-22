#!/usr/bin/env bash
# =============================================================================
# enforce-min-tls.sh
#
# Closes FINDING-PENTEST-001 (HIGH): Cloudflare edge accepts TLS 1.0 at
# accessbridge.space. Sets the Cloudflare zone's Min TLS Version to 1.2
# (or a value supplied via --min-version), verifies via curl TLS 1.0
# probe, and idempotently no-ops when already enforced.
#
# Author  : Manish Kumar
# Project : AccessBridge — Session 26 follow-up
# Updated : 2026-04-22
#
# USAGE
#   CF_API_TOKEN=xxx tools/ops/enforce-min-tls.sh
#   tools/ops/enforce-min-tls.sh --token-file ~/.cf-min-tls-token
#   CF_API_TOKEN=xxx tools/ops/enforce-min-tls.sh --zone accessbridge.space
#   CF_API_TOKEN=xxx tools/ops/enforce-min-tls.sh --min-version 1.3
#   CF_API_TOKEN=xxx tools/ops/enforce-min-tls.sh --dry-run
#
# TOKEN SOURCE (exactly one required; --token-file preferred)
#   CF_API_TOKEN env var     — simplest, but visible to other users on some
#                              Linux configs via /proc/<pid>/environ
#   --token-file <path>      — reads token from file; rejects world- or
#                              group-readable files (mode must be <= 0o600)
#                              and refuses symlinks (BUG-018 pattern).
#                              Precedence: --token-file > CF_API_TOKEN when both
#                              are supplied.
#
#   Create the token: Cloudflare Dashboard → My Profile → API Tokens →
#   Create Token → Custom. Scope to a single zone to limit blast radius.
#
# OPTIONS
#   --zone <fqdn>         Target zone (default: accessbridge.space)
#   --min-version <ver>   1.0 | 1.1 | 1.2 | 1.3 (default: 1.2)
#   --token-file <path>   Read CF API token from file (mode <= 0o600, no
#                         symlinks; overrides CF_API_TOKEN env if both set)
#   --dry-run             Probe + print plan; do not PATCH
#   --verify-only         Skip PATCH; only run the TLS 1.0 curl probe
#   --help
#
# EXIT CODES
#   0  Success — min_tls_version is at or above the target after run
#   1  Generic error (missing token, curl/jq unavailable, unhandled)
#   2  Zone not found under the provided token's permissions
#   3  Cloudflare API call failed
#   4  Post-PATCH verification failed (curl TLS 1.0 still returned 200)
#   5  Token-file rejected (not found, symlink, wrong permissions, empty)
#
# SECURITY
#   Token is passed via curl -H Authorization only — never written to disk,
#   never logged, never printed. Do not pass it via --token=... positional
#   arg; use --token-file or CF_API_TOKEN env. --token-file is the preferred
#   path for shared hosts and for avoiding shell-history / ps-aux leakage.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
ZONE="accessbridge.space"
MIN_VERSION="1.2"
DRY_RUN=0
VERIFY_ONLY=0
TOKEN_FILE=""
TOKEN_FILE_SET=0
API_BASE="https://api.cloudflare.com/client/v4"

# ---------------------------------------------------------------------------
# Output helpers (colour only when stdout is a TTY)
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  _red() { printf '\033[0;31m%s\033[0m\n' "$*"; }
  _green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
  _cyan() { printf '\033[0;36m%s\033[0m\n' "$*"; }
else
  _red() { printf '%s\n' "$*"; }
  _green() { printf '%s\n' "$*"; }
  _cyan() { printf '%s\n' "$*"; }
fi

die() { _red "ERROR: $*" >&2; exit "${2:-1}"; }
info() { _cyan "INFO: $*"; }
ok() { _green "OK: $*"; }

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --zone)         ZONE="$2"; shift 2 ;;
    --min-version)  MIN_VERSION="$2"; shift 2 ;;
    --token-file)   TOKEN_FILE="$2"; TOKEN_FILE_SET=1; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --verify-only)  VERIFY_ONLY=1; shift ;;
    --help|-h)      sed -n '2,60p' "$0"; exit 0 ;;
    *)              die "Unknown arg: $1" ;;
  esac
done

case "$MIN_VERSION" in
  1.0|1.1|1.2|1.3) ;;
  *) die "Invalid --min-version: $MIN_VERSION (allowed: 1.0 1.1 1.2 1.3)" ;;
esac

# Only 1.2 and 1.3 actually close FINDING-PENTEST-001; warn for older.
if [[ "$MIN_VERSION" == "1.0" || "$MIN_VERSION" == "1.1" ]]; then
  _red "WARNING: --min-version $MIN_VERSION does NOT close FINDING-PENTEST-001."
  _red "         Use 1.2 (default) or 1.3. Continuing anyway."
fi

# ---------------------------------------------------------------------------
# Preflight — deps + token
# ---------------------------------------------------------------------------
command -v curl >/dev/null 2>&1 || die "curl not found on PATH"

# jq optional — the script falls back to grep+sed if absent, but jq is much
# more robust. Warn but proceed.
HAVE_JQ=0
if command -v jq >/dev/null 2>&1; then HAVE_JQ=1; fi

load_token_from_file() {
  local path="$1"
  [[ -n "$path" ]] || die "--token-file requires a path" 5
  [[ -e "$path" ]] || die "--token-file not found: $path" 5
  # BUG-018 pattern — refuse symlinks. symlink_metadata equivalent in bash.
  [[ -L "$path" ]] && die "--token-file refuses symlinks: $path" 5
  [[ -f "$path" ]] || die "--token-file not a regular file: $path" 5
  # Require Unix mode <= 0o600 on real Unix hosts. On Windows Git Bash /
  # MSYS / Cygwin the kernel doesn't expose Unix mode bits meaningfully
  # (stat always reports 0o644 for user-owned files regardless of chmod);
  # NTFS ACLs handle this layer separately, so skip the check there.
  local kernel=""
  if command -v uname >/dev/null 2>&1; then
    kernel=$(uname -s 2>/dev/null || echo "")
  fi
  case "$kernel" in
    MINGW*|MSYS*|CYGWIN*)
      info "(Windows host detected — skipping Unix mode check; ensure NTFS ACLs restrict the file to your user only)"
      ;;
    *)
      if command -v stat >/dev/null 2>&1; then
        local mode
        # GNU stat first, BSD stat second
        mode=$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null || echo "")
        if [[ -n "$mode" ]]; then
          # Allow 0600, 0400, 0200 (owner-read/write only). Reject anything
          # with group or other bits set.
          case "$mode" in
            600|400|200) ;;
            *) die "--token-file mode must be <= 0o600, got 0o${mode}: $path" 5 ;;
          esac
        fi
      fi
      ;;
  esac
  # Read the file; strip whitespace + newlines. Never echo the content.
  local raw
  raw=$(cat "$path")
  # shellcheck disable=SC2001 # sed is clearer than ${var//re/} here
  raw=$(printf '%s' "$raw" | sed 's/[[:space:]]//g')
  [[ -n "$raw" ]] || die "--token-file is empty or whitespace-only: $path" 5
  # Loose sanity check — CF tokens are typically 40+ chars of [A-Za-z0-9_-].
  if [[ ${#raw} -lt 20 ]]; then
    die "--token-file content too short to be a valid CF API token (${#raw} chars)" 5
  fi
  CF_API_TOKEN="$raw"
  export CF_API_TOKEN
}

if [[ "$VERIFY_ONLY" -eq 0 ]]; then
  # --token-file takes precedence over the env var when both are supplied.
  # Track "was the flag passed?" separately from "is the value non-empty?"
  # so `--token-file ""` gives a precise error instead of falling through
  # to the generic "no token source" message.
  if [[ "$TOKEN_FILE_SET" -eq 1 ]]; then
    load_token_from_file "$TOKEN_FILE"
    info "Token loaded from file (length ${#CF_API_TOKEN} chars)"
  fi
  [[ -n "${CF_API_TOKEN:-}" ]] || die "No token source: pass --token-file <path> or set CF_API_TOKEN env var."
fi

# ---------------------------------------------------------------------------
# Cloudflare API helpers
# ---------------------------------------------------------------------------
_api_get() {
  local path="$1"
  curl -fsS -X GET "${API_BASE}${path}" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json"
}

_api_patch() {
  local path="$1" body="$2"
  curl -fsS -X PATCH "${API_BASE}${path}" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$body"
}

# Extract a top-level JSON string from a response body (id / value / etc).
# Uses jq if present, else a scoped grep/sed.
_json_get() {
  local body="$1" key="$2"
  if [[ "$HAVE_JQ" -eq 1 ]]; then
    printf '%s' "$body" | jq -r "$key"
  else
    # Crude fallback — matches "key":"value" in a flat-ish object.
    local plainkey
    plainkey=$(printf '%s' "$key" | sed 's/\.result\.//;s/\.result\[0\]\.//;s/\.//g;s/\[0\]//g')
    printf '%s' "$body" | grep -oE "\"${plainkey}\":\"[^\"]*\"" | head -1 | sed -E "s/.*\"${plainkey}\":\"([^\"]*)\".*/\1/"
  fi
}

# ---------------------------------------------------------------------------
# TLS 1.0 probe
# ---------------------------------------------------------------------------
probe_tls10() {
  local host="$1" code curl_status
  # Capture curl's exit status separately from its stdout.
  # When TLS 1.0 is refused:
  #   * curl exits non-zero (SSL connect error; schannel/openssl/libssl vary
  #     but all return non-zero)
  #   * curl's -w "%{http_code}" still writes something to stdout — often
  #     "000" (three zeros) because no HTTP response was received.
  # We must NOT append an `|| echo "0"` after curl's stdout: that concatenates
  # "000" + "0" = "0000", which is neither the string "0" nor recognisable
  # as "rejected" without a pattern match. The Session-26 follow-up caught
  # this bug in prod: the real CF edge was rejecting TLS 1.0 but probe_tls10
  # returned "0000" which the caller then mis-reported as still-accepted.
  code=$(curl -sS --tlsv1.0 --tls-max 1.0 --max-time 10 \
    -o /dev/null -w "%{http_code}" "https://${host}/" 2>/dev/null)
  curl_status=$?
  # Treat these all as "handshake refused — TLS 1.0 is rejected":
  #   - curl exited non-zero
  #   - or %{http_code} is empty / all zeros
  if [[ $curl_status -ne 0 || -z "$code" || "$code" =~ ^0+$ ]]; then
    printf 'REJECTED'
    return
  fi
  printf 'ACCEPTED-%s' "$code"
}

# ---------------------------------------------------------------------------
# Verify-only fast path
# ---------------------------------------------------------------------------
if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  info "Verify-only: probing TLS 1.0 at ${ZONE}"
  result=$(probe_tls10 "$ZONE")
  if [[ "$result" == "REJECTED" ]]; then
    ok "TLS 1.0 handshake REJECTED at ${ZONE} (expected — FINDING-PENTEST-001 closed)"
    exit 0
  fi
  _red "TLS 1.0 handshake ${result} at ${ZONE} — FINDING-PENTEST-001 still open"
  exit 4
fi

# ---------------------------------------------------------------------------
# Main — resolve zone id, read current setting, PATCH if needed, verify
# ---------------------------------------------------------------------------
info "Resolving Cloudflare zone id for ${ZONE}..."
zones_resp=$(_api_get "/zones?name=${ZONE}&status=active") || die "zones lookup failed (check token permissions)" 3

zone_id=$(_json_get "$zones_resp" ".result[0].id")
if [[ -z "$zone_id" || "$zone_id" == "null" ]]; then
  _red "Zone '${ZONE}' not found under the token's permissions."
  _red "Create a Custom Token with 'Zone.Zone Settings: Edit' scoped to ${ZONE}."
  exit 2
fi
ok "Zone id: ${zone_id}"

info "Reading current min_tls_version..."
cur_resp=$(_api_get "/zones/${zone_id}/settings/min_tls_version") || die "read min_tls_version failed" 3
cur_val=$(_json_get "$cur_resp" ".result.value")
[[ -n "$cur_val" ]] || cur_val="unknown"
info "Current min_tls_version: ${cur_val}"
info "Target min_tls_version : ${MIN_VERSION}"

# Compare numerically — "1.2" >= "1.0" test works as string for 1.x but
# enforce numerically to handle 1.3 / 1.2 ordering correctly.
_at_or_above() {
  # Returns 0 if $1 >= $2 (both MAJOR.MINOR).
  local have="$1" want="$2"
  local hmaj=${have%.*} hmin=${have#*.}
  local wmaj=${want%.*} wmin=${want#*.}
  if (( hmaj > wmaj )); then return 0; fi
  if (( hmaj < wmaj )); then return 1; fi
  (( hmin >= wmin ))
}

needs_patch=1
if [[ "$cur_val" =~ ^1\.[0-3]$ ]] && _at_or_above "$cur_val" "$MIN_VERSION"; then
  ok "Already at or above target — no PATCH required"
  needs_patch=0
fi

if [[ "$needs_patch" -eq 1 ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    _cyan "[dry-run] Would PATCH /zones/${zone_id}/settings/min_tls_version  value=${MIN_VERSION}"
  else
    info "Patching min_tls_version to ${MIN_VERSION}..."
    patch_resp=$(_api_patch "/zones/${zone_id}/settings/min_tls_version" \
      "{\"value\":\"${MIN_VERSION}\"}") || die "PATCH failed" 3
    new_val=$(_json_get "$patch_resp" ".result.value")
    [[ "$new_val" == "$MIN_VERSION" ]] || die "PATCH returned unexpected value: '$new_val' (wanted '$MIN_VERSION')" 3
    ok "API returned success; new value ${new_val}"
  fi
fi

# ---------------------------------------------------------------------------
# Post-PATCH verification — propagation can take a few seconds
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] Skipping TLS 1.0 probe"
  exit 0
fi

info "Waiting 10s for Cloudflare edge propagation..."
sleep 10

info "Probing TLS 1.0 at ${ZONE}..."
result=$(probe_tls10 "$ZONE")
if [[ "$result" == "REJECTED" ]]; then
  ok "TLS 1.0 handshake REJECTED at ${ZONE} — FINDING-PENTEST-001 closed."
  exit 0
fi

_red "TLS 1.0 probe unexpectedly returned ${result}."
_red "This can happen if:"
_red "  - Cloudflare edge is still propagating (retry --verify-only in ~60s)"
_red "  - The PATCH was applied at a different zone scope than expected"
_red "  - Another active Page Rule / Config Rule is overriding min_tls_version"
exit 4
