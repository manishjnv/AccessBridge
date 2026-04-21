# Desktop Agent — macOS (Session 21)

**Status:** MVP shipped Session 21 (2026-04-21). Cross-platform abstraction landed; macOS adapter covers font-scale adaptation on controls that expose `AXFontSize`.
**Code (Rust):** [`packages/desktop-agent/src-tauri/src/platform/macos.rs`](../../packages/desktop-agent/src-tauri/src/platform/macos.rs), [`packages/desktop-agent/src-tauri/src/permissions/macos.rs`](../../packages/desktop-agent/src-tauri/src/permissions/macos.rs)
**Companion docs:** [desktop-agent.md](desktop-agent.md) for the cross-platform overview, [../operations/code-signing.md](../operations/code-signing.md) for signing + notarization.

---

## 1. Overview

The macOS build of the Desktop Agent is a Tauri 2 Rust binary that pairs with the browser extension over the same loopback WebSocket used on Windows (127.0.0.1:8901) and exposes NSAccessibility element inspection. Bundle targets for macOS: `.app` bundle, signed `.dmg` (user install), and `.pkg` (admin install).

Parity with Windows:

| Feature | Windows | macOS | Notes |
|---------|---------|-------|-------|
| PSK handshake + loopback WS | ✓ | ✓ | Same code path |
| SQLCipher profile store | ✓ | ✓ | Same code path |
| OS keyring master key | ✓ (Credential Manager) | ✓ (Keychain) | Same `keyring` crate |
| Native window enumeration | UIAutomation | NSAccessibility | Different FFI, same `NativeElementInfo` output |
| Element tree walk | ✓ | Top-level windows only (MVP) | Deep walks are Phase 3 |
| Font-scale adaptation | Returns Unsupported (needs shim DLL, Phase 2) | Works on `AXFontSize`-exposing controls (TextEdit, some IDEs) | Safari content uses extension adapter |
| Accessibility permission gate | No (Windows has none at this level) | **Required** — user must grant in Settings | See §4 |
| System tray icon | ✓ | ✓ | Same Tauri setup |
| Settings window | ✓ | ✓ | Permissions pane shows macOS status |

---

## 2. Cross-Platform Abstraction

Session 21 replaced the Windows-specific `UiaDispatch` trait with a platform-neutral `AccessibilityAdapter` trait in [`src/platform/mod.rs`](../../packages/desktop-agent/src-tauri/src/platform/mod.rs):

```rust
pub trait AccessibilityAdapter: Send + Sync {
    fn platform_name(&self) -> &'static str;
    fn capabilities(&self) -> Vec<Capability>;
    fn list_top_level_windows(&self) -> AdapterResult<Vec<NativeElementInfo>>;
    fn find_element(&self, hint: &NativeTargetHint) -> AdapterResult<Option<Element>>;
    fn apply_font_scale(&self, element: &Element, scale: f32) -> AdapterResult<AdaptationHandle>;
    fn revert_adaptation(&self, handle: AdaptationHandle) -> AdapterResult<()>;
    // default impl of apply_adaptation routes to apply_font_scale
}
```

Implementations live in `src/platform/{windows,macos,linux}.rs`. Compile-time cfg dispatch in `src/platform/factory.rs::make_adapter()`.

The existing `UiaDispatch` trait in `ipc_server.rs` is retained as an `AdapterShim` newtype over `Arc<dyn AccessibilityAdapter>` so the 10+ existing `dispatch()` tests require no changes. AdapterShim now also holds `HashMap<id, AdaptationHandle>` so `revert()` can find the handle produced by `apply()` (Session 21 fix — pre-Session-21 revert was a silent no-op).

---

## 3. macOS Adapter Implementation

### 3.1 FFI surface

The adapter uses raw `extern "C"` declarations against the ApplicationServices + CoreFoundation frameworks — the `accessibility-sys` crate was evaluated and rejected (unmaintained; last release 2020). The FFI surface:

**ApplicationServices framework:**
- `AXUIElementCreateApplication(pid) -> AXUIElementRef`
- `AXUIElementCopyAttributeValue(el, attr, &mut value_out) -> AXError`
- `AXUIElementSetAttributeValue(el, attr, value) -> AXError`
- `AXUIElementGetAttributeValueCount(el, attr, &mut count) -> AXError`
- `AXUIElementCopyAttributeValues(el, attr, start, max, &mut values_out) -> AXError`
- `AXValueGetTypeID() -> CFTypeID`
- `AXValueGetValue(value_ref, type_id, &mut out_ptr) -> bool`
- `AXIsProcessTrustedWithOptions(options_dict) -> bool`

**CoreFoundation framework:**
- `CFRetain`, `CFRelease`, `CFGetTypeID`
- `CFArrayGetTypeID`, `CFArrayGetCount`, `CFArrayGetValueAtIndex`
- `CFStringGetTypeID`, `CFStringGetCStringPtr`, `CFStringGetCString`
- `CFNumberGetTypeID`, `CFNumberGetValue`, `CFNumberCreate`

Linked via `#[link(name = "ApplicationServices", kind = "framework")]` and `#[link(name = "CoreFoundation", kind = "framework")]`.

### 3.2 AxElementRef — opaque handle wrapper

```rust
pub struct AxElementRef {
    ptr: *mut std::ffi::c_void, // AXUIElementRef underneath
}
```

- `Drop` calls `CFRelease` (non-null guard).
- `Clone` calls `CFRetain` + copies the pointer.
- `unsafe impl Send + Sync` — Apple documents AXUIElementRef as thread-safe for read/write access; CFRetain/CFRelease are atomic operations. This is called out in a `// SAFETY:` comment inline.
- Constructor `unsafe fn from_raw_retained(ptr)` takes ownership (assumes caller already retained or got from a Copy* function which returns +1).

### 3.3 Window enumeration

`list_windows_with_refs()` iterates `NSWorkspace.sharedWorkspace.runningApplications()` via `objc2` + `objc2-app-kit`. For each `NSRunningApplication`:
1. Read `processIdentifier()` → pid.
2. Read `localizedName()` → `Option<NSString>` → `String`.
3. Call `AXUIElementCreateApplication(pid)` to get the app's AX root.
4. Copy the `AXWindows` attribute (CFArray of AXUIElementRef).
5. For each window ref:
   - Copy `AXTitle` (CFString).
   - Copy `AXPosition` (AXValue wrapping CGPoint).
   - Copy `AXSize` (AXValue wrapping CGSize).
   - Build `NativeElementInfo { process_name, window_title, control_type: "AXWindow", bounding_rect, ... }`.
6. Cap at 256 elements total; skip individual windows on any AX error (same philosophy as Windows discovery).

### 3.4 Font-scale adaptation

`apply_font_scale(element, scale)`:

1. **Permission gate first.** Call `check_trusted()` (wraps `AXIsProcessTrustedWithOptions(null)`). If false → `Err(AdapterError::PermissionDenied("accessibility access not granted; open System Settings → Privacy & Security → Accessibility and enable AccessBridge"))`.
2. Extract `AxElementRef` from `element.handle()` matching `PlatformElement::MacOs(ref)`.
3. Copy current `AXFontSize` (CFNumber → f64):
   - On `kAXErrorAttributeUnsupported` (-25205) → `Err(AdapterError::Unsupported("this macOS control does not expose AXFontSize — use the browser adapter for Safari or Chrome content"))`.
4. Compute `new_size = previous_size * scale`.
5. Set `AXFontSize` to new CFNumber.
6. Return `AdaptationHandle { id: adaptation.id, revert: RevertState::MacOsAxFontSize { element: element_ref.clone(), previous_size } }`.

### 3.5 Controls that expose `AXFontSize`

Not every Mac app does. The following are known to work:

- **TextEdit** — native text view, `AXFontSize` settable per text range.
- **Xcode editor** — some source views.
- **Notes** (first-party) — partial.

The following do NOT expose `AXFontSize` and return `Unsupported`:

- Safari web content (use the browser extension adapter instead).
- Chrome/Edge web content (same).
- Most Electron apps (VS Code, Slack, Discord) — they provide their own accessibility but not per-control font sizing via AX.
- Pages/Keynote/Numbers — expose other attributes but not AXFontSize directly.

For Safari content, the supported pathway is: install the AccessBridge Chrome/Safari extension; the extension applies its sensory adapter (CSS zoom) independently of the agent.

---

## 4. Accessibility Permission UX

macOS gates all AX calls behind a user-granted TCC (Transparency, Consent, and Control) permission. First-launch flow:

1. Agent launches, shows system-tray icon.
2. User opens settings window (click tray).
3. The Permissions tab (added Session 21 — `bridge_check_accessibility_permission` / `bridge_request_accessibility_permission` Tauri commands) shows status:
   - **Granted** — green check; no action needed.
   - **Not Determined** — "Grant Accessibility Permission" button.
   - **Denied** — "Open System Settings" link + manual instructions.
4. Clicking "Grant" calls `AXIsProcessTrustedWithOptions(prompt=true)`, which shows the macOS system dialog. It also spawns `open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` as a belt-and-braces fallback in case the dialog doesn't appear (sandboxed contexts).
5. User toggles AccessBridge in the list. Returns to settings window; polling `check_accessibility_permission` every 2s updates the badge to Granted.

Implementation: [`src/permissions/macos.rs`](../../packages/desktop-agent/src-tauri/src/permissions/macos.rs).

### Why `NotDetermined` vs `Denied` are conflated

Apple's `AXIsProcessTrustedWithOptions` only returns a boolean. To distinguish "never asked" from "explicitly denied" requires reading the TCC sqlite database (`~/Library/Application Support/com.apple.TCC/TCC.db`), which is itself TCC-gated. The agent takes the conservative path: `false` → `NotDetermined` and always shows the Grant button.

---

## 5. Installation

### Prerequisites for building (developer machines)

- macOS 11.0+ (minimumSystemVersion in tauri.conf.json)
- Rust stable + both Apple Silicon and Intel targets:
  ```bash
  rustup target add x86_64-apple-darwin aarch64-apple-darwin
  ```
- Xcode Command Line Tools (`xcode-select --install`)
- pnpm 9+ and Node 20+

### End-user install

1. Download `AccessBridge-Desktop-Agent_0.20.0.dmg` (user) or `.pkg` (admin rollout) from the landing page.
2. Open the DMG; drag AccessBridge Desktop Agent to Applications.
3. First launch: Gatekeeper will show a dialog because the MVP binary is self-signed (ad-hoc). Right-click → Open → Open (this is the documented macOS-10.15+ workaround for unnotarized apps during the ideathon phase).
4. Grant Accessibility permission when prompted (see §4).
5. Open the extension popup → Settings → Pair with Desktop Agent. Copy the PSK from the agent's Overview tab; paste into the popup.

### Uninstall

```bash
# Remove app
rm -rf /Applications/AccessBridge\ Desktop\ Agent.app

# Remove PSK + profile DB + keyring fallback file
rm -rf ~/Library/Application\ Support/AccessBridge/

# Remove keyring entries (if you used the keyring path)
security delete-generic-password -s accessbridge -a db-key
security delete-generic-password -s accessbridge -a pair-psk
```

The MVP uninstaller does NOT auto-remove the Application Support directory (consistent with Windows behavior in Session 19) so reinstalls preserve paired state.

---

## 6. Build + CI

### Local build on macOS

```bash
pnpm install
pnpm --filter @accessbridge/desktop-agent tauri build --target universal-apple-darwin
# Output: packages/desktop-agent/src-tauri/target/universal-apple-darwin/release/bundle/{dmg,macos}/*
```

The universal target produces a fat binary containing both x86_64 and arm64 slices. The resulting `.app` runs natively on both Apple Silicon and Intel Macs without Rosetta.

### Deployment artifacts

[tools/build-agent-installer.sh](../../tools/build-agent-installer.sh) detects the host platform and runs the appropriate Tauri bundle. On macOS it produces:

- `accessbridge-desktop-agent_0.20.0_universal.dmg`
- `accessbridge-desktop-agent_0.20.0_universal.pkg`

Both are published to `deploy/downloads/` and referenced by `deploy/downloads/agent-manifest.json` with SHA-256.

### CI matrix

[.github/workflows/agent-build.yml](../../.github/workflows/agent-build.yml) builds on `windows-latest` + `macos-latest` in parallel. On tag push, publishes to GitHub Releases.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| "Accessibility access not granted" on every apply | Permission revoked or never granted | System Settings → Privacy & Security → Accessibility → enable AccessBridge |
| Status stuck at "Pairing…" | PSK mismatch | Recopy PSK from agent Overview tab → paste into extension popup |
| Agent doesn't appear in tray | Gatekeeper blocked launch | Right-click app → Open → Open (or `xattr -d com.apple.quarantine /Applications/AccessBridge*.app`) |
| TextEdit font doesn't change when applying font-scale | AXFontSize not supported on that text view type (rich-text documents work; plain-text fails) | Known MVP limitation; use browser extension adapter instead |
| "this macOS control does not expose AXFontSize" | Control uses a custom renderer | Expected for most non-text-editor apps; not a bug |
| `Library not loaded: ApplicationServices.framework` on launch | macOS SDK mismatch at build | Ensure build ran with proper `minimumSystemVersion: "11.0"` and correct rustup targets |
| Universal binary won't launch on Apple Silicon | Single-arch build, not universal | Rebuild with `--target universal-apple-darwin` |
| SQLCipher build fails at link step | OpenSSL toolchain missing | `bundled-sqlcipher-vendored-openssl` feature compiles OpenSSL from source; ensure Xcode CLT is installed |

---

## 8. Phase 2 roadmap

Items explicitly deferred from Session 21:

1. **AXTextArea range-replace** for apps that don't expose `AXFontSize` but do expose `AXValue` + `AXSelectedTextRange` — read the full document, rewrite with a larger font via selected-text replacement. More invasive but wider coverage.
2. **AppleScript bridge to Safari** for reader-mode font scaling when the extension isn't installed.
3. **Rich window tree walks** (not just top-level windows) — recurse into `AXChildren` with depth limits.
4. **Notarization + Developer ID signing** — requires paid Apple Developer account (user provides).
5. **Auto-update via Tauri updater** pointing to `https://accessbridge.space/api/version`.
6. **Permission prompt polling in Settings window** — currently the UI polls every 2s; smarter Darwin Notification Center integration can be reactive instead of polling.
7. **VoiceOver bridge** — query VoiceOver state and coordinate with it rather than compete.
8. **Screen reader bridging** for consistent narration across the agent and the extension.

---

## 9. Testing

### Rust inline tests (not yet in CI because CI image lacks macOS matrix — see `.github/workflows/agent-build.yml` for the new matrix build)

| Module | Count | Coverage |
|--------|-------|----------|
| `platform::macos` | 4+ | platform_name, capabilities, revert_none, AxElementRef drop on null |
| `permissions::macos` | 3 | settings URL const, status mapping, FFI stub |
| `platform::windows` | 6 | Existing filter tests (ported from `uia/filters.rs`) |
| `platform::linux` | 5 | Stub behavior: capabilities limited to IPC, empty enumeration, error paths |
| `platform::factory` | 3 | Mock adapter shape + Arc construction |
| `platform::mod` | 3 | Capability string stability + AdapterError Display |
| `profile_store` | 18 | SQLCipher round-trip, wrong-key, history, rollback, kv safety |
| `crypto` (new) | 8 | keyring round-trip, rotate, fallback, concurrency |
| `crypto` (existing) | 16 | PSK, AES-GCM, pair key file (unchanged) |

Tests that require actual TCC permission grant (real AXIsProcessTrustedWithOptions) are not in the suite — they require an interactive Mac with AccessBridge manually toggled in System Settings.

### Playwright E2E

`e2e/specs/agent-pairing-macos.spec.ts` (gated by `process.env.ACCESSBRIDGE_AGENT_BINARY` pointing to a macOS binary; skipped in CI by default).

---

## 10. Security invariants (macOS-specific additions)

- All WS traffic remains loopback-only. No change from Session 19.
- PSK remains 32 random bytes. Stored in Keychain as `service=accessbridge, account=pair-psk`; file fallback at `~/Library/Application Support/AccessBridge/pair.key` with 0600 perms.
- SQLCipher master key: 32 random bytes, Keychain entry `service=accessbridge, account=db-key`; file fallback at `~/Library/Application Support/AccessBridge/db.key` with 0600 perms.
- AX calls only run after `AXIsProcessTrustedWithOptions(null)` returns true. A denied permission never produces silently-wrong results — it errors with a clear reason.
- `std::process::Command::new("open")` — the URL argument is a hardcoded constant with no user interpolation. No shell argument injection path.
- Hardened runtime entitlements: only `com.apple.security.automation.apple-events` is granted (for future AppleScript bridge); JIT and library-validation bypass are explicitly disabled in `entitlements.plist`.

---

## 11. See also

- [desktop-agent.md](desktop-agent.md) — cross-platform architecture overview (Session 19 + 21 merged)
- [../architecture.md](../architecture.md) — Layer 6 and 8 update
- [../operations/code-signing.md](../operations/code-signing.md) — Windows Authenticode + macOS Developer ID
- [../../packages/desktop-agent/src-tauri/src/platform/mod.rs](../../packages/desktop-agent/src-tauri/src/platform/mod.rs) — trait contract
- [RCA.md](../../RCA.md) — bug log (no Session-21-specific bug as of landing)
