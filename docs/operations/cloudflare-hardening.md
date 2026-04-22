# Cloudflare Edge Hardening Runbook

**Session 26 follow-up — closes FINDING-PENTEST-001 (HIGH)**

The Session 26 safe-pentest confirmed the Cloudflare edge at `accessbridge.space` accepts TLS 1.0 handshakes. Modern baseline is TLS 1.2 minimum. This is the only HIGH finding still open from the Session 26 audit; it is an infrastructure/dashboard action, not a code change — hence this runbook.

## Why it matters

- TLS 1.0 has known weaknesses (BEAST, downgrade attacks, weak ciphersuites).
- Ring-signature anonymity (Session 16 Feature #7) already migrated to HTTPS in Session 26's EXT-001 fix — but an observer who can coerce a TLS 1.0 downgrade still has more attack surface than a pure TLS 1.2/1.3 flow.
- PCI DSS, FedRAMP, most modern compliance baselines require TLS 1.2+. Enterprise Team/Enterprise-tier customers will ask.

## Scope

**Target domain:** `accessbridge.space` (single Cloudflare zone).

**Blast radius:** zone-level setting. Applies only to `accessbridge.space` and any sub-hostnames under it. Does NOT affect other projects sharing the Caddy origin (`ti-platform-caddy-1`) — Cloudflare zones are per-domain, and each zone has its own `min_tls_version` setting. No coordination with other project owners is required for this change.

## Tool

`tools/ops/enforce-min-tls.sh` — idempotent bash script. Reads the current Cloudflare zone setting, PATCHes to the target if different, waits for edge propagation, verifies by probing TLS 1.0 directly with `curl --tlsv1.0 --tls-max 1.0`. Exits non-zero if post-PATCH verification fails.

## One-time setup — create a scoped Cloudflare API token

1. Log in to the Cloudflare dashboard with the owner account for the `accessbridge.space` zone.
2. Navigate to **My Profile** → **API Tokens** → **Create Token** → **Custom token**.
3. Token name: `accessbridge-min-tls-enforce`
4. Permissions:
   - `Zone` / `Zone Settings` / `Edit`
5. Zone Resources:
   - `Include` / `Specific zone` / `accessbridge.space`
6. TTL: set an expiry (recommend 30 days; rotate monthly).
7. Client IP Address Filtering: optional but recommended — restrict to the admin workstation IP.
8. Click **Continue to summary** → **Create Token**.
9. **Copy the token once** — Cloudflare shows it only this one time. Store it in a password manager; never commit it to the repo.

Scope rationale: this token can ONLY change zone settings for `accessbridge.space`. It cannot create / delete DNS records, cannot touch other zones, cannot touch account-level settings.

## Run the enforcement

From the repo root, on any workstation with bash + curl:

```bash
CF_API_TOKEN="<paste-your-token-here>" \
  tools/ops/enforce-min-tls.sh
```

Expected output on first run:

```text
INFO: Resolving Cloudflare zone id for accessbridge.space...
OK: Zone id: <hex-id>
INFO: Reading current min_tls_version...
INFO: Current min_tls_version: 1.0
INFO: Target min_tls_version : 1.2
INFO: Patching min_tls_version to 1.2...
OK: API returned success; new value 1.2
INFO: Waiting 10s for Cloudflare edge propagation...
INFO: Probing TLS 1.0 at accessbridge.space...
OK: TLS 1.0 handshake REJECTED at accessbridge.space — FINDING-PENTEST-001 closed.
```

On subsequent runs (already enforced):

```text
OK: Already at or above target — no PATCH required
OK: TLS 1.0 handshake REJECTED at accessbridge.space — FINDING-PENTEST-001 closed.
```

## Verify only (no token required)

```bash
tools/ops/enforce-min-tls.sh --verify-only
```

Exit 0 when TLS 1.0 is rejected, exit 4 when still accepted. Useful for a nightly CI probe or a cold post-deploy check.

## Options

| Flag | Default | Purpose |
| --- | --- | --- |
| `--zone <fqdn>` | `accessbridge.space` | Target a different zone — e.g. a staging domain |
| `--min-version <v>` | `1.2` | Accepts `1.2` or `1.3`. `1.3` is the modern recommendation; `1.2` is the minimum that closes PENTEST-001 |
| `--dry-run` | off | Probe + print plan; do not PATCH |
| `--verify-only` | off | Skip PATCH; only run the TLS 1.0 curl probe (no token required) |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success — `min_tls_version` at or above target, TLS 1.0 rejected |
| 1 | Generic error (missing token, curl unavailable) |
| 2 | Zone not found under the token's permissions |
| 3 | Cloudflare API call failed |
| 4 | Post-PATCH verification failed (TLS 1.0 still accepted) |

## Rollback

If enforcement causes an unexpected compatibility problem with a legacy client, revert to the previous value:

```bash
CF_API_TOKEN="<token>" tools/ops/enforce-min-tls.sh --min-version 1.0
```

*(The script prints a loud warning when the target is `1.0` or `1.1` because it does NOT close PENTEST-001. Use only for short-term rollback.)*

Better rollback: set `1.1` as a compromise while investigating the incompatible client — still blocks the worst TLS 1.0 weaknesses while offering more compatibility than `1.2`.

## Automation — post-change nightly verification

Add a cron / CI job that runs `--verify-only` daily and pages the ops channel on exit 4. A rogue Cloudflare Page Rule / Config Rule override could silently re-open the hole.

Example GitHub Actions snippet (drop into `.github/workflows/cve-watch.yml` alongside the existing jobs):

```yaml
  tls-min-version:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Verify TLS 1.0 rejected at accessbridge.space
        run: bash tools/ops/enforce-min-tls.sh --verify-only
```

No token required — the verify-only path uses curl only.

## Reference

- **Cloudflare API** — `PATCH /zones/{zone_id}/settings/min_tls_version` → <https://developers.cloudflare.com/api/operations/zone-settings-change-minimum-tls-version-setting>
- **Cloudflare Dashboard** — SSL/TLS → Edge Certificates → Minimum TLS Version
- **Session 26 finding** — [docs/security/pentest-report-safe.md](../security/pentest-report-safe.md) §PENTEST-001
- **Security audit summary** — [docs/security/SECURITY_AUDIT_REPORT.md](../security/SECURITY_AUDIT_REPORT.md)
- **RCA entry** — pending; will land when the first enforcement is verified on prod.
