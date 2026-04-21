# VPS Security Audit — AccessBridge Observatory v0.24.0

**Date:** 2026-04-22
**Auditor:** Opus 4.7 (manual, Codex quota-exhausted)
**Scope:** `ops/observatory/` — server.js (1943 lines, 22 routes), crypto-verify.js, enterprise-endpoint.js, seed-demo-data.js, public/app.js, public/pilot.js, public/verifier.js

---

## Executive Summary

The observatory service is **well-hardened for a Node/Express/SQLite stack**. All 22 SQL call sites use parameterized statements. The ring-sig auth path is constant-time. Body-size limit is explicitly set. No eval/child_process/outgoing fetch. No JWT. No secrets hardcoded.

**4 findings identified** (0 Critical, 1 High, 2 Medium, 1 Low, 1 Info). None allow remote code execution or data exfiltration alone. The High finding (rate-limit bypass) is the most actionable — it needs a one-line fix.

---

## FINDING-VPS-001 — HIGH — Rate-limit IP spoofing (trust proxy not set)

**File:** `ops/observatory/server.js` lines 176, 205, 259, 288

**Pattern:** Rate-limit bypass via X-Forwarded-For header spoofing.

**Detail:**

All four rate-limit functions (`rateLimit`, `enrollRateLimit`, `pilotEnrollRateLimit`, `pilotFeedbackRateLimit`) derive the client identity key with this pattern:

```js
const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
```

`req.ip` on Express defaults to the direct TCP peer address **only when `trust proxy` is not configured**. The server is deployed behind Caddy (nginx-proxied port 8300 → 8200 per ARCHITECTURE.md). Caddy sets `X-Forwarded-For` to the real client IP and `req.ip` will be `127.0.0.1` (the Caddy loopback) **unless** `app.set('trust proxy', 1)` is configured.

Without `trust proxy`, `req.ip` will be `127.0.0.1` for all requests reaching the Node process — meaning all clients share one rate-limit bucket, and a single attacker at rate=60 req/min can trigger 429s for everyone. Alternatively, if `trust proxy` is set but the fallback `req.headers['x-forwarded-for']` branch is taken, an attacker can forge the header:

```
X-Forwarded-For: 1.2.3.4, 127.0.0.1
```

The `req.headers['x-forwarded-for']` value is a raw string (potentially `"1.2.3.4, 127.0.0.1"`), used directly as the Map key. An attacker controlling that header can rotate to any value and reset their counter.

`pilotFeedbackRateLimit` has a second branch keyed on `device_hash` from `req.body` (line 288). This is intentional (per-device rate limiting) but falls back to `req.ip || 'unknown'` if no device_hash, with the same weakness.

**Fix:**

```js
// Near the top, before middleware
app.set('trust proxy', 1);   // Trust exactly one proxy hop (Caddy)
```

Then change every rate-limit key derivation to:

```js
const ip = req.ip || 'unknown';  // req.ip is now the real client IP after proxy trust
```

Remove all `|| req.headers['x-forwarded-for']` fallbacks — they are the unsafe path.

**Severity rationale:** Exploitable to either (a) flood all users off rate-limited endpoints by exhausting the shared 127.0.0.1 bucket, or (b) bypass per-IP rate limits entirely by spoofing XFF.

---

## FINDING-VPS-002 — MEDIUM — SQL string interpolation in `getSummary` and `/api/trends`

**File:** `ops/observatory/server.js` lines 477–481, 802–806

**Pattern:** `windowDays` and `days` interpolated directly into the SQL string body (not into a bind parameter).

**Detail:**

`getSummary` (line 477–481):

```js
const since = `date('now','-${windowDays} days','localtime')`;
const totalsByMetric = db.prepare(
  `SELECT ... FROM aggregated_daily WHERE date >= ${since} GROUP BY metric`,
).all();
```

`/api/trends` handler (line 802–806):

```js
const rows = db.prepare(
  `SELECT date, total, device_count FROM aggregated_daily
   WHERE metric = ? AND date >= date('now','-${days} days','localtime')
   ORDER BY date ASC`,
).all(metric);
```

`windowDays` and `days` both pass through `clampDays(n, 1, 365)` which calls `Math.trunc` and clamps to integer 1–365. This means only decimal integers 1–365 can survive. **In practice, SQL injection through these values is not achievable today** because `clampDays` produces a pure integer or fallback 30 — no quotes, no SQL metacharacters.

However, the pattern is fragile: if `clampDays` is ever changed, or the template string is copy-pasted without the clamp, the SQL becomes injectable. All 11 other date-window queries in the same file (lines 934, 946, 1013, 1028, 1083, 1127, 1161, 1175, 1246) use the safer `date('now','-' || ? || ' days','localtime')` pattern with `?` binding.

**Fix:** Bring `getSummary` and the `/api/trends` window into parity with the rest:

```js
// getSummary
const totalsByMetric = db.prepare(
  `SELECT metric, SUM(total) AS total, SUM(device_count) AS device_count
   FROM aggregated_daily WHERE date >= date('now','-' || ? || ' days','localtime') GROUP BY metric`,
).all(windowDays);

// /api/trends
const rows = db.prepare(
  `SELECT date, total, device_count FROM aggregated_daily
   WHERE metric = ? AND date >= date('now','-' || ? || ' days','localtime')
   ORDER BY date ASC`,
).all(metric, days);
```

**Severity rationale:** Not currently exploitable, but inconsistency with every other window query in the file. Flagged Medium per "prefer false positives" policy and to eliminate fragility.

---

## FINDING-VPS-003 — MEDIUM — Stored XSS surface in `verifier.js` via `tr.innerHTML` with unescaped `keyImage`/`merkleRoot`

**File:** `ops/observatory/public/verifier.js` lines 398–403

**Pattern:** `tr.innerHTML` template literal inserts server-returned `row.keyImage` and `row.merkleRoot` without HTML-escaping.

**Detail:**

```js
tr.innerHTML = `
  <td class="mono">${(row.keyImage ?? '—').slice(0, 16)}…</td>
  <td class="mono">${(row.merkleRoot ?? '—').slice(0, 16)}…</td>
  <td class="cell-valid">${row.valid ? svgValid() : svgInvalid()}</td>
  <td class="cell-reason">${row.valid ? '' : escapeHtml(row.reason ?? '')}</td>
`;
```

`row.reason` is correctly escaped via `escapeHtml`. But `row.keyImage` and `row.merkleRoot` are sourced from `GET /api/verify/:date` → `attestation_json` stored in SQLite → originally submitted by a client in `POST /api/publish`. These values are validated on publish (`PUBKEY_HEX_RE = /^[0-9a-f]{64}$/` for keyImage, and `merkleRoot` is a 64-hex string verified by `verifyAttestation`). A conforming value can only contain `[0-9a-f]`, so `<`, `>`, `"` cannot appear and HTML injection is not achievable through these specific fields with the current validation.

However, the pattern is vulnerable by design: inserting server-originated data into `innerHTML` without escaping is a defense-in-depth failure. If validation is ever relaxed (e.g. error paths return non-hex strings in `keyImage`), XSS becomes possible.

**Fix:** Replace the `tr.innerHTML` block with explicit `textContent` assignments or call `escapeHtml` on `keyImage` and `merkleRoot`:

```js
const tr = document.createElement('tr');
const tdKi = document.createElement('td');
tdKi.className = 'mono';
tdKi.textContent = (row.keyImage ?? '—').slice(0, 16) + '…';
// ... etc, or at minimum:
tr.innerHTML = `
  <td class="mono">${escapeHtml((row.keyImage ?? '—').slice(0, 16))}…</td>
  <td class="mono">${escapeHtml((row.merkleRoot ?? '—').slice(0, 16))}…</td>
  <td class="cell-valid">${row.valid ? svgValid() : svgInvalid()}</td>
  <td class="cell-reason">${row.valid ? '' : escapeHtml(row.reason ?? '')}</td>
`;
```

**Severity rationale:** Not currently exploitable because the stored values are hex-only. Flagged Medium as defense-in-depth gap and inconsistency with `row.reason` which is correctly escaped.

---

## FINDING-VPS-004 — LOW — Prototype pollution via `_featureHidden` object in `app.js`

**File:** `ops/observatory/public/app.js` lines 263, 322–323, 343–345

**Pattern:** Server-returned `s.feature` values used as keys on a plain object without prototype check.

**Detail:**

```js
var _featureHidden = {};
// ...
if (_featureHidden[s.feature]) return;       // line 322
// ...
_featureHidden[f] = !_featureHidden[f];      // line 344 — f = btn.dataset.feature
```

`s.feature` comes from the server response (`/api/observatory/feature-usage`) which is validated server-side against the `FEATURE_NAMES` allowlist. However, `btn.dataset.feature` (line 343) is pulled from `data-feature` attributes set via `escapeHtml(s.feature)` (line 337). The allowlist means a conforming server cannot inject `__proto__` as a feature name.

**This is NOT currently exploitable** because the server enforces `FEATURE_NAMES` (a closed Set). Flagged because (a) the code reads `_featureHidden[f]` on an un-proxied plain object, and (b) if the server allowlist is ever expanded or the endpoint is called directly with crafted data, prototype pollution of the page-level object is possible.

**Fix:** Use `Map` instead of a plain object (consistent with the server-side BUG-015 pattern):

```js
var _featureHidden = new Map();
// ...
if (_featureHidden.get(s.feature)) return;
// ...
_featureHidden.set(f, !_featureHidden.get(f));
```

**Severity rationale:** Low — requires server compromise or allowlist bypass first; consequence limited to client-side page behavior corruption.

---

## FINDING-VPS-005 — INFO — `attestation.counters` spread into `legacyBundle` before `validateBundle` call

**File:** `ops/observatory/server.js` lines 646–653

**Pattern:** `{...(attestation.counters || {})}` spread on a user-supplied object before schema validation.

**Detail:**

```js
const legacyBundle = {
  schema_version: 1,
  date: attestation.date,
  merkle_root: attestation.merkleRoot,
  ...(attestation.counters || {}),
};
const valErr = validateBundle(legacyBundle);
```

Spreading `attestation.counters` before validation means `legacyBundle` may briefly contain arbitrary keys (`__proto__`, `constructor`, etc.) from a malicious payload before `validateBundle` rejects them. In Node.js, spreading a plain object with `__proto__` as a key does NOT mutate `Object.prototype` (the spread operator uses `Object.assign`-like property enumeration, which skips non-own inherited properties and the behavior for `__proto__` key in object literals is a special case in V8 — it does not set `__proto__` via spread). This is therefore **not a live prototype pollution vulnerability** in Node.js ≥ 12, but is worth noting for defense-in-depth.

`validateBundle` does run and rejects the bundle if any key is outside the allowlists. The aggregation path is not reached.

**No fix required.** Informational note: if the order were reversed (spread after validate), the code intent would be clearer. Alternatively, explicitly destructure only the known keys:

```js
const legacyBundle = {
  schema_version: 1,
  date: attestation.date,
  merkle_root: attestation.merkleRoot,
  adaptations_applied: attestation.counters?.adaptations_applied,
  struggle_events_triggered: attestation.counters?.struggle_events_triggered,
  features_enabled: attestation.counters?.features_enabled,
  domain_connectors_activated: attestation.counters?.domain_connectors_activated,
  languages_used: attestation.counters?.languages_used,
  estimated_accessibility_score_improvement: attestation.counters?.estimated_accessibility_score_improvement,
};
```

---

## Known-Good Patterns (no finding)

| Pattern | Verdict |
|---|---|
| **SQL injection** — all 22 routes | All 44 `db.prepare(...)` + `stmt.all/get/run` calls use positional `?` binds. The two interpolated window queries (FINDING-VPS-002) use clamped integers only. |
| **Body-parser size** | `express.json({ limit: '64kb' })` at line 146 — explicit, below the 100 MB default. |
| **CORS** | `Access-Control-Allow-Origin: *` with no `credentials: true` / `Access-Control-Allow-Credentials` header. Safe: wildcard + no credentials = no CSRF via CORS. Dashboard is internal. |
| **Prototype pollution (server)** | `req.body` fields are destructured by name, never spread via `Object.assign({}, req.body)` or `{...req.body}` (except the single counters spread in FINDING-VPS-005, which is validated). `FEATURE_NAMES`, `ADAPTATION_TYPES`, `DOMAIN_NAMES`, `LANGUAGE_CODES` all use `Set.has()` — no `key in object` pattern. |
| **requirePilotAdmin timing** | `crypto.timingSafeEqual` with both-side padding at lines 240–244. Length check after (correct). |
| **Ring-sig verify short-circuit** | `verifyAttestation` (crypto-verify.js line 236) checks `format !== 1`, array structure, hex lengths, ring hash, Merkle root, then SAG verify loop. An empty/missing signature field throws and returns `{valid: false}` — no short circuit on missing data. |
| **Pilot enroll-device gate** | `findDeviceByPubKey` ring-membership check at line 1789 prevents k-anon bypass via fake pubkeys. |
| **SSRF** | Zero outgoing `fetch/http.get/https.get` in server.js or enterprise-endpoint.js. |
| **eval / new Function / child_process** | None found. |
| **JWT** | Not used. |
| **Crypto HMAC key** | Not used for request auth. `PILOT_ADMIN_TOKEN` sourced from `process.env.PILOT_ADMIN_TOKEN || null` (line 230) — never hardcoded. Defaults to null (endpoint disabled), not a weak fallback. |
| **Error leaks** | All catch blocks return `res.status(500).json({ error: 'internal' })`. No `err.stack` in responses. `console.error` logs message only, not request body. |
| **Logger PII** | Error-path logs include `pilot_id` and `req.ip` only (lines 1471, 1545, 1695, 1745, 1801, 1844, 1909). No `req.body` logging. |
| **Metric key allowlist** | `validateBundle` enforces `ADAPTATION_TYPES`, `FEATURE_NAMES`, `DOMAIN_NAMES`, `LANGUAGE_CODES` before accepting any counter values. Applied on both legacy and ring-signed paths. |
| **Path traversal** | `/verifier` route uses `path.join(PUBLIC_DIR, 'verifier.html')` — fixed filename, no user input. `express.static(PUBLIC_DIR)` serves a server-controlled dir. No `fs.readFile`. |
| **Header injection (CSV export)** | `Content-Disposition: attachment; filename="pilot-${pilotId}-export.csv"` — `pilotId` is a validated integer (line 1704), not user string. No injection possible. `csvEscape()` applied to all CSV fields. |
| **k-anonymity** | Global endpoints: `K_ANON_MIN=5` (line 905). Pilot endpoints: `PILOT_K_ANON=20` (line 1329). Both applied before returning categorical data. `language-breakdown` uses HAVING clause in SQL to pre-filter (line 1085). |
| **Stored XSS (app.js)** | All server-returned string values inserted via `escapeHtml()` before `innerHTML` injection. Numeric values coerced via `Math.round()`. SVG path data derived from numeric computations only. |
| **Stored XSS (pilot.js)** | All DOM insertions use `textContent`, `createElement`, `setAttribute`, or `createTextNode`. Zero `innerHTML` assignments of server data. |
| **enterprise-endpoint.js** | All three endpoints return 501 with static strings. Input validation on `orgHash` query param (hex64 regex). No DB access. |
| **seed-demo-data.js** | Offline script, not reachable via HTTP. No network listener. Parameterized statements. |
| **Static serve misconfiguration** | `PUBLIC_DIR = path.join(__dirname, 'public')` — server-controlled, not user-writable. No upload endpoint exists. |

---

## Summary

| Category | Files Scanned | Findings |
|---|---|---|
| SQL injection | server.js (44 call sites) | FINDING-VPS-002 (fragile pattern, not exploitable) |
| Rate-limit bypass | server.js (4 middleware fns) | FINDING-VPS-001 (HIGH — fix required) |
| Auth bypass | server.js (`requirePilotAdmin`) | None |
| Timing attacks | server.js | None (timingSafeEqual used) |
| Stored XSS | app.js, verifier.js, pilot.js | FINDING-VPS-003 (verifier.js, not exploitable today) |
| Prototype pollution | server.js, app.js | FINDING-VPS-004 (app.js, not exploitable today); FINDING-VPS-005 (info) |
| SSRF | server.js | None |
| eval/child_process | all | None |
| JWT | all | None used |
| Header injection | server.js | None |
| Path traversal | server.js | None |
| Body-parser size | server.js | None (64kb explicit) |
| CORS | server.js | None (wildcard, no credentials) |
| k-anonymity | server.js | None |
| Crypto key source | server.js | None |
| Error/log leaks | server.js | None |
| Metric allowlist | server.js | None |

**Patterns swept:** 20 of 20 specified. 4 findings. 0 critical, 1 high, 2 medium, 1 low, 1 info.

**Priority action:** FINDING-VPS-001 — add `app.set('trust proxy', 1)` and remove the `|| req.headers['x-forwarded-for']` fallback in all four rate-limit functions.
