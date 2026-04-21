# AccessBridge — Attack Surface Inventory

**Version:** 0.24.0 (Session 26 baseline)
**Date:** 2026-04-22
**Methodology:** System mapping from manifest.json, ARCHITECTURE.md, tauri.conf.json, live VPS topology (reference_infrastructure.md), and findings from four completed audits (semgrep-extension.md, rust-audit.md, vps-audit.md, python-audit.md).

---

## 1. Trust Boundaries

Eight principal trust boundaries govern the system.

| # | Name | Direction of trust | Mechanism | Authentication | Relevant finding / RCA |
|---|------|--------------------|-----------|----------------|------------------------|
| TB-1 | Web page content-script to extension background | Background trusts content scripts running in any origin | `chrome.runtime.sendMessage` | None — any sender.id passes; no origin check on main `onMessage` handler | FINDING-EXT-002 (HIGH): privileged mutations (`SAVE_PROFILE`, `AI_SET_KEY`) reachable from attacker-controlled page script |
| TB-2 | Extension background to popup / sidepanel | Popup/sidepanel trust background for data; background should only accept privileged commands from first-party extension pages | `chrome.runtime.sendMessage` (sender.id === chrome.runtime.id, sender.tab absent) | First-party origin implied but not enforced; root cause of TB-1 | Same fix scope as FINDING-EXT-002 |
| TB-3 | Extension to observatory VPS | Extension trusts VPS responses; VPS trusts signed ring attestation from extension | HTTP POST to `http://72.61.227.64:8300/…` (plain HTTP) | Ristretto255 SAG ring signature + UNIQUE(date, keyImage) double-publish guard | FINDING-EXT-001 (HIGH): plain HTTP exposes attestation material; BUG-002 (precedent for moving to HTTPS proxy) |
| TB-4 | Extension to desktop agent (loopback WS) | Extension and agent mutually authenticate via PSK | WebSocket `ws://127.0.0.1:8901` | `sha256(psk‖nonce)` hex; agent side uses `ring::constant_time::verify_slices_are_equal`; PSK 32 random bytes stored in `pair.key` | FINDING-RUST-003 (MEDIUM): nonce decode silently falls back to empty on malformed base64; FINDING-RUST-001 (HIGH): PSK file written world-readable on third code path |
| TB-5 | Desktop agent Tauri WebView to Rust core | WebView trusts only declared Tauri commands; Rust core exposes four `#[tauri::command]` procedures | Tauri IPC (`@tauri-apps/api/core#invoke`) | Same-process, no external auth; CSP `default-src 'self' tauri: ws://127.0.0.1:* http://127.0.0.1:*` restricts navigations | FINDING-RUST-008 (LOW): `bridge_read_pair_key_b64` reads PSK file without symlink guard |
| TB-6 | VPS nginx edge to internal containers | nginx at :8300 proxies inbound traffic; containers at :8100/:8200 are not directly public | HTTP reverse proxy; Caddy (`ti-platform-caddy-1`, shared) fronts nginx at :8300 with TLS termination | No additional auth at proxy layer; each service validates at application layer | BUG-002 (nginx proxy invariant); FINDING-VPS-001 (HIGH): rate-limit keyed on `127.0.0.1` because `trust proxy` unset |
| TB-7 | Observatory server to extension clients (publish / enroll) | Server trusts ring-signed bundles from enrolled devices | JSON over HTTP POST | Ristretto255 SAG ring signature; `/enroll` stores pubkey; `/publish` verifies signature against enrolled ring; UNIQUE constraint prevents double-publish | FINDING-VPS-001; `requirePilotAdmin` uses `crypto.timingSafeEqual` (confirmed) |
| TB-8 | Enterprise Group Policy / MDM to extension | Extension trusts `chrome.storage.managed` as authoritative and locked | `chrome.storage.managed` read-only (browser-enforced) | Admin writes ADMX/mobileconfig/JSON; Chrome broker enforces managed status | ENT-01: `FEATURE_NAME_MAP` is `ReadonlyMap` (BUG-015 proto-pollution fix confirmed); `orgHash` via `coerceString` lacks hex/length validation (INFO-EXT-006) |

---

## 2. Client-side Surface (Browser Extension)

Source: `packages/extension/manifest.json`, `packages/extension/src/`.

| # | Surface | Entry point | Exposure | Controls | Known findings |
|---|---------|-------------|----------|----------|----------------|
| CS-01 | Content script (`<all_urls>`, `run_at: document_idle`) | `src/content/index.ts` | Runs in every page's isolated world; reads DOM, injects UI, collects behavior signals | Isolated world — no access to page JS heap; MV3 CSP blocks eval | FINDING-EXT-002 root: content scripts can send messages to background with no sender validation |
| CS-02 | Background service worker (MV3, `type: module`) | `src/background/index.ts` | Central message router; hosts AI engine, decision engine, profile store, agent bridge, observatory publisher | `chrome.runtime.onMessage` is the single entry; no persistent connection accepted | FINDING-EXT-002 (HIGH): no `sender.id` guard on main handler; FINDING-EXT-001 (HIGH): plain-HTTP observatory POST |
| CS-03 | Popup (React 18) | `src/popup/index.html` | User-facing toggles, profile sliders, AI key entry, enterprise lockdown banner | First-party extension page; sender.id === runtime.id; enterprise lockdown re-applies on `SAVE_PROFILE` | FINDING-EXT-005 (MEDIUM): bare-IP HTTP URL in clipboard/href (`popup/App.tsx:1326,1548`) |
| CS-04 | Side panel (React 18) | `src/sidepanel/index.html` | Extended dashboard — audit results, AI insights, compliance log, vision lab, agent tab | First-party extension page | FINDING-EXT-005 (MEDIUM): bare-IP HTTP URL in clipboard/href (`sidepanel/index.tsx:1493,1500`) |
| CS-05 | Offscreen document (ONNX inference sandbox) | Instantiated by background; `offscreen` permission | Hosts WASM + ONNX runtime in isolated context; never in content-script bundle (ARCHITECTURE §8c invariant) | Offscreen doc has restricted capabilities; background mediates all I/O | None from current audit |
| CS-06 | Manifest permissions: `activeTab`, `storage`, `offscreen`, `sidePanel`, `downloads`, `alarms` | `manifest.json:6-13` | Standard MV3 permissions; `downloads` allows `chrome.downloads.download()` for PDF/CSV export; `alarms` used for observatory daily scheduler | Each permission is purposeful and documented; no `tabs`, `history`, `webNavigation` | No findings against declared permissions |
| CS-07 | `host_permissions: <all_urls>` | `manifest.json:15-17` | Extension active on all HTTP/HTTPS URLs; content script injects on every page; background can fetch any URL via `fetch()` | Largest footprint permission; required for universal accessibility coverage | TB-1 scope; FINDING-EXT-002 exploitability requires `<all_urls>` injection |
| CS-08 | Extension CSP (`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`) | `manifest.json:52-54` | `wasm-unsafe-eval` required for ONNX WASM runtime; no `unsafe-inline` or `unsafe-eval` for scripts | MV3 enforces this; no `eval()`/`new Function()` found in production code (INFO-EXT-003) | None |
| CS-09 | `web_accessible_resources` (`models/*.onnx`, `ort/*.wasm`, `ort/*.mjs`, `axe.min.js`) | `manifest.json:55-67`; matches `<all_urls>` | ONNX weights, WASM binary, and axe-core readable by any page via `chrome.runtime.getURL()`; `axe.min.js` injected into page MAIN world by axe-runner | Web-accessible resources do not grant page scripts extension API access; `axe.min.js` injection is intentional (A11Y-02) | `axe-runner.ts:28` uses `chrome.runtime.getURL('axe.min.js')` — safe; no external URL in `script.src` (INFO-EXT-010) |
| CS-10 | `chrome.storage.local` (profile, activeFeatures, PSK status) | `src/background/index.ts` storage reads | Stores accessibility profile, feature toggles, agent PSK presence flag; persists across popup close | Readable only by extension; profile merge re-applies managed policy on every `SAVE_PROFILE` | FINDING-EXT-002: attacker-sent `SAVE_PROFILE` can overwrite profile; BUG-005 (state persistence invariant) |
| CS-11 | `chrome.storage.managed` (enterprise policy) | `src/background/enterprise/policy.ts` | Admin-written, browser-enforced; coerced via `coerceBoundedInt` / `coerceString` / `coerceBool` | `FEATURE_NAME_MAP` is `ReadonlyMap` (BUG-015 fix); `coerceBoundedInt` rejects BigInt/NaN/Infinity (INFO-EXT-005) | `orgHash` accepted via `coerceString` without hex/length cap (INFO-EXT-006) |
| CS-12 | `chrome.storage.sync` | Not used in v0.24.0 | — | — | Not a surface; confirmed absent |
| CS-13 | IndexedDB (profile store, audit cache, vision cache, user-curation store) | `packages/core/src/` stores; `content/vision/user-curation-store.ts` | Persistent cross-session storage for ONNX-cached models, vision lab labels, audit history; not synced off-device | Browser-sandboxed to extension origin; no remote access | FINDING-EXT-007 (LOW): sanitizer regex `[ --]` drops printable chars U+0020–U+002D (correctness bug in `user-curation-store.ts:232`) |
| CS-14 | User curation labels (`aria-label` injection) | `content/vision/recovery-ui.ts`, `background/index.ts:856-889` | VLM-inferred or user-edited labels written as `setAttribute('aria-label', …)` on DOM elements | Sanitized via `UserCurationStore.sanitizeLabel`: HTML chars stripped, bidi overrides stripped (Session 23 BUG-023 fix); full validation chain at `background/index.ts:856-889` confirmed (INFO-EXT-007) | FINDING-EXT-007 sanitizer regex correctness gap; Session 23 bidi/enum fix confirmed intact (INFO-EXT-007) |
| CS-15 | IPC to desktop agent (loopback WS) | `src/background/agent-bridge.ts` → `packages/core/src/ipc/client.ts` | Seven background message types surface agent capabilities to popup/sidepanel; PSK stored in `chrome.storage.local` | PSK generated at agent install; `generateNonce(16)` uses `crypto.getRandomValues`; PSK not zeroized on `dispose()` (FINDING-RUST-020 minor) | FINDING-RUST-003 (MEDIUM): malformed nonce silently accepted; FINDING-EXT-002 scope includes `AGENT_SEND_IPC` message |

---

## 3. Desktop Agent Surface (Tauri 2 Rust)

Source: `packages/desktop-agent/src-tauri/tauri.conf.json`, `src-tauri/src/`.

| # | Surface | Entry point | Exposure | Controls | Known findings |
|---|---------|-------------|----------|----------|----------------|
| DA-01 | Tauri WebView (React 18 settings UI) | `packages/desktop-agent/src/App.tsx` | Settings window with 3 tabs; hidden on startup (`visible: false`); shown on tray icon click | Tauri CSP: `default-src 'self' tauri: ws://127.0.0.1:* http://127.0.0.1:*`; no external URL navigations | None |
| DA-02 | Tauri IPC (`#[tauri::command]` procedures) | `src-tauri/src/bridge.rs` | 4 commands: `bridge_agent_info`, `bridge_get_pair_key_path`, `bridge_read_pair_key_b64`, `bridge_get_profile`; invoke only from WebView | Same-process Tauri invoke; no network exposure | FINDING-RUST-008 (LOW): `bridge_read_pair_key_b64` reads PSK file without `refuse_if_symlink` |
| DA-03 | WebSocket listener (axum, `127.0.0.1:8901`) | `src-tauri/src/ipc_server.rs:293` | Accepts connections from extension only; 15 IPC message variants | Bind confirmed to `127.0.0.1` (FINDING-RUST-010 info); single-client semaphore (capacity=1); `sha256(psk‖nonce)` handshake with `ring::constant_time` compare | FINDING-RUST-003 (MEDIUM): nonce `unwrap_or_default()` silently accepts empty nonce; FINDING-RUST-017 (INFO): unbounded `PROFILE_SET` JSON field |
| DA-04 | PSK file at rest | `%LOCALAPPDATA%\AccessBridge\pair.key` (Windows) / `$XDG_RUNTIME_DIR` or `~/.cache/accessbridge/pair.key` (Linux) | 32-byte random PSK generated by `ring::SystemRandom`; JSON-wrapped in `PairKeyFile` | BUG-019 fix uses `OpenOptions::mode(0o600)` — but only on the `write_pair_key_at` path; `load_or_create_psk_via_keyring` fallback uses raw `std::fs::write` (FINDING-RUST-001) | FINDING-RUST-001 (HIGH): `crypto.rs:493` — third occurrence of BUG-017/019 pattern; file written world-readable (`0o644`) on Linux fallback path |
| DA-05 | SQLCipher profile database | `src-tauri/src/profile_store.rs`; `~/.local/share/accessbridge/profile.db` | Encrypted profile store; key from OS keyring primary, file fallback | BUG-017 fix: key file at `0o600`; `open_default()` wires OS keyring | FINDING-RUST-004 (MEDIUM): PRAGMA key formatted as plain `String` on heap — not zeroized, log-adjacent risk; FINDING-RUST-005 (MEDIUM): `ProfileStore::new()` uses fixed `0x42` key — `pub` but not `#[cfg(test)]` gated |
| DA-06 | OS keyring integration | `src-tauri/src/profile_store.rs` (keyring crate) | Master key for SQLCipher stored in OS credential store (Windows Credential Manager / macOS Keychain / Linux Secret Service) | Platform-native protection; file fallback at `0o600` (BUG-017/019) | FINDING-RUST-001 scope (fallback path only) |
| DA-07 | Windows UIA adapter | `src-tauri/src/platform/windows.rs` / `uia/` | Enumerates native windows + elements; `apply()` currently returns `UnsupportedTarget` (Phase 2 DPI shim deferred) | Win32 FFI via `uiautomation` crate; `OpenProcess`/`CloseHandle` balanced (FINDING-RUST-014 confirmed) | FINDING-RUST-007 (LOW): cursor-size `as i32` cast on IPC-supplied value — unvalidated, triggers gsettings error at most |
| DA-08 | macOS NSAccessibility adapter | `src-tauri/src/platform/macos.rs` | Inspects and applies adaptations via AX API; `AXUIElementRef` wrapped in `AxElementRef` | `unsafe impl Send + Sync` on `AxElementRef` — safe while single-client semaphore holds | FINDING-RUST-006 (LOW): `Send+Sync` impl will be unsafe if multi-client added; FINDING-RUST-015 (INFO): CFRelease leak on AX error edge path at line 678 |
| DA-09 | Linux AT-SPI2 adapter | `src-tauri/src/platform/linux.rs`, `linux_caps.rs` | AT-SPI D-Bus enumeration + gsettings font/cursor adaptation | 256-total / 64-per-process / depth-8 / 4096-visit caps on DFS; `run_gsettings` uses `Command::new().args([...])` — no shell injection (FINDING-RUST-013) | FINDING-RUST-002 (MEDIUM): TOCTOU gap between `refuse_if_symlink` and `std::fs::write` in KDE config paths; FINDING-RUST-007 (LOW): integer narrowing on cursor-size |
| DA-10 | Installer packages (MSI / PKG / DEB / RPM / AppImage) | `tauri.conf.json bundle.targets`; `deploy/team/install-*.sh / *.ps1` | Binary distribution surface; TEAM-01/02/03 team installers verify SHA-256 and refuse symlinked targets (BUG-018) | `macOS.signingIdentity: null` — no code signing in v0.24.0; Linux GPG signing deferred (`docs/operations/signing.md`) | No signing = no OS-enforced integrity on installer binary |
| DA-11 | systemd user service (Linux) | `resources/linux/accessbridge.service`; `.deb` file at `/usr/lib/systemd/user/` | Runs agent as user daemon; auto-start on login | `User` service (not system); XDG paths per-user | FINDING-RUST-009 (LOW): `resolve_app_path` warns on symlinked app directory but continues; should refuse |
| DA-12 | launchd user agent (macOS) | `deploy/team/install-macos.sh --install-agent` | Registers plist in `~/Library/LaunchAgents/` | User-scoped; no elevated privileges | No specific findings; same symlink-guard pattern applies |

---

## 4. VPS Backend Surface

Topology: Cloudflare edge (shared) → `ti-platform-caddy-1` (shared, not ours) → `accessbridge-nginx:8300` → internal containers at :8100/:8200.

### 4.1 Service-level overview

| Service | Port (internal) | Stack | Auth model |
|---------|-----------------|-------|------------|
| Cloudflare edge | 443 public | CDN + WAF (shared) | TLS termination; DDoS protection |
| Caddy (`ti-platform-caddy-1`) | shared | Caddy (shared, NOT ours — do not restart) | Routes `accessbridge.space` to nginx:8300 |
| `accessbridge-nginx` | 8300 | nginx | Reverse proxy to api:8100 / observatory:8200 |
| `accessbridge-api` | 8100 | FastAPI (Python, `scripts/vps/main.py`) | None — public read-only |
| `accessbridge-observatory` | 8200 | Node/Express (`ops/observatory/server.js`) | Ring signature (publish/enroll); `PILOT_ADMIN_TOKEN` env var for pilot admin routes |

### 4.2 Endpoint inventory

| Endpoint path | Method | Auth | Rate limit | Known findings |
|---------------|--------|------|------------|----------------|
| `/version` (api:8100) | GET | None | None | Public read-only; FINDING-PY-003 (CORS `*`) |
| `/health` (api:8100) | GET | None | None | — |
| `/updates.xml` (api:8100) | GET | None | None | FINDING-PY-003 |
| `/api/version` (nginx-rewritten) | GET | None | None | Nginx strips `/api` prefix; same as `/version` |
| `/downloads/accessbridge-extension.zip` | GET | None | Cloudflare CDN cache | BUG-010: `?v=` cache-bust required |
| `/downloads/admx-bundle.zip` | GET | None | CDN | WIP artifact (working tree only) |
| `/observatory/` (static dashboard) | GET | None | None | — |
| `/observatory/api/health` | GET | None | None | — |
| `/observatory/api/summary` | GET | None | `rateLimit` (60 req/60s per IP) | FINDING-VPS-001 (HIGH): IP spoofing via XFF |
| `/observatory/api/trends` | GET | None | `rateLimit` | FINDING-VPS-001; FINDING-VPS-002 (MEDIUM): `days` interpolated into SQL (clamped integer — not currently injectable) |
| `/observatory/api/compliance-report` | GET | None | `rateLimit` | FINDING-VPS-001 |
| `/observatory/api/feature-usage` | GET | None | `rateLimit` | FINDING-VPS-004 (LOW): `_featureHidden` plain-object prototype risk in `app.js` |
| `/observatory/api/publish` | POST | Ristretto255 ring signature | `rateLimit` (60 req/60s) | FINDING-VPS-001; body-size 64 KB limit; UNIQUE(date, merkle_root) replay guard |
| `/observatory/api/enroll` | POST | None (first-time enroll) | `enrollRateLimit` (10 req/60s) | FINDING-VPS-001; FINDING-EXT-001: transmitted over plain HTTP from extension |
| `/observatory/api/ring` | GET | None | `rateLimit` | FINDING-EXT-001: ring of public keys transmitted over plain HTTP |
| `/observatory/api/verify/:date` | GET | None | `rateLimit` | — |
| `/observatory/verifier` (static) | GET | None | None | FINDING-VPS-003 (MEDIUM): `keyImage`/`merkleRoot` unescaped in `tr.innerHTML` in `verifier.js:398-403` (not currently exploitable — hex-only values) |
| `/observatory/api/pilot/register` | POST | None | `pilotEnrollRateLimit` (5 req/60s) | FINDING-VPS-001 |
| `/observatory/api/pilot/metrics` | GET | `requirePilotAdmin` (timingSafeEqual) | `rateLimit` | `PILOT_ADMIN_TOKEN` from env; null default = endpoint disabled |
| `/observatory/api/pilot/feedback` | POST | None | `pilotFeedbackRateLimit` (per device_hash or IP) | FINDING-VPS-001 |
| `/observatory/api/pilot/report` | GET | `requirePilotAdmin` | `rateLimit` | — |
| `/observatory/api/observatory/enterprise/summary` | GET | `orgHash` 64-hex query param | None | Returns 501 (stub — ENT-08) |
| `/observatory/api/observatory/enterprise/trends` | GET | `orgHash` 64-hex | None | Returns 501 (stub) |
| `/observatory/api/observatory/enterprise/compliance` | GET | `orgHash` 64-hex | None | Returns 501 (stub) |

### 4.3 Data stores

| Store | Location | Encryption | Access |
|-------|----------|------------|--------|
| Observatory SQLite | `ops/observatory/` (volume mount) | None | Node process only; internal Docker network |
| Enterprise SQLite (stub) | `ops/observatory/` | None | 501 until Session 21 column added |
| Pilot SQLite | `ops/observatory/` | None | Node process only |
| Extension zip + ADMX bundle | `/opt/accessbridge/docs/downloads/` | None (zip) | nginx static serve |

---

## 5. Cryptographic Surfaces

| # | Surface | Algorithm | Implementation | Controls | Gap / Finding |
|---|---------|-----------|----------------|----------|---------------|
| CRYPTO-01 | Profile in-memory / storage encryption | AES-GCM (Web Crypto `SubtleCrypto`) | `packages/core/src/profile/store.ts` | 96-bit random IV per encrypt; browser-native CSPRNG | No findings |
| CRYPTO-02 | Ring signatures (ZK attestation) | SAG / Abe-Ohkubo-Suzuki, Ristretto255 | `packages/core/src/crypto/ring-signature/` — `generateKeypair`, `sign`, `verify`, `deriveKeyImage`, `hashRing`, `buildAttestation`, `verifyAttestation` | UNIQUE(date, keyImage) double-publish guard; 52 TS + 11 Node cross-check tests | FINDING-EXT-009 (LOW): BigInt arithmetic non-constant-time (documented, accepted risk); key image derivation makes signatures linkable within a day (by design) |
| CRYPTO-03 | ChaCha20-Poly1305 + PBKDF2-SHA512 E2EE relay | ChaCha20-Poly1305 + PBKDF2-SHA512 | **GAP — not implemented.** The relay server and relay-encrypted channel appear in architectural plans (ARCHITECTURE §8d "Phase 3 upgrades: encrypted cloud relay") but NO relay server code exists in `ops/`, `packages/`, or the working tree. ChaCha20 in the Cargo.lock is a transitive dependency of `rand_chacha`, not application code. This surface is documented-but-unimplemented. | — | **UNIMPLEMENTED GAP** — mark as "planned, not shipped" until relay server code lands |
| CRYPTO-04 | ONNX model integrity (SHA-256 download verification) | SHA-256 via `crypto.subtle.digest` | `packages/onnx-runtime/src/model-registry.ts` (SHA-256 per entry); `packages/onnx-runtime/src/runtime.ts` (verify on fetch) | Fetch from `http://72.61.227.64:8300/models/*.onnx`; digest compared against registry entry | ARCHITECTURE §8c: "MVP ships with `sha256: null` on every entry" — SHA-256 pinning present in code structure but hash values are null; model integrity is NOT enforced until hashes are populated; transmitted over plain HTTP (same-IP exposure as TB-3) |
| CRYPTO-05 | TLS (all HTTPS endpoints) | TLS 1.2+ via Let's Encrypt / Cloudflare | Cloudflare edge + Caddy termination | External to our code | — |
| CRYPTO-06 | PSK handshake (loopback WS) | SHA-256 (`sha256(psk‖nonce)`), `ring::constant_time` | `packages/core/src/ipc/handshake.ts`; `src-tauri/src/ipc_server.rs:271-276`; `src-tauri/src/crypto.rs:78-80` | Constant-time compare confirmed (FINDING-RUST-011); fresh nonce from `crypto.getRandomValues` (16 bytes) | FINDING-RUST-003 (MEDIUM): server `unwrap_or_default()` silently uses empty nonce on malformed base64; no server-side nonce replay set |
| CRYPTO-07 | SQLCipher master key | AES-256-CBC (SQLCipher 4 compat) | `src-tauri/src/profile_store.rs`; key from OS keyring | `0o600` file fallback (BUG-017/019 fixes); `open_default()` path correct | FINDING-RUST-004 (MEDIUM): PRAGMA key as plain `String` — zeroize gap; FINDING-RUST-005 (MEDIUM): `ProfileStore::new()` with fixed `0x42` key is `pub` without `#[cfg(test)]`; FINDING-RUST-001 (HIGH): PSK fallback write path world-readable |

---

## 6. External Integrations and Untrusted Inputs

| # | Integration / Input | Entry point | Trust level | Controls | Known findings |
|---|---------------------|-------------|-------------|----------|----------------|
| EXT-01 | Gemini Flash API (user-supplied key) | `packages/ai-engine/src/providers/gemini.ts`; stored via `AI_SET_KEY` background message | User-provided key; remote service | Cost tracker + daily budget; tier downgrade on overspend; FINDING-EXT-002: key can be overwritten by attacker-controlled content script | FINDING-EXT-002 (HIGH) |
| EXT-02 | Claude Sonnet API (user-supplied key) | `packages/ai-engine/src/providers/claude.ts`; same `AI_SET_KEY` path | Same as EXT-01 | Same controls | FINDING-EXT-002 (HIGH) |
| EXT-03 | Chrome managed policy (`chrome.storage.managed`) | `src/background/enterprise/policy.ts` | Admin-controlled, browser-enforced; treated as trusted-but-validated | `ReadonlyMap` for feature names (BUG-015); `coerceBoundedInt`/`coerceBool`/`coerceString`; re-applies on every `SAVE_PROFILE` | `orgHash` coerced without hex/length validation (INFO-EXT-006) |
| EXT-04 | ONNX model weights (VPS CDN fetch) | `packages/onnx-runtime/src/runtime.ts`; fetched from `http://72.61.227.64:8300/models/*.onnx` | Operator-controlled CDN | SHA-256 integrity check in code, but all registry `sha256` values are `null` in MVP — integrity NOT enforced | CRYPTO-04 gap; plain HTTP fetch |
| EXT-05 | HuggingFace model downloads (build-time tools) | `tools/prepare-models/download-*.py` | Third-party CDN | `--revision` flag present in `download-moondream.py` (correct); absent in two others | FINDING-PY-001 (MEDIUM): HF revision not pinned in `download-hf-models.py` and `download-indicwhisper.py`; FINDING-PY-002 (MEDIUM): SHA-256 computed but not verified against expected value |
| EXT-06 | Website DOM (content script encounters arbitrary HTML) | All content script modules (`src/content/`) | Untrusted | `escapeHtml()` used at all user-data innerHTML sinks (INFO-EXT-004); `textContent` for user-sourced strings; no `eval()` or `new Function()` | FINDING-EXT-003 (MEDIUM): `result.tier` and `result.latencyMs` unescaped in `content/ai/bridge.ts:219` |
| EXT-07 | Observatory / pilot JSON payloads (extension → VPS) | `packages/extension/src/background/observatory-publisher.ts`; `POST /api/publish`, `/api/enroll`, `/api/pilot/feedback` | Extension-supplied; server-side validated | `validateBundle` enforces `FEATURE_NAMES`, `ADAPTATION_TYPES`, `DOMAIN_NAMES`, `LANGUAGE_CODES` allowlists; body-size 64 KB limit; UNIQUE constraints | FINDING-EXT-006 (MEDIUM): `languages_used` includes unsanitized BCP-47 tag from `profile.language` — no pattern validation before transmission |
| EXT-08 | AT-SPI D-Bus (Linux desktop accessibility tree) | `src-tauri/src/platform/linux.rs` via `atspi` / `zbus` | OS-supplied; treated as potentially adversarial | 256/64/4096 enumeration caps; `child_count.min(128)` (FINDING-RUST-018 confirmed) | No findings |

---

## 7. Known-Unknown Gaps

**GAP-01 — Feature #4 E2EE Relay (ChaCha20-Poly1305): documented but unimplemented.**
ARCHITECTURE §8d lists "encrypted cloud relay" as a Phase 3 upgrade for cross-device profile sync. No relay server code exists in `ops/`, `packages/`, or the working tree (grep for `relay`, `chacha`, `PBKDF2` in application source returns zero production hits). ChaCha20 appears only in `Cargo.lock` as a transitive dependency of `rand_chacha`. This surface should be treated as unshipped until relay server code lands in `ops/relay/` or equivalent. At that point it will require a new trust boundary entry (TB-9) and security review before deployment.

**GAP-02 — ONNX model SHA-256 hashes unpopulated.**
`packages/onnx-runtime/src/model-registry.ts` has `sha256: null` for all three canonical models per ARCHITECTURE §8c ("MVP ships with `sha256: null` on every entry — populate when real weights upload"). Until these are populated, the model integrity check in `runtime.ts` is effectively disabled, and model weights fetched from plain HTTP are unverified.

**GAP-03 — Session 24/25 WIP artifacts partially uncommitted.**
`deploy/team/`, `tools/pilot/`, `ops/observatory/public/pilot.*`, `packages/extension/src/sidepanel/pilot/`, `packages/desktop-agent/src-tauri/gen/` appear in `git status` as untracked. These include install scripts (TEAM-01–TEAM-04), pilot CLI tools (TEAM-09/10), and new observatory routes (TEAM-06/07). The audit above covers the content visible on disk; committed vs. WIP status does not change the attack surface of the running system.

**GAP-04 — Chrome Web Store submission pending.**
Extension is sideloaded or force-installed via ADMX; not distributed via the Chrome Web Store in v0.24.0. CWS submission and Manifest V3 compliance review are deferred. Once submitted, Google's review process adds a review-time trust boundary that is currently absent.

**GAP-05 — Desktop agent code signing absent.**
`tauri.conf.json: macOS.signingIdentity: null`. No Authenticode (Windows MSI), Apple notarization, or Linux GPG signing in place. OS-level installer integrity checks are therefore absent for all three platforms. See `docs/operations/signing.md`.

**GAP-06 — dep-audit-report.md and secrets-scan.md not yet produced.**
These documents are listed in §9 as coming. The dependency audit raw data (`docs/security/deps-node-raw.json`, `docs/security/cargo-audit.json`) and secrets scan output (`docs/security/detect-secrets-all.json`) are on disk but have not been triaged into a human-readable audit report.

---

## 8. Summary Table

| Boundary / Component | Count |
|----------------------|-------|
| Trust boundaries (§1) | 8 |
| Client-side extension surfaces (§2) | 15 |
| Desktop agent surfaces (§3) | 12 |
| VPS backend endpoints (§4) | 22 routes + 3 data stores |
| Cryptographic surfaces (§5) | 7 |
| External integrations / untrusted inputs (§6) | 8 |
| Known-unknown gaps (§7) | 6 |
| **Total enumerated surfaces** | **78** |

### Finding cross-reference by severity

| Severity | Findings cited in this document |
|----------|---------------------------------|
| HIGH | FINDING-RUST-001, FINDING-EXT-001, FINDING-EXT-002, FINDING-VPS-001 |
| MEDIUM | FINDING-RUST-002, FINDING-RUST-003, FINDING-RUST-004, FINDING-RUST-005, FINDING-EXT-003, FINDING-EXT-004, FINDING-EXT-005, FINDING-EXT-006, FINDING-VPS-002, FINDING-VPS-003, FINDING-PY-001, FINDING-PY-002, FINDING-PY-003, FINDING-PY-004 |
| LOW | FINDING-RUST-006 through FINDING-RUST-009, FINDING-EXT-007 through FINDING-EXT-009, FINDING-VPS-004, FINDING-PY-005 through FINDING-PY-007 |
| INFO | FINDING-RUST-010 through FINDING-RUST-020, INFO-EXT-001 through INFO-EXT-013, FINDING-VPS-005 |

---

## 9. References

| Document | Path / URL |
|----------|-----------|
| Feature catalog | `FEATURES.md` |
| System architecture | `ARCHITECTURE.md` |
| Manifest | `packages/extension/manifest.json` |
| Tauri config | `packages/desktop-agent/src-tauri/tauri.conf.json` |
| Extension TypeScript audit | `docs/security/semgrep-extension.md` |
| Rust / desktop agent audit | `docs/security/rust-audit.md` |
| VPS observatory audit | `docs/security/vps-audit.md` |
| Python API + tooling audit | `docs/security/python-audit.md` |
| Dependency audit report | `docs/security/dep-audit-report.md` _(coming)_ |
| Secrets scan | `docs/security/secrets-scan.md` _(coming)_ |
| Cargo audit raw | `docs/security/cargo-audit.json` |
| Node deps raw | `docs/security/deps-node-raw.json` |
| Secrets scan raw | `docs/security/detect-secrets-all.json` |
| VPS infrastructure memory | `~/.claude/projects/e--code-AccessBridge/memory/reference_infrastructure.md` |
| Bug fix log | `RCA.md` |
| Ring signature docs | `docs/features/zero-knowledge-attestation.md` |
| Desktop agent docs | `docs/features/desktop-agent.md` |
| ONNX model docs | `docs/features/onnx-models.md` |
| Desktop agent signing plan | `docs/operations/signing.md` |
