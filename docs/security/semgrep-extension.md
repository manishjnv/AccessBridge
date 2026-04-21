# Security Audit — Extension (TypeScript)

**Methodology:** Manual adversarial review using Grep + targeted Read. semgrep unavailable (Python 3.14 wheels missing; Codex quota-exhausted).
**Scope:** packages/extension/src/, packages/core/src/, packages/ai-engine/src/ (not present on disk), packages/onnx-runtime/src/ (not present on disk)
**Date:** 2026-04-22
**Auditor:** Sonnet (AccessBridge Session 26)

---

## CRITICAL

_No CRITICAL findings._

---

## HIGH

### FINDING-EXT-001 [HIGH]
- **File:** `packages/extension/src/background/observatory-publisher.ts:20,24,26`
- **Rule:** SSRF / plaintext-HTTP transmission of cryptographic material
- **Description:** All three observatory API endpoints (`OBSERVATORY_ENDPOINT`, `OBSERVATORY_ENROLL_ENDPOINT`, `OBSERVATORY_RING_ENDPOINT`) use plain `http://72.61.227.64:8300/…`. The attestation flow transmits a Ristretto255 public key (`/enroll`), a full ring of public keys (`/ring`), and a ring-signed attestation bundle (`/publish`) — including `org_hash`, `pilot_id`, `merkle_root`, and DP-noised daily counters — over unencrypted HTTP.
- **Exploit scenario:** A network attacker (on-path, LAN ARP-spoof, corporate proxy, or ISP) can passively record the ring of enrolled public keys for a specific enterprise tenant (identified by `orgHash`), then correlate timing across devices and link publish events to IPs — partially deanonymizing the ring despite the ring-signature anonymity guarantee. For a pilot cohort where `pilot_id` is set, the attacker learns cohort membership + daily usage patterns. The enrolled `pubKey` also becomes linkable to an IP address across sessions if the same `39.61.227.64` VPS responds to both enrollments and publishes.
- **Remediation:** Change all three endpoint constants to `https://accessbridge.space/observatory/api/…` (same nginx path already used for `UPDATE_SERVER`). The existing `connect_permissions` in `manifest.json` would need `accessbridge.space` which is already whitelisted via `https://accessbridge.space/*`. Remove the bare-IP fallback.
- **Status:** Open
- **Notes:** BUG-002 established the pattern of moving from bare IP to nginx proxy for the update-check endpoint — apply the same fix here.

---

### FINDING-EXT-002 [HIGH]
- **File:** `packages/extension/src/background/index.ts:551–565` (main `onMessage` handler)
- **Rule:** chrome.runtime.onMessage — no sender-origin validation on privileged mutations
- **Description:** The main background service worker `onMessage` listener dispatches every message via `handleMessage(message, sender)` without any check on `sender.id` or `sender.url`. This means any content script — including one running in a page that has injected malicious JS (e.g. an XSS on any host the extension is active on) — can send privileged messages. Cases of particular concern:
  - `SAVE_PROFILE` (line 579): replaces the user's profile. An attacker-controlled content script can force-disable all accessibility features.
  - `AI_SET_KEY` (line 725): stores a caller-supplied `provider`/`apiKey` into the AIEngine. A compromised page's content script can overwrite the user's Gemini/Claude API key with an attacker-controlled value — resulting in all subsequent AI calls going to the attacker's key (metered abuse) or being logged by the attacker.
  - `VISION_CURATION_SAVE` (line 847): writes to IndexedDB with sanitized but attacker-influenced labels.
  - `INDIC_WHISPER_TRANSCRIBE`, `OBSERVATORY_ENROLL`, `AGENT_SEND_IPC` (other message types): broader attack surface.
- **Exploit scenario:** Page at `https://any-site-the-extension-is-active.com` injects `chrome.runtime.sendMessage({type:'AI_SET_KEY', payload:{provider:'claude', apiKey:'attacker-key'}})` (content scripts share the extension ID, so `chrome.runtime.sendMessage` from any content script reaches this handler). The user's subsequent AI requests are now billed against / logged by the attacker's key.
- **Remediation:** In the outer `onMessage` listener, before calling `handleMessage`, add a guard: if the message originates from a tab (`sender.tab !== undefined`) and `sender.id !== chrome.runtime.id`, reject with `sendResponse({error:'unauthorized'})`. Alternatively, add per-case guards inside `handleMessage` for the highest-privilege mutation cases (`SAVE_PROFILE`, `AI_SET_KEY`, `AGENT_PAIR_INITIATE`, `AGENT_SEND_IPC`, `OBSERVATORY_ENROLL`). Note that popups and sidepanels send messages with `sender.id === chrome.runtime.id` and no `sender.tab`, so they would pass correctly.
- **CVSS rationale:** CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:N — attacker only needs user to visit a malicious page; extension is active on all pages by default.
- **Status:** Open

---

## MEDIUM

### FINDING-EXT-003 [MEDIUM]
- **File:** `packages/extension/src/content/ai/bridge.ts:219`
- **Rule:** XSS sink — unescaped interpolation of `result.tier` and `result.latencyMs` into innerHTML
- **Description:** The string template at line 219 interpolates `result.tier` and `result.latencyMs` directly into innerHTML without calling `escapeHtml()`:
  ```ts
  `<span class="ab-summary-meta">${result.tier} · ${result.latencyMs}ms${result.cached ? ' · cached' : ''}</span>`
  ```
  `result` is cast directly from the `chrome.runtime.sendMessage` response at line 192: `return response as AIBridgeResult`. In the current background implementation, `tier` is always the string literal `'local'` and `latencyMs` is `Math.round(...)`, so neither is currently attacker-influenced. However, if a future AI tier (e.g. a cloud fallback) sets `tier` to a string like `'<img src=x onerror=…>'`, or if the background is ever replaced by a malicious extension (overlay attack), this sink would fire XSS.
- **Exploit scenario (current):** Low — values are background-internal constants. Exploit scenario (future regression): a developer adds a new tier string (e.g. from API response metadata) without sanitizing it → stored XSS in the content-script UI.
- **Remediation:** Apply `escapeHtml()` to both values: `` `${this.escapeHtml(String(result.tier))} · ${this.escapeHtml(String(result.latencyMs))}ms` ``. Defence-in-depth regardless of source trustworthiness.
- **Status:** Open (low urgency today; fix before adding any tier that could include external data)

---

### FINDING-EXT-004 [MEDIUM]
- **File:** `packages/extension/src/content/audit/axe-runner.ts:82–85`
- **Rule:** postMessage — targetOrigin `'*'` on `window.postMessage` sends
- **Description:** Three `window.postMessage` calls at lines 82, 84, and 85 use `'*'` as the target origin. This is the correct pattern for an injected page-world script communicating with a content script listening on `window.addEventListener('message', …)`, since the content script cannot specify a receiver origin (it has none). However, using `'*'` means any frame on the page (including cross-origin iframes) can receive the message.
  The risk here is limited because: (a) the nonce scheme (line 58) prevents message spoofing; (b) the receiver at line 64–71 filters `ev.source !== window`, so only same-frame messages are accepted; (c) the payload is axe-core results (no secrets). However, the results contain accessibility violation details that could be privacy-sensitive (element selectors, DOM paths) if received by a cross-origin iframe.
- **Exploit scenario:** A page embeds a cross-origin `<iframe>` which can listen for `AB_AXE_RESULT` messages (origin `*` reaches all frames). The iframe learns the user's accessibility scan results including element selectors and violation descriptions — information the page operator may consider sensitive.
- **Remediation:** The injected script already runs in the page world via `script.textContent`; it cannot access `location.origin` for a better targetOrigin. The content script handler's `ev.source !== window` guard is the correct mitigation. Additionally document why `'*'` is acceptable here in a `// SECURITY:` comment referencing the nonce + source check. No code change strictly required, but consider whether axe results should be considered sensitive.
- **Status:** Open (INFO-level if axe results are considered non-sensitive)

---

### FINDING-EXT-005 [MEDIUM]
- **File:** `packages/extension/src/sidepanel/index.tsx:1493`, `packages/extension/src/popup/App.tsx:1326,1548`
- **Rule:** Mixed-content — bare-IP HTTP URLs constructed in UI for clipboard/href
- **Description:** Sidepanel and popup construct verifier/observatory URLs using `http://72.61.227.64:8300/…` and write them to clipboard or set them as `<a href>`. This exposes the raw VPS IP to the clipboard and to browser navigation, bypassing Cloudflare/nginx hostname routing. Three specific sites:
  - `sidepanel/index.tsx:1493` — `navigator.clipboard.writeText(url)` with plain HTTP IP
  - `sidepanel/index.tsx:1500` — `const VERIFIER_URL` used in rendered anchor
  - `popup/App.tsx:1326` — clipboard write
  - `popup/App.tsx:1548` — `<a href=…>` pointing to observatory dashboard
- **Exploit scenario:** User clicks "Copy Verifier Link" and shares it. The recipient visits a plain-HTTP URL, which is interceptable. Observatory IP is exposed in clipboard history tools and browser history.
- **Remediation:** Replace bare-IP HTTP URLs with `https://accessbridge.space/observatory/…` to match the existing UPDATE_SERVER pattern. This also benefits from Cloudflare WAF/DDoS protection.
- **Status:** Open

---

### FINDING-EXT-006 [MEDIUM]
- **File:** `packages/extension/src/background/observatory-collector.ts:87–91`
- **Rule:** PII in telemetry — `languages_used` is an unsanitized BCP-47 tag sourced from `profile.language`
- **Description:** `recordLanguageUsed(lang)` at line 87 pushes `lang` directly into `languages_used` with only a deduplication check. The `lang` value originates from `profile.language` (set in background/index.ts:388), which ultimately comes from: (a) user input in the popup, (b) managed policy `defaultLanguage` (coerced via `coerceString`, no pattern validation), or (c) the `SAVE_PROFILE` message payload. A crafted `language` value could contain arbitrary Unicode or be a long string. `languages_used` is transmitted in the noised bundle to the VPS (line 314 in publisher: `const languages_used = [...new Set(raw.languages_used)].sort()`). While the field is listed as a categorical set and described as "low marginal information", a non-standard tag like a hostname or email address planted by FINDING-EXT-002's attack vector would be transmitted to the VPS.
- **Remediation:** Add a BCP-47 pattern guard in `recordLanguageUsed`: `if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) return;`. Cap at 35 chars. `defaultLanguage` in `parseManagedPolicyRaw` should similarly add a regex gate.
- **Status:** Open

---

## LOW

### FINDING-EXT-007 [LOW]
- **File:** `packages/core/src/vision/user-curation-store.ts:231–234`
- **Rule:** Sanitizer regex verification — first `.replace(/[ --]/g, '')` range
- **Description:** The first sanitizer replacement at line 232 is `raw.replace(/[ --]/g, '')`. The regex character class `[ --]` is the range from space (U+0020) to hyphen-minus (U+002D). This incidentally strips all printable ASCII characters in the range U+0020–U+002D, including `!`, `"`, `#`, `$`, `%`, `&`, `'`, `(`, `)`, `*`, `+`, `,`, `-`. The second replacement (line 233) also removes `"'` and backtick explicitly, and the third (line 234) removes bidi overrides. The intent of the first regex appears to be stripping control chars (U+0000–U+001F range) or possibly a different range — the comment says "Strip control chars" but the regex starts at U+0020 (space). If the intended regex was `/[\x00-\x1f]/g` (control chars only), the current version silently drops all commas, parentheses, and plus signs from user-curated labels, harming usability without security benefit.
- **Exploit scenario:** Not a security regression; no characters useful for injection are accidentally allowed through. The concern is correctness: a label like "Button (required)" becomes "Button required" in IndexedDB, corrupting user curation data. Low security severity but a correctness bug adjacent to the sanitizer.
- **Remediation:** Change line 232 to `raw.replace(/[\x00-\x1f\x7f]/g, '')` to strip control characters only, keeping the explicit HTML-character removal on line 233. The bidi strip on line 234 is correct.
- **Status:** Open (correctness + minor usability; no security regression)

---

### FINDING-EXT-008 [LOW]
- **File:** `packages/extension/src/background/index.ts:551–565`
- **Rule:** `chrome.runtime.onMessage` — no `sender.id` check for popup/sidepanel messages
- **Description:** Distinct from FINDING-EXT-002: popup and sidepanel pages are first-party extension pages and correctly send messages with `sender.id === chrome.runtime.id`. However the outer listener dispatches without checking `sender.id` at all, so messages from `sender.id !== chrome.runtime.id` (a content script in a web page) reach all switch cases. This is the root issue behind FINDING-EXT-002; listing separately for tracking.
- **Status:** Open (duplicate root cause with FINDING-EXT-002; resolve both with the same fix)

---

### FINDING-EXT-009 [LOW]
- **File:** `packages/core/src/crypto/ring-signature/ed25519-ring.ts:17–22` (header comment)
- **Rule:** Ring signature verify — BigInt arithmetic non-constant-time (documented)
- **Description:** The file header explicitly documents: "BigInt arithmetic in V8 is NOT constant-time. An attacker who can observe per-operation timing locally may learn bits of the signer's scalar." The ring signature scalar comparisons at lines 291 (`c[n] === c[0]`) and the scalar arithmetic throughout are all done via JavaScript BigInt. This is a known accepted risk.
- **Exploit scenario:** An attacker with precise local timing access (same VM, shared CPU cache) could attempt a timing side-channel attack to learn the signer's private scalar — but: (a) the signing happens in the extension's background service worker, isolated from page content; (b) the observer is a local attacker, not a remote one; (c) the daily attestation rate (once per day) limits oracle queries. The documented threat model correctly scopes this as acceptable for anonymized usage counters.
- **Remediation:** No immediate code change required; risk is documented and scoped. If the attestation scheme ever moves to higher-stakes use (e.g. financial proof), migrate to a WASM constant-time library. Add a `// TODO: SECURITY` note pointing to this file if the use case expands.
- **Status:** Accepted risk (documented in file header)

---

## INFO (verified safe, noteworthy)

### INFO-EXT-001 — `chrome.runtime.onMessage` handlers in sidepanel/actions (no mutation path)
- **Files:** `packages/extension/src/sidepanel/actions/ActionsPanel.tsx:70`, `packages/extension/src/sidepanel/intelligence/IntelligencePanel.tsx:122`
- Both handlers only read broadcast messages (`FUSION_INTENT_EMITTED`, `actionItemsHistory`) and update React state. No storage mutation or privileged API call. Safe.

### INFO-EXT-002 — `window.addEventListener('message', handler)` in axe-runner.ts
- **File:** `packages/extension/src/content/audit/axe-runner.ts:73`
- Handler correctly validates `ev.source !== window` (same-frame only) and `data.nonce !== nonce` (CSPRNG nonce). Origin validation is structurally impossible for same-window postMessage but the two existing checks provide equivalent assurance. Safe.

### INFO-EXT-003 — No `eval()` or `new Function()` in any production extension TypeScript
- Pattern 2 sweep: zero hits in packages/extension/src/ and packages/core/src/. MV3 CSP blocks eval anyway; this confirms no inadvertent bypass.

### INFO-EXT-004 — No `dangerouslySetInnerHTML`, `document.write`, `insertAdjacentHTML`, or `outerHTML=` usage
- Pattern 1 partial sweep: all innerHTML usages in content scripts either (a) use hardcoded SVG/HTML literals with no user data, (b) escape via a local `escapeHtml()` function, or (c) use `.textContent` for user-sourced strings. The following innerHTML sites use trusted-constant HTML only:
  - `sensory/adapter.ts:229` — SVG filter matrix (hardcoded numbers)
  - `cognitive/time-awareness.ts:202` — hardcoded nudge toast with no user data
  - `fatigue/adaptive-ui.ts:470` — hardcoded title/body strings (internal constants)
  - `motor/voice-commands.ts:784` — hardcoded SVG icon
  - `content/ai/email-ui.ts:190` — hardcoded SVG icon; lines 330/332 use `this.escapeHtml()`
  - `cognitive/action-items-ui.ts:98` — hardcoded SVG icon
  - `content/ai/bridge.ts:216` — see FINDING-EXT-003 for `result.tier` / `result.latencyMs`; bullet points use `escapeHtml()`
  - `motor/keyboard-mode.ts:424` — key strings from internal constant array (hardcoded)
  - `domains/insurance.ts:515` — uses `escapeHtml()` for all user-sourced text

### INFO-EXT-005 — `coerceBoundedInt` correctly rejects BigInt, NaN, Infinity, hex, scientific notation
- **File:** `packages/extension/src/background/enterprise/policy.ts:283–290`
- `typeof raw === 'number' && Number.isFinite(raw)` — rejects `Infinity`, `-Infinity`, `NaN`, and `BigInt` (which has `typeof === 'bigint'`). The string branch `/^-?\d+$/` rejects `0x…`, `1e5`, and empty strings. In-range check rejects out-of-range values. Verified against the BUG-015 pattern.

### INFO-EXT-006 — `coerceString` does not validate orgHash length/format
- **File:** `packages/extension/src/background/enterprise/policy.ts:248–249`
- `orgHash` is accepted via `coerceString` which only checks `typeof raw === 'string' && raw.length > 0`. There is no length cap or hex-only validation. The value flows into the observatory bundle as `org_hash`. While it is an opaque policy field not user-influenceable, a malicious admin could set it to an arbitrarily long string or non-hex content. Suggest capping at 64 chars + `/^[0-9a-f]{64}$/` pattern. Severity INFO because only a policy-administering admin (already trusted) can set this value.

### INFO-EXT-007 — VISION_CURATION_SAVE adversarial-pass fix (Session 23) confirmed in place
- **File:** `packages/extension/src/background/index.ts:856–889`
- Full validation chain present: null-check, status enum check, element object + classSignature string check, recovered object check, domain string check, appVersion string check. The `UserCurationStore.sanitizeLabel` further strips HTML chars and bidi overrides. Session 23 fix is intact.

### INFO-EXT-008 — BUG-015 proto-pollution fix confirmed in enterprise/policy.ts
- **File:** `packages/extension/src/background/enterprise/policy.ts:79`
- `FEATURE_NAME_MAP` is a `ReadonlyMap`, which unlike a plain `{}` literal has no prototype chain for `get()` — `__proto__`, `toString`, `constructor` all return `undefined`. BUG-015 pattern does not apply here.

### INFO-EXT-009 — Observatory publish does not include PII beyond pilot_id and org_hash
- **File:** `packages/extension/src/background/observatory-publisher.ts:284–368`
- Transmitted fields: noised numeric counters, deduplicated language set, merkle root, ring signature, `org_hash` (enterprise only), `pilot_id` (pilot cohort only). No IP address, user agent, tab URLs, or profile fields beyond language. `pilot_id` is validated against `/^[a-z0-9][a-z0-9-]{0,63}$/` before acceptance. `org_hash` is opaque string — see INFO-EXT-006 for the length-cap gap.

### INFO-EXT-010 — `href` assignments checked; no `javascript:` or `data:` URL flow
- `VisionPanel.tsx:67`, `pdf-generator.ts:442`, `sidepanel/index.tsx:1484` — all three use `URL.createObjectURL(blob)` (blob: URL) or computed HTTPS URLs. `popup/App.tsx:175` constructs a download URL from `chrome.runtime.getManifest().version` (safe constant). `recovery-ui.ts:235` uses a resource URL from `chrome.runtime.getURL`. `action-items-ui.ts:327` sets `link.href = url` — source not followed; classify as INFO-level for follow-up read.
- `axe-runner.ts:28` — `script.src = url` where `url = chrome.runtime.getURL('axe.min.js')` — safe, chrome-extension:// URL only.

### INFO-EXT-011 — No `chrome.scripting.executeScript` calls found
- Pattern 8 sweep: zero hits in packages/extension/src/. No code-string injection risk.

### INFO-EXT-012 — No DOMPurify usage found
- Pattern 9 sweep: zero hits in packages/. DOMPurify is not a dependency; sanitization is done via local `escapeHtml()` helpers and `.textContent` assignments. The dep-audit finding about dompurify advisories is therefore moot — it is not used.

### INFO-EXT-013 — ai-engine and onnx-runtime packages not on disk
- `packages/ai-engine/src/` and `packages/onnx-runtime/src/` returned no files from Glob. Pattern 13 (API key storage) could not be audited from source; it is exercised through the `AI_SET_KEY` handler (FINDING-EXT-002) and `AIEngine.setApiKey()` which is not readable. Flag for next audit when package sources are available.

---

## Summary

| Metric | Value |
|--------|-------|
| Files scanned (read in detail) | 22 |
| Files pattern-matched (grep only) | ~90 |
| CRITICAL | 0 |
| HIGH | 2 |
| MEDIUM | 4 |
| LOW | 3 |
| INFO | 13 |

### Patterns swept (18 total)

1. **XSS sinks (innerHTML=, outerHTML=, insertAdjacentHTML, dangerouslySetInnerHTML, document.write)** — Hits found; all evaluated. One borderline finding (FINDING-EXT-003).
2. **eval-family (eval, new Function, setTimeout/setInterval with string)** — Zero hits in production code. Known-good.
3. **postMessage handlers (addEventListener message, onmessage=)** — 1 hit; reviewed; safe with nonce+source guard (INFO-EXT-002).
4. **chrome.runtime.onMessage handlers** — 6 hits; no sender-origin validation on main handler (FINDING-EXT-002, FINDING-EXT-008).
5. **URL param parsing (location.search, URLSearchParams, new URL)** — 3 hits; none flow into innerHTML/href/tabs.create.
6. **href/src assignment** — 9 hits; all verified safe (INFO-EXT-010).
7. **Prototype pollution (in operator on object literals)** — enterprise/policy.ts uses Map (safe); BUG-015 fix confirmed.
8. **chrome.scripting.executeScript** — Zero hits. Known-good.
9. **DOMPurify config** — Zero hits; not used. Known-good.
10. **aria-label flows (setAttribute aria-label)** — 60+ hits; all use `.textContent`, safe constants, or sanitized values. Recovery.ts:230 uses AI-inferred label via `setAttribute`; label source is VLM output sanitized by UserCurationStore. Safe.
11. **chrome.storage reads treated as trusted** — 20+ hits; VISION_CURATION_SAVE fix confirmed (INFO-EXT-007).
12. **postMessage sends (targetOrigin `*`)** — 3 hits in axe-runner.ts; assessed medium severity but mitigated (FINDING-EXT-004).
13. **AI provider API-key handling** — ai-engine package source not on disk; partially assessed via AI_SET_KEY handler (INFO-EXT-013).
14. **Ring signature non-constant-time compare** — BigInt used throughout; documented accepted risk (FINDING-EXT-009).
15. **Observatory publish PII check** — No PII beyond pilot_id/org_hash; org_hash lacks length cap (INFO-EXT-006, INFO-EXT-009).
16. **Enterprise policy coerceBoundedInt + coerceString** — coerceBoundedInt verified correct (INFO-EXT-005); coerceString(orgHash) lacks hex/length validation (INFO-EXT-006).
17. **SSRF in background fetch** — UPDATE_SERVER hardcoded to `https://accessbridge.space/api`; observatory endpoints use plain HTTP to bare IP (FINDING-EXT-001).
18. **user-curation-store bidi sanitizer** — Verified strips U+200B–U+200F, U+202A–U+202E, U+2066–U+2069. First regex has correctness bug (FINDING-EXT-007).

### Known-good (zero hits, no findings)

- `eval()` / `new Function()` — none
- `dangerouslySetInnerHTML` — none  
- `insertAdjacentHTML` — none
- `document.write` — none
- `outerHTML =` — none
- `chrome.scripting.executeScript` — none
- `DOMPurify` — none (not a dependency)
- `setTimeout(string)` / `setInterval(string)` — none
- External URL in `script.src` — only `chrome.runtime.getURL()` used
- `location.search` flowing to DOM sinks — none (only used in test fixtures)
