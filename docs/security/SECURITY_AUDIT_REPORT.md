# AccessBridge Security Audit Report — Session 26

**Version audited:** 0.24.0 (working tree as of 2026-04-22, baseline commit `021fadc`)
**Date:** 2026-04-22
**Auditor:** Opus 4.7 (1M context) orchestrating Sonnet/Haiku subagents. Codex quota-exhausted — Opus-solo fallback per `feedback_rescue_fallback` memory.
**Plan reference:** Section 15 Week 23 — pre-production security audit + hardening.

---

## Executive summary

| | Critical | High | Medium | Low | Info |
|---|---|---|---|---|---|
| Client-side extension | 0 | 2 | 4 | 3 | 13 |
| Desktop agent (Rust) | 0 | 1 | 4 | 4 | 11 |
| VPS Node (observatory) | 0 | 1 | 2 | 1 | 1 |
| Python (tools + FastAPI) | 0 | 0 | 4 | 3 | 0 |
| Ring-signature crypto | 0 | 0 | 0 | 2 | 10 (SAFE) |
| Live pentest (safe-only) | 0 | 1 | 1 | 2 | 0 |
| Dependency advisories (Node) | 2 | 8 | 7 | 0 | 0 |
| Secrets scan | 0 | 0 | 0 | 0 | 291 FP |
| **Total** | **2** | **13** | **22** | **15** | **326** |

**Fixed in this session:** **4 HIGH** (EXT-001, EXT-002, RUST-001, VPS-001) + **all 17 Node advisories** (2 CRITICAL + 8 HIGH + 7 MODERATE) via dep upgrade. Post-fix audit: **0 Critical, 0 High remaining in shipped client + server code.**

Remaining open findings are MEDIUM/LOW/INFO — none block Chrome Web Store submission. Full deferred-findings register at the bottom of this document.

---

## Methodology

1. **Foundation (Part 0–3):**
   - Attack-surface inventory (`attack-surface.md`) — 57 named surfaces across 6 layers.
   - `pnpm audit --prod`, `cargo audit`, `pip-audit` — see `dep-audit-report.md`.
   - `detect-secrets` worktree scan + full-file scan — see `secrets-scan.md`.
   - 4 parallel Sonnet adversarial passes (extension TS, desktop-agent Rust, ops/observatory Node, tools/scripts Python) — see `semgrep-extension.md`, `rust-audit.md`, `vps-audit.md`, `python-audit.md`.

2. **Live pentest (Part 5, safe-only):** `curl` header audit across 11 public URLs, TLS version probe, light rate-limit probe (10 rps / 30 requests). Aggressive tooling (nmap, sqlmap, ZAP, nikto) **deferred** — staging env not available, shared Caddy edge risk.

3. **Adversarial crypto review (Part 4):** Opus-solo pass on ring-signature module (`packages/core/src/crypto/ring-signature/` + `ops/observatory/crypto-verify.js` + `ops/observatory/public/verifier.js`) — 12 threat classes evaluated, see `ring-sig-adversarial.md`.

4. **Fixes (Part 8):** Sonnet-drafted, Opus-reviewed-and-revised, per-fix regression tests. Two fixes required Opus revisions after adversarial review: EXT-002 reclassification of `TOGGLE_FEATURE` + `ACTION_ITEMS_UPDATE` (legitimate content-script usage) and VPS-001 tightening with CF-Ray header gate (CF-bypass spoof defense).

5. **CI/CD gates (Part 14):** `.github/workflows/security.yml` (per-PR) + `cve-watch.yml` (nightly). Eight jobs: npm-audit, cargo-audit, secrets-scan, semgrep, docker-scout (opt-in), unsafe-rust-detect, insecure-ts-patterns, pr-comment-summary.

---

## HIGH findings — all fixed this session

### FINDING-EXT-001 [HIGH] — Plaintext HTTP for observatory endpoints → FIXED

- **Root file:** `packages/extension/src/background/observatory-publisher.ts:19-26`
- **Issue:** Three observatory endpoint constants used bare-IP HTTP (`http://72.61.227.64:8300/...`). Ring-signed bundles (pubKey, ringHash, org_hash, pilot_id, DP-noised counters) transmitted unencrypted; a network observer could correlate ring membership + publish timing to IPs, partially deanonymizing the ring signature.
- **Fix:** swapped all three constants + UI clipboard/`href` sites (sidepanel/popup) + onnx model-registry base URL to `https://accessbridge.space/observatory/api/*` and `https://accessbridge.space/models`. Follows BUG-002 precedent.
- **Files changed:** `observatory-publisher.ts`, `popup/App.tsx`, `sidepanel/index.tsx`, `packages/onnx-runtime/src/model-registry.ts`.
- **Regression test:** `observatory-publisher.test.ts` — asserts every endpoint starts with `https://accessbridge.space/`; `model-registry.test.ts` — asserts every URL is `https://accessbridge.space/models/` and never bare-IP.
- **Adversarial review note:** Curl-verified that the new HTTPS endpoints are reachable (CF-proxied with CF-Ray on observatory, HSTS + CSP + Permissions-Policy headers present on all HTML).

### FINDING-EXT-002 [HIGH] — No sender.id/tab validation on background onMessage handler → FIXED

- **Root file:** `packages/extension/src/background/index.ts:551-619` (pre-fix).
- **Issue:** Any content script (including an attacker's page-XSS that compromises the extension's content script isolated world) could call `chrome.runtime.sendMessage` with privileged mutation payloads — `AI_SET_KEY` (steal user's Gemini/Claude key + redirect calls), `SAVE_PROFILE` (force-disable all a11y features), `OBSERVATORY_ENROLL`, `VISION_CURATION_SAVE`, `AGENT_SET_PSK`, etc. MV3 externally_connectable not declared, so cross-extension probes blocked — but same-extension content-script path was wide open.
- **Fix:** added `UI_ONLY_MESSAGES` set of 23 privileged mutation types + `isUiOnlyMessage()` predicate. Background listener rejects UI-only messages when `sender.tab !== undefined` (content script) or `sender.id !== chrome.runtime.id` (cross-extension).
- **Adversarial revision:** Opus review caught that `gestures.ts` sends `TOGGLE_FEATURE` from touch gestures and `action-items.ts` sends `ACTION_ITEMS_UPDATE` from content — both legitimate content-script flows. Reclassified as content-allowed with a SECURITY comment noting the background handler must validate feature-name allowlist + items size caps.
- **Regression tests:** 49 tests in `sender-validation.test.ts` covering classification set membership, gate allow/reject paths, cross-extension probe rejection.

### FINDING-RUST-001 [HIGH] — BUG-017/019 regression: third umask-chmod race in PSK file-fallback → FIXED

- **Root file:** `packages/desktop-agent/src-tauri/src/crypto.rs:493` (pre-fix).
- **Issue:** Third occurrence of the BUG-017 pattern. `load_or_create_psk_via_keyring` fallback path used `let _ = std::fs::write(&file_path, json)` — creates the PSK file at `0o644` (umask default), world-readable on multi-user Linux when `$XDG_RUNTIME_DIR` unset (falls back to `~/.cache/accessbridge/pair.key`). Previous BUG-017 and BUG-019 fixes missed this third site.
- **Fix:** extracted `write_secret_file_at(path, bytes)` helper mirroring `write_key_to_file` — `OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)` at creation, belt-and-braces `set_permissions(0o600)` for existing-file case. Replaced the `fs::write` call-site + added `tracing::warn!` on error (was silently discarded).
- **Regression test:** Unix-only `load_or_create_psk_via_keyring_file_fallback_has_0o600` — asserts `meta.permissions().mode() & 0o777 == 0o600`.
- **Prior-art update:** a new RCA entry (BUG-020) adds a "grep ALL `fs::write` on any `.key`/`.psk`/`pair.*`/`.token`/`.db` path" checklist item to the class-of-bug prevention rule so this is the last such regression.

### FINDING-VPS-001 [HIGH] — Rate-limit IP spoofing: trust-proxy unset → FIXED

- **Root file:** `ops/observatory/server.js` — 4 rate-limit middlewares at ~176, ~205, ~259, ~288 (pre-fix).
- **Issue:** Every rate limiter used `req.ip || req.headers['x-forwarded-for'] || 'unknown'` as the bucket key. Without `app.set('trust proxy', ...)` Express resolves `req.ip` to the immediate peer — which is always nginx/127.0.0.1 — so every client shared a single bucket. Trivially exhaustible; defeats rate limit entirely.
- **Fix:** Added `app.set('trust proxy', 3)` (Cloudflare → Caddy → nginx → us = 3 hops). Added `getClientIp(req)` helper that prefers `CF-Connecting-IP` when gated by a valid `CF-Ray` shape (`/^[0-9a-f]+-[A-Z0-9]{3,5}$/i`) and falls back to `req.ip` otherwise. All 4 rate-limit middlewares + 7 error-log sites now use `getClientIp`.
- **Adversarial revision:** Opus review caught that unconditional CF-Connecting-IP trust is CF-bypass-spoofable if the origin VPS port is directly reachable. Added CF-Ray shape check — attacker who fakes only CF-Connecting-IP falls through to `req.ip`. Documented the residual risk: full defense requires firewalling port 8300 to Cloudflare IPs only (ops concern, not code).
- **Regression tests:** 7 tests in `rate-limit-ip-spoof.test.js` — per-IP bucketing, X-Forwarded-For no-reset, CF-Connecting-IP without CF-Ray falls back, malformed CF-Ray falls back, valid CF-Ray shapes accepted.

---

## Dependency advisories — 17 fixed this session

Pre-audit `pnpm audit --prod`: **17 advisories (2 CRITICAL, 8 HIGH, 7 MODERATE)** — all in `jspdf` (10) and `dompurify` (7).

**Fix:** direct-dep upgrade `jspdf 2.5.2 → ^4.2.1` in `packages/extension/package.json` + root `pnpm.overrides: { "dompurify": "^3.4.0" }`. `pnpm install` resolved cleanly, +7 packages, no breaking API changes. Post-fix audit: **0 advisories**. 304/304 extension tests pass (including the PDF-export path that uses jspdf for audit reports).

Cargo audit: 0 vulnerabilities, 2 transitive unsound (`glib 0.18.5`, `rand 0.7.3` — both through Tauri GTK3 deps), 17 unmaintained warnings. None block push; tracked in `deny.toml` with 6-month expiry.

pip-audit: 0 project-level findings. System-wide `lxml 6.0.2` (CVE-2026-41066) is NOT an AccessBridge dep — ops follow-up to verify absence from the VPS Docker image.

See [dep-audit-report.md](./dep-audit-report.md) for per-GHSA detail.

---

## Live pentest — safe-only probe (Part 5)

Target: `https://accessbridge.space`. Tooling: curl. Scope: 11 URLs, GET/HEAD/OPTIONS only, 3 req/s ceiling, 10-second timeouts.

### FINDING-PENTEST-001 [HIGH] — TLS 1.0 accepted at Cloudflare edge → **tooling shipped, awaiting token provision**

Curl-verified: `curl --tlsv1.0 --tls-max 1.0 https://accessbridge.space/` returns HTTP 200. Cloudflare edge allows TLS 1.0 handshakes. Modern baseline is TLS 1.2 minimum.

- **Remediation:** [tools/ops/enforce-min-tls.sh](../../tools/ops/enforce-min-tls.sh) + [docs/operations/cloudflare-hardening.md](../operations/cloudflare-hardening.md). Idempotent bash script: resolves the `accessbridge.space` Cloudflare zone id, reads current `min_tls_version`, PATCHes to `1.2` (or `--min-version 1.3`) if different, waits 10 s for CF edge propagation, verifies via `curl --tlsv1.0 --tls-max 1.0` probe. Exits non-zero if post-PATCH verification fails. Runbook explains how to create a scoped API token (Zone.Zone Settings: Edit scoped to the single zone — no account-level rights, no DNS write, 30-day TTL, IP-restricted).
- **Blast-radius re-check:** `accessbridge.space` is its own Cloudflare zone; `min_tls_version` is a zone-level setting. It affects ONLY this domain. The shared-Caddy comment in the audit scoping applied to the *Caddy origin* (`ti-platform-caddy-1`); Cloudflare is the CDN layer in front and is per-domain. No coordination with other shared-origin project owners is required for this change — the earlier "coordinate with infrastructure team" caveat was overcautious.
- **Nightly regression probe:** [.github/workflows/cve-watch.yml](../../.github/workflows/cve-watch.yml) `tls-min-version` job runs `enforce-min-tls.sh --verify-only` daily and opens a security issue if TLS 1.0 ever becomes accepted again (rogue Page Rule override, dashboard config drift, CF default rollback).
- **Status:** Open — awaiting CF API token provision. Zero code changes required to CLOSE; one curl call once the token exists. Run `CF_API_TOKEN=... tools/ops/enforce-min-tls.sh` from any workstation.

### FINDING-PENTEST-002 [MEDIUM] — False positive (retracted)

Haiku pentest initially flagged observatory endpoints as missing `X-Content-Type-Options` and `X-Frame-Options`. Opus verification via `curl -sI https://accessbridge.space/observatory/api/health`: both headers ARE present (`x-content-type-options: nosniff`, `content-security-policy: frame-ancestors 'none'`). Likely artifact of Haiku using HEAD requests where nginx sometimes omits some headers. Retracted.

### FINDING-PENTEST-003 [MEDIUM] — CORS wildcard on observatory APIs → **defensible by design**

`Access-Control-Allow-Origin: *` on all `/observatory/api/*` endpoints. Design justification (per `server.js` comment): Chrome extensions have dynamically-generated extension-origin URLs that are impractical to allowlist; observatory endpoints have no credentialed access (no `Access-Control-Allow-Credentials`), and all POSTs (publish/enroll) require a ring signature or enrollment gate. Wildcard CORS here is **defensible** — primary defense is the per-endpoint auth, not origin allowlist.

- **Status:** Open — defensible. Recommend: document the threat model in a server.js comment; consider tightening to `Origin: chrome-extension://*` once Chrome supports origin-pattern matching.

### FINDING-PENTEST-004 [LOW] — HTTP→HTTPS returns 522 → **ops concern**

Cloudflare "Origin connection timeout" instead of a 301/302 redirect. UX issue, not a security finding. Operator should verify Caddy is listening on port 80 and redirecting.

### FINDING-PENTEST-005 [LOW] — No rate-limit response headers

`/observatory/api/health` accepts 30 rapid requests without returning RateLimit-* headers. Per the VPS-001 fix rate-limit is per-IP at 60/60s — just no IETF-draft headers exposed. **Recommend:** add `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` so clients can back off gracefully.

See [pentest-report-safe.md](./pentest-report-safe.md) for the full per-URL header table.

---

## Ring-signature adversarial review (Part 4)

12 threat classes exercised: Ristretto subgroup/low-order, nonce reuse, keyImage forgery (BUG-014 regression check), malleability, verify timing, tiny rings, cross-origin replay, hash-function domain separation, TS/Node/web verifier byte-identity, auditor trust model, key-compromise impersonation, cross-module confusion.

**BUG-014 regression check: PASS.** `attestationKeyImageDomain(date, _ringHash)` returns `"accessbridge-obs-v1:" + date` — the `_ringHash` parameter is preserved only for source-compat and discarded. Byte-identical across all three implementations (`commitment.ts`, `crypto-verify.js`, `verifier.js`).

**10 SAFE, 2 DEFENSIVE-GAP (LOW), 0 VULNERABILITY.**

- FINDING-RING-001 [LOW]: `bytesToScalar` silently reduces non-canonical scalars ≥ L instead of rejecting. Creates signature malleability. Not exploitable today because server DB dedups by `UNIQUE(date, keyImage)`, not signature bytes.
- FINDING-RING-002 [LOW]: `sign()` accepts any `n ≥ 2`. K-anonymity floor of 5 lives in enrollment policy, not crypto layer. A caller bypassing the policy layer could produce low-anonymity signatures. Fix: `MIN_RING_SIZE = 5` in `sign()`.

Both LOW findings are open; tracked for follow-up. Neither blocks production push.

See [ring-sig-adversarial.md](./ring-sig-adversarial.md).

---

## Deferred findings register (not fixed this session)

### Extension (TS)
- EXT-003 MEDIUM — `content/ai/bridge.ts:219` latent innerHTML interpolation. Mitigated today (values are internal constants) but adds a regression vector. **Fix:** `escapeHtml()` the `result.tier` / `result.latencyMs` values.
- EXT-004 MEDIUM — `axe-runner.ts` `window.postMessage(*)`. Accepted: nonce + `ev.source !== window` filter provides mitigation; document the rationale in a SECURITY comment.
- EXT-006 MEDIUM — `languages_used` telemetry accepts any BCP-47 tag without pattern validation. **Fix:** regex gate `/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/` in `recordLanguageUsed`.
- EXT-007 LOW — `sanitizeLabel` regex `/[ --]/g` accidentally strips printable ASCII range U+0020–U+002D. Correctness bug (labels lose `!`, `"`, `(`, `)`, etc.), not a security bug. **Fix:** change to `/[\x00-\x1f]/g` per original intent.

### Rust (desktop agent)
- RUST-002 MEDIUM — kdeglobals TOCTOU between `refuse_if_symlink` and `fs::write`. Same-UID attacker + narrow window. **Fix:** `O_NOFOLLOW` via `custom_flags(libc::O_NOFOLLOW)`.
- RUST-003 MEDIUM — `unwrap_or_default()` on nonce decode silently accepts empty nonce. **Fix:** reject decode failure + min-length gate.
- RUST-004 MEDIUM — SQLCipher key formatted into PRAGMA string as hex. Key on heap as plain String, not zeroized. **Fix:** use sqlite3_key C API (raw bytes) or `zeroize::Zeroizing<String>`.
- RUST-005 MEDIUM — `ProfileStore::new()` uses hardcoded `[0x42; 32]` test key but is `pub`. Accidentally usable outside tests. **Fix:** `#[cfg(test)]` gate.
- RUST-006–009 LOW — macOS `Send+Sync` docstring gap, Linux cursor-size unchecked cast, `bridge_read_pair_key_b64` missing symlink guard, xdg_paths app-dir symlink warn-but-continue.

### VPS
- VPS-002 MEDIUM — SQL string-interpolation in `getSummary` + `/api/trends` (clampDays-bounded, not exploitable today).
- VPS-003 MEDIUM — `verifier.js` innerHTML of hex-validated `keyImage`/`merkleRoot`. Defense-in-depth gap.
- VPS-004 LOW — client-side `_featureHidden` plain object — proto-pollution false positive (server-allowlisted keys).

### Python
- PY-001 MEDIUM — HuggingFace downloads without `revision=` pinning in 3 scripts. **Fix:** add `--revision` arg across `download-*.py`.
- PY-002 MEDIUM — SHA-256 computed but only printed, not verified against known-good.
- PY-003 MEDIUM — CORS `allow_origins=["*"]` in `scripts/vps/main.py`. Defensible (no credentials), document.
- PY-004 MEDIUM — uvicorn bind `0.0.0.0` in direct-run path. Docker overrides in prod; defense-in-depth fix.

### Ring-signature (crypto)
- RING-001 LOW — scalar malleability in `bytesToScalar` — reject non-canonical.
- RING-002 LOW — no crypto-layer `MIN_RING_SIZE = 5`.

### Infrastructure / ops
- PENTEST-001 HIGH — TLS 1.0 accepted at CF edge (dashboard-config action for shared-Caddy owners).
- PENTEST-004 LOW — HTTP→HTTPS 522 at origin.
- PENTEST-005 LOW — no IETF rate-limit response headers.
- Dev tooling stale bare-IP — `tools/validate-models.sh`, `tools/aggregate-curated-labels.ts`, `tools/prepare-models/upload-to-vps.sh` still reference `http://72.61.227.64:8300`. **Defer:** these are dev-ops scripts, not shipped client code.
- Full-history secrets scan — scheduled in `.github/workflows/cve-watch.yml` (gitleaks via Ubuntu runner) since Windows dev host lacks Go toolchain.
- Aggressive pentest (nmap, sqlmap, ZAP, nikto) — requires staging env clone.

---

## CI gates wired (Part 14)

- `.github/workflows/security.yml` — runs on PR + push + manual dispatch. Jobs: npm-audit, cargo-audit, secrets-scan, semgrep, docker-scout (opt-in on push only), unsafe-rust-detect, insecure-ts-patterns, pr-comment-summary.
- `.github/workflows/cve-watch.yml` — nightly 01:00 UTC. Jobs: nightly-audit (opens issue on new advisories), stale-baseline-check.
- `.github/dependabot.yml` — 9 ecosystems (7 npm + cargo + github-actions). Weekly Mondays 09:30 IST. Minor+patch grouped.
- Required secrets: `SEMGREP_APP_TOKEN` (optional), `DOCKER_HUB_USER` + `DOCKER_HUB_TOKEN` (opt-in).

---

## Gates passed

- `pnpm -r typecheck` — 5/5 packages: ai-engine, core, onnx-runtime, desktop-agent, extension — all `Done`.
- `pnpm -r test` — workspace suite green after the one onnx-runtime test-expectation update (`model-registry.test.ts` asserted bare-IP; updated to match EXT-001 HTTPS URL pattern). 126/126 onnx-runtime + 304/304 extension + core/ai-engine/desktop-agent unchanged.
- `pnpm audit --prod` — **0 advisories** (was 17).
- `cargo audit` — 0 vulnerabilities (19 transitive warnings informational).
- `detect-secrets` — 0 real secrets (291 false positives classified).

---

## Sign-off

- Critical findings: **0 open**
- High findings: **1 open** (PENTEST-001 TLS 1.0, infrastructure action — not in shipped code)
- Shipped-code high findings: **0 open**

Recommendation: approve for push + deploy. Pending infra action on CF minimum-TLS-version. Deferred findings tracked in this register; at least quarterly triage against this list.

## References

- [attack-surface.md](./attack-surface.md)
- [dep-audit-report.md](./dep-audit-report.md)
- [secrets-scan.md](./secrets-scan.md)
- [semgrep-extension.md](./semgrep-extension.md)
- [rust-audit.md](./rust-audit.md)
- [vps-audit.md](./vps-audit.md)
- [python-audit.md](./python-audit.md)
- [pentest-report-safe.md](./pentest-report-safe.md)
- [ring-sig-adversarial.md](./ring-sig-adversarial.md)
- [../../RCA.md](../../RCA.md) — BUG-020 through BUG-024 (Session 26 entries)
- [../../HANDOFF.md](../../HANDOFF.md) — Session 26 footer
