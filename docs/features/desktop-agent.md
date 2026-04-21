# Desktop Agent (Sessions 19 + 21)

**Status:** Session 19 (2026-04-21) shipped the Windows MVP. **Session 21 (2026-04-21) added cross-platform parity — see [desktop-agent-macos.md](desktop-agent-macos.md) for the macOS adapter + NSAccessibility integration; a Linux AT-SPI stub; a SQLCipher-backed persistent profile store replacing the in-memory Session-19 stub; OS-keyring-backed master-key management; a cross-platform accessibility-permission module; and a GitHub Actions matrix build producing Windows MSI + macOS DMG/PKG artifacts. The original MVP below remains accurate for Session 19 behaviour; Session 21 layered on top without breaking the wire protocol or the PSK handshake.**

---

**Status (original Session 19):** MVP shipped in Session 19 (2026-04-21). Windows only.
**Code (Rust):** [`packages/desktop-agent/src-tauri/src/`](../../packages/desktop-agent/src-tauri/src/)
**Code (TS client):** [`packages/core/src/ipc/`](../../packages/core/src/ipc/)
**Code (extension bridge):** [`packages/extension/src/background/agent-bridge.ts`](../../packages/extension/src/background/agent-bridge.ts)
**Styling invariants:** See [UI_GUIDELINES.md](../../UI_GUIDELINES.md) for canonical color tokens, spacing (4 px grid), radius, and shadow values used in the settings window.

---

## 1. Overview

The AccessBridge Desktop Agent extends the browser extension's reach into native Windows applications. It is a Tauri 2 Rust binary that runs as a system-tray process on the user's machine, exposes Windows UI Automation (UIA) element inspection to the extension, and maintains a synchronized copy of the user's accessibility profile. The extension communicates with the agent over a loopback-only WebSocket; a pre-shared key (PSK) is required before any message is exchanged. If the agent is absent or the PSK is not configured the extension continues to work exactly as before — the pairing is strictly opt-in and the graceful-degradation path is a load-bearing invariant.

---

## 2. MVP Scope (Session 19)

**What was shipped:**

- Tauri 2 Rust binary scaffold: system-tray icon, settings window (React 18 frontend, three tabs: Overview / Profile / Logs).
- Axum WebSocket server bound to `127.0.0.1:8901/agent`; enforces a PSK-hash handshake before any other message is processed.
- Full IPC protocol: 15 message variants covering HELLO handshake, profile CRUD, UIA inspect, adaptation apply/revert, ping/pong, and error. TypeScript (discriminated union) and Rust (serde tagged enum) mirrors in sync.
- `AgentClient` TypeScript class (`packages/core/src/ipc/client.ts`) with exponential back-off reconnect, per-request timeout, and push subscription for `PROFILE_UPDATED`.
- `AgentBridge` singleton (`packages/extension/src/background/agent-bridge.ts`) wrapping `AgentClient`; PSK stored in `chrome.storage.local`; status persisted across SW suspension.
- Windows UIA dispatcher (`packages/desktop-agent/src-tauri/src/uia/`): inspects element trees via the `uiautomation` crate; adaptation applier is present but see limitation below.
- Cross-surface profile sync foundation: `ProfileStore` (tokio broadcast channel); extension pushes on connect and on `SAVE_PROFILE`; agent pushes `PROFILE_UPDATED` when the profile changes from another source.
- PSK generation at first run (`ring::SystemRandom`); persisted to `%LOCALAPPDATA%\AccessBridge\pair.key`; loaded on subsequent starts.
- 42+ Rust inline tests (ipc_protocol · ipc_server · crypto · profile_store · filters); 19+ in `ipc_protocol`, 16+ in `crypto`.

**What does NOT work yet:**

- **Per-process DPI font scaling is not implemented.** The `adapter.rs` function `apply_process_dpi()` returns `UiaError::Platform("per-process DPI override requires a shim DLL (Phase 2 feature)")` for both `font-scale` and `process-dpi` adaptation kinds. `SetProcessDpiAwarenessContext` only operates on the current process; true per-app DPI scaling requires DLL injection into the target process, which is out of scope for Phase 1. The extension will receive `ADAPTATION_APPLY_RESULT` with `ok: false` and the reason string, and should surface "Native font scaling: not yet supported — use the browser Sensory adapter instead."
- Settings window is read-only in MVP (profile edits from the settings window are Phase 2; the WS push path is wired but the Tauri → profile-store write is deferred).
- macOS and Linux dispatchers are no-op stubs (`packages/desktop-agent/src-tauri/src/uia_stub.rs`).
- MSI installer is configured (`WiX`) but is not built in CI — the CI image does not have Rust + MSVC + WiX installed.
- AES-GCM payload encryption is implemented in `crypto.rs` but unused in MVP; the handshake hash is sent in plaintext over the loopback socket (defense-in-depth rationale: loopback + PSK gate already prevents remote access; encryption reserved for future messages that carry locally sensitive content).

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ Chrome Extension (MV3)                                               │
│                                                                      │
│  Background SW                                                       │
│  ┌──────────────────────┐         ┌──────────────────────┐          │
│  │ AgentBridge          │ wraps   │ AgentClient          │          │
│  │ (agent-bridge.ts)    │────────▶│ (core/ipc/client.ts) │          │
│  │ PSK ← storage.local  │         │ WS + PSK handshake   │          │
│  │ status ← storage     │         │ exponential reconnect │          │
│  │ profile push/pull    │         │ request/response map  │          │
│  └──────────┬───────────┘         └───────────┬──────────┘          │
│             │                                  │ ws://127.0.0.1:8901 │
└─────────────┼──────────────────────────────────┼────────────────────┘
              │ 7 background message types        │ WebSocket (loopback)
              ▼                                   ▼
  Popup / Sidepanel UI                ┌───────────────────────────────┐
  (pair dialog, status badge,         │ Desktop Agent (Tauri 2 / Rust)│
   Native Apps tab)                   │                               │
                                      │ ipc_server::serve()           │
                                      │  axum WS · PSK handshake      │
                                      │  1-client gate (Semaphore)    │
                                      │  dispatch() → profile/UIA     │
                                      │                               │
                                      │ uia::WindowsUiaDispatcher     │
                                      │  inspect() → UIA element tree │
                                      │  apply()  → UnsupportedTarget │
                                      │                               │
                                      │ ProfileStore (in-memory)      │
                                      │  tokio broadcast channel      │
                                      │                               │
                                      │ Tauri UI (React 18)           │
                                      │  Overview / Profile / Logs    │
                                      │  4 invoke commands            │
                                      │                               │
                                      │ System-tray icon              │
                                      └───────────────────────────────┘
```

**Component summary:**

| Component | Location | Role |
|-----------|----------|------|
| `AgentClient` | `packages/core/src/ipc/client.ts` | Typed WS client; PSK handshake; reconnect; push subscription |
| `AgentBridge` | `packages/extension/src/background/agent-bridge.ts` | SW singleton; chrome.storage.local PSK + status; profile sync callbacks |
| IPC protocol (TS) | `packages/core/src/ipc/types.ts` | Discriminated union of 15 `AgentMessage` variants |
| IPC protocol (Rust) | `packages/desktop-agent/src-tauri/src/ipc_protocol.rs` | Serde-tagged enum mirroring the TS types; 19+ inline tests |
| WS server | `packages/desktop-agent/src-tauri/src/ipc_server.rs` | axum; 127.0.0.1:8901; 1-client gate; dispatch loop |
| Crypto | `packages/desktop-agent/src-tauri/src/crypto.rs` | PSK type; `psk_hash()`; `constant_time_eq()`; AES-GCM helpers |
| UIA dispatcher (Windows) | `packages/desktop-agent/src-tauri/src/uia/` | `WindowsUiaDispatcher` (inspect works; apply returns UnsupportedTarget) |
| UIA stub (non-Windows) | `packages/desktop-agent/src-tauri/src/uia_stub.rs` | No-op; returns empty element list |
| Profile store | `packages/desktop-agent/src-tauri/src/profile_store.rs` | In-memory store with tokio broadcast for push notifications |
| Tauri bridge commands | `packages/desktop-agent/src-tauri/src/bridge.rs` | `bridge_agent_info`, `bridge_get_pair_key_path`, `bridge_read_pair_key_b64`, `bridge_get_profile` |
| Settings window | `packages/desktop-agent/src/App.tsx` | React 18; Overview / Profile / Logs tabs |
| Tray | `packages/desktop-agent/src-tauri/src/tray.rs` | System-tray icon installation |
| Entry wiring | `packages/desktop-agent/src-tauri/src/lib.rs` | Assembles PSK + store + dispatcher; spawns tokio runtime; boots Tauri |

---

## 4. IPC Protocol Reference

All frames are JSON text. The `type` field is SCREAMING_SNAKE_CASE and acts as the discriminator. All other field names are camelCase on the wire. The TypeScript definition is the authoritative source; the Rust `AgentMessage` enum is a verified serde mirror.

| # | `type` | Direction | Key payload fields | Notes |
|---|--------|-----------|-------------------|-------|
| 1 | `HELLO` | Client → Server | `agent: AgentInfo`, `pskHash: string` (hex SHA-256), `nonce: string` (base64url) | First frame on connect; must arrive before any other message |
| 2 | `HELLO_ACK` | Server → Client | `pskOk: boolean`, `server: AgentInfo` | Server sends regardless of PSK outcome; client disconnects if `pskOk: false` |
| 3 | `PROFILE_GET` | Client → Server | `requestId: string` | Fetch current profile from agent store |
| 4 | `PROFILE_SET` | Client → Server | `requestId: string`, `profile: unknown` (JSON) | Overwrite agent's profile; echoed back as `PROFILE_RESULT` |
| 5 | `PROFILE_RESULT` | Server → Client | `requestId: string`, `profile: unknown` | Response to `PROFILE_GET` or `PROFILE_SET` |
| 6 | `PROFILE_UPDATED` | Server → Client | `profile: unknown` | Server push; no `requestId`; fired when profile changes from another source (e.g. settings window edit — Phase 2) |
| 7 | `UIA_INSPECT` | Client → Server | `requestId: string`, `target?: NativeTargetHint` | List native elements matching target hint; omit `target` for all top-level windows |
| 8 | `UIA_ELEMENTS` | Server → Client | `requestId: string`, `elements: NativeElementInfo[]` | Response to `UIA_INSPECT` |
| 9 | `ADAPTATION_APPLY` | Client → Server | `requestId: string`, `target: NativeTargetHint`, `adaptation: Adaptation` | Apply an adaptation (font-scale, contrast, etc.) to a native target |
| 10 | `ADAPTATION_APPLY_RESULT` | Server → Client | `requestId: string`, `adaptationId: string`, `ok: boolean`, `reason?: string` | `ok: false` + `reason` for unsupported targets (e.g. DPI shim not present) |
| 11 | `ADAPTATION_REVERT` | Client → Server | `requestId: string`, `adaptationId: string` | Undo a previously applied adaptation |
| 12 | `ADAPTATION_REVERT_RESULT` | Server → Client | `requestId: string`, `ok: boolean` | Revert confirmation |
| 13 | `PING` | Client → Server | `requestId: string` | Keep-alive / latency check |
| 14 | `PONG` | Server → Client | `requestId: string` | Response to PING; same `requestId` echoed |
| 15 | `ERROR` | Server → Client | `requestId?: string`, `code: string`, `message: string` | Protocol error; `requestId` present only when the error is in response to a specific request |

**Supporting types (camelCase on the wire):**

```
AgentInfo        { version, platform, capabilities: string[] }
NativeTargetHint { processName?, windowTitle?, className?, elementName?, automationId? }
NativeElementInfo{ processName, windowTitle, className, automationId, controlType, boundingRect }
Rect             { x, y, width, height }
Adaptation       { id, kind, value: JSON }
```

**Known ERROR codes:** `PSK_MISMATCH`, `PARSE_ERROR`, `HANDSHAKE_EXPECTED`, `PORT_IN_USE`, `UNKNOWN_MESSAGE`.

---

## 5. Pairing Flow and PSK

### PSK generation (agent side)

On first run, `ipc_server::load_or_create_pair_key()` checks `%LOCALAPPDATA%\AccessBridge\pair.key`. If the file is absent it generates 32 random bytes via `ring::rand::SystemRandom` (cryptographically secure), wraps them in a `PairKeyFile { version: 1, createdAt, pskB64 }` JSON object, and writes the file. On Unix the file mode is set to `0o600`; on Windows the file inherits the current user's ACL. Subsequent runs load and parse the existing file; `PairKeyFile::is_valid()` rejects unknown version numbers or wrong key lengths.

### Extension side

The user opens the extension popup, navigates to Settings → "Pair with Desktop Agent", and pastes the base64url-encoded PSK from `%LOCALAPPDATA%\AccessBridge\pair.key` (or from `bridge_read_pair_key_b64` invoked by the settings window when the agent is locally installed). The PSK is stored in `chrome.storage.local` under key `agentPairKeyB64`. `AgentBridge.setPskFromBase64()` triggers an immediate reconnect.

### Handshake sequence

```
Client (extension)                         Server (agent)
─────────────────────────────────────────────────────────
  1. Open WS to ws://127.0.0.1:8901/agent
  2. Generate nonce (16 random bytes, base64url)
  3. Compute pskHash = sha256(psk_bytes || nonce_bytes), hex-encode
  4. Send HELLO { agent, pskHash, nonce }
                                         5. Receive HELLO; decode nonce from base64url
                                         6. Compute expected = hex(sha256(server_psk || nonce_bytes))
                                         7. constant_time_eq(expected, pskHash) → pskOk
                                         8. Send HELLO_ACK { pskOk, server }
  9. If pskOk == false → disconnect
 10. Mark state = 'connected'
```

The `constant_time_eq` call on the server uses `ring::constant_time::verify_slices_are_equal`, which prevents timing-oracle attacks that could leak the PSK through comparison timing.

The server binds exclusively to `127.0.0.1` (see `ipc_server.rs` line `SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT))`). There is no code path that binds to `0.0.0.0`.

The server enforces a single-client gate via a `tokio::sync::Semaphore` with 1 permit. A second connection attempt receives `ERROR { code: "PORT_IN_USE" }` and is closed immediately.

---

## 6. Cross-Surface Profile Sync

**Strategy:** last-write-wins on `profile.updatedAt`. The in-memory `ProfileStore` in the agent holds the latest `serde_json::Value`; a tokio `broadcast::channel` notifies the active WS session whenever the profile changes from a non-WS source (settings window — Phase 2).

**Extension → Agent (push on save):**
When `AgentBridge.start()` completes and the connection is established, the bridge immediately calls `client.setProfile(localProfile)` to push the extension's current profile. Thereafter `AgentBridge.syncProfileOut(profile)` is called on each `SAVE_PROFILE` message. This is fire-and-forget; failure is logged but not surfaced to the user.

**Agent → Extension (push on edit):**
The WS session loop uses `tokio::select!` to multiplex incoming frames with profile-update notifications from the broadcast channel. When a `PROFILE_UPDATED` notification arrives, the session sends `PROFILE_UPDATED` to the connected extension client. `AgentClient.onPushFromAgent()` delivers this to `AgentBridge`, which calls the `onProfilePushFromAgent` callback wired at SW startup.

**Settings window edits (Phase 2):** The Tauri settings window currently displays the profile as read-only. A future session will add an edit surface that writes through the `ProfileStore`, which will then broadcast `PROFILE_UPDATED` to the connected extension session automatically — the WS session loop is already subscribed.

**Graceful degradation:** if `opts.psk` is absent, `AgentClient.connect()` returns immediately without connecting. All `AgentBridge` methods that call the client first check `this.client?.isConnected()` and return safe empty values when the agent is absent (`[]` for `listNativeWindows`, `{ ok: false }` for `applyNativeAdaptation`, etc.).

---

## 7. Privacy Invariants

- The WS listener binds to `127.0.0.1` only. No frame ever leaves the machine.
- PSK gates every inbound connection. An unauthenticated connection receives `HELLO_ACK { pskOk: false }` and is closed.
- The PSK is never logged. The `Psk` struct's `Debug` impl emits `Psk(<redacted>)`.
- AES-GCM payload encryption is implemented (`encrypt_payload` / `decrypt_payload` in `crypto.rs`) but not applied to MVP frames. The loopback binding + PSK gate are judged sufficient for Session 19; per-frame encryption is reserved for messages that carry content a local packet-sniffer should not read (Phase 2).
- No PII is logged. The agent logs connection events (`client connected`, `handshake OK`, `client disconnected`) and PSK-mismatch nonces; it never logs profile contents or element names.
- No telemetry additions. The agent does not add any new counters to the Compliance Observatory pipeline.
- No new Chrome extension permissions. The agent is a peer process, not a browser-granted capability. No new `permissions` or `host_permissions` were added to `manifest.json`.

---

## 8. Installation

**Prerequisites** (see [`packages/desktop-agent/README.md`](../../packages/desktop-agent/README.md) for detailed commands):

- Rust stable toolchain + `x86_64-pc-windows-msvc` target
- Visual Studio Build Tools 2022 (Desktop development with C++ workload)
- WiX Toolset v4 (`dotnet tool install --global wix`)
- WebView2 Runtime (pre-installed on Windows 11; downloadable for Windows 10)

**Build the MSI:**

```bash
pnpm --filter @accessbridge/desktop-agent tauri:build
# Output: packages/desktop-agent/src-tauri/target/release/bundle/msi/*.msi
```

**Install:**

1. Run the MSI. SmartScreen will show a warning because the binary is self-signed — click **More info → Run anyway**.
2. The agent starts automatically and appears in the system tray.
3. Open the settings window (click the tray icon) and copy the PSK from the **Overview** tab.
4. In the Chrome extension popup → Settings → "Pair with Desktop Agent", paste the PSK and click **Pair**.
5. The status badge should change to "Connected". If it shows "Pairing…" for more than a few seconds, see the Troubleshooting section below.

---

## 9. Uninstallation

1. Remove via **Windows Settings → Apps → Installed apps → AccessBridge Desktop Agent → Uninstall**.
2. To fully remove the PSK (recommended before reinstalling or transferring to a new machine), also delete the directory `%LOCALAPPDATA%\AccessBridge\` manually. The MSI uninstaller does not remove this directory to avoid data loss if the user reinstalls.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Port 8901 already in use | Another process is bound to 8901 | Run `netstat -ano \| findstr :8901` to identify the PID; stop that process or change the port in `ipc_server.rs` and rebuild |
| Status stuck at "Pairing…" | PSK mismatch — extension has a stale or incorrect PSK | Re-copy the PSK from the agent settings window and re-paste in the extension popup |
| "Unable to read pair key" | `%LOCALAPPDATA%\AccessBridge\pair.key` has wrong permissions or was deleted | Delete the file and restart the agent; it will regenerate a new PSK |
| Pairing loop (connects then immediately disconnects) | PSK file is corrupt (wrong base64 length or invalid version) | Delete `%LOCALAPPDATA%\AccessBridge\pair.key` and restart the agent; clear the PSK in the extension via Settings → "Unpair" |
| "Native font scaling: not yet supported" | `apply_process_dpi` returns `UnsupportedTarget` — the DPI shim DLL is not present | Expected in MVP. Use the browser Sensory adapter for font scaling; native DPI scaling is Phase 2 |
| Agent not visible in tray | Tauri startup error (likely missing WebView2 on Windows 10) | Install the WebView2 Runtime from the Microsoft link in the prerequisites |
| `tauri build` fails with WiX error | WiX not on PATH | Run `wix --version`; if not found, run `dotnet tool install --global wix` in a new terminal |

---

## 11. Phase 2 Roadmap

The following capabilities are explicitly deferred:

| Item | Detail |
|------|--------|
| Per-process DPI shim DLL | `SetProcessDpiAwarenessContext` only works on the current process. A shim DLL injected into the target process (or a dedicated host process with DLL injection) is required. The adapter stub and `RevertToken::DpiScale` type are already wired; only the injection layer is missing. |
| macOS NSAccessibility dispatcher | `uia_stub::StubDispatcher` will be replaced with an AXUIElement-based adapter. `#[cfg(target_os = "macos")]` guards are already in place. |
| Linux AT-SPI dispatcher | Same stub path; AT-SPI2 via the `atspi` crate. |
| Settings window profile editing | The Profile tab is read-only in MVP. Adding a write path through `ProfileStore` triggers the existing `PROFILE_UPDATED` broadcast automatically. |
| SQLCipher persistent profile | The in-memory `ProfileStore` will be replaced with an encrypted SQLite store (SQLCipher via `rusqlite + sqlcipher`) so the profile survives agent restarts without an extension round-trip. |
| Rich UIA inspection | The current inspector returns top-level windows. Phase 2 will walk the UIA element tree to return the full control hierarchy. |
| Code signing | The MSI will be signed with a cross-signed EV certificate to eliminate the SmartScreen warning. |
| Auto-update | Tauri's built-in updater will be configured to check `https://accessbridge.space/api/version` and apply delta updates. |
| Cloud relay for multi-device sync | End-to-end-encrypted relay (via the existing VPS API port) to sync profiles between a user's multiple machines without requiring direct network reachability. |

---

## 12. Testing

### Rust inline tests

Located in each source module as `#[cfg(test)] mod tests { … }`. Not yet wired into CI because the CI image does not have Rust + MSVC installed. To run locally:

```bash
cd packages/desktop-agent/src-tauri
cargo test
```

| Module | Approximate test count | What is covered |
|--------|----------------------|-----------------|
| `ipc_protocol` | 19 | Round-trip serde for all 15 message variants; camelCase wire names; type discriminator values; error paths (malformed JSON, unknown type, missing required field) |
| `ipc_server` | ~11 | `dispatch()` for all routed messages; PSK hash correct/wrong; profile get/set; ping/pong; UIA inspect routing; adaptation apply success/failure |
| `crypto` | 16 | PSK generate/base64/wrong-length; `psk_hash` determinism and nonce/key sensitivity; `constant_time_eq`; `PairKeyFile` round-trip/version/length/malformed; AES-GCM encrypt/decrypt/tamper/wrong-AAD/wrong-key/short-input/unique-nonce |
| `profile_store` | 4 | Empty initial state; set-then-get; broadcast receive; multiple subscribers |
| Filters | 3 | `NativeTargetHint` empty-object serialization; `Adaptation` value holding arbitrary JSON; request-ID uniqueness |

**Total Rust inline tests authored this session: ~53** (exact count: ipc_protocol 19 + crypto 16 + ipc_server counts as shown above + profile_store 4 + additional filter tests).

### TypeScript (Vitest)

| Location | What is covered |
|----------|----------------|
| `packages/core/src/ipc/__tests__/` | `AgentClient` connection lifecycle, handshake success/failure, request/response matching, timeout, push handler, reconnect scheduling, dispose; IPC type guards and `newRequestId` |
| `packages/extension/src/background/__tests__/agent-bridge.test.ts` | `AgentBridge` PSK set/clear/has; `start()` idle when no PSK; `syncProfileOut` no-op when disconnected; `listNativeWindows` returns `[]` when disconnected |

### Playwright (E2E)

A `e2e/specs/agent-pairing.spec.ts` spec covers the pairing UI flow (PSK entry, status badge, unpair). The spec is marked `test.skip` in CI until the Tauri binary is available in the CI environment.
