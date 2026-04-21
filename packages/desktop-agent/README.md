# @accessbridge/desktop-agent

AccessBridge Desktop Agent — extends AccessBridge to native Windows applications via UI Automation (UIA). Runs as a system-tray process; pairs with the browser extension over a loopback-only WebSocket on port 8901.

---

## 1. Purpose

The desktop agent bridges gap between browser-based accessibility auditing and native app surfaces. It:

- Exposes UIA element trees from any running Win32/WPF/WinUI app to the extension
- Syncs accessibility profiles across browser and desktop surfaces
- Runs silently in the system tray; the settings window opens on tray-icon click
- Communicates exclusively over `ws://127.0.0.1:8901` — no external network traffic

---

## 2. Prerequisites

Install all of the following before attempting `tauri dev` or `tauri build`:

### Rust toolchain

```
# Install rustup (installs Rust + Cargo)
winget install Rustlang.Rustup
# or: https://rustup.rs

# After install, add the stable toolchain
rustup default stable
rustup target add x86_64-pc-windows-msvc
```

### MSVC build tools (C++ workload)

Download **Visual Studio Build Tools 2022** and install the **Desktop development with C++** workload:
<https://visualstudio.microsoft.com/visual-cpp-build-tools/>

### WiX Toolset v4 (MSI bundling)

```
dotnet tool install --global wix
```

Requires .NET SDK 6+: <https://dotnet.microsoft.com/download>

### WebView2 Runtime

Ships pre-installed on Windows 11. On Windows 10, install via:
<https://developer.microsoft.com/en-us/microsoft-edge/webview2/>

---

## 3. Dev Quick-Start

```bash
# From the monorepo root — install all workspace deps
pnpm install

# Start the Tauri dev window (hot-reloads the React frontend)
pnpm --filter @accessbridge/desktop-agent tauri:dev
```

The Vite dev server starts on `http://localhost:1420`. Tauri wraps it in a native window.

---

## 4. Build MSI

```bash
pnpm --filter @accessbridge/desktop-agent tauri:build
```

Output: `packages/desktop-agent/src-tauri/target/release/bundle/msi/*.msi`

The MSI targets Windows 10+ (x64). macOS and Linux are Phase 2.

---

## 5. Extension Pairing

1. On first run, the agent generates a random PSK and writes it to:
   `%LOCALAPPDATA%\AccessBridge\pair.key`
2. The browser extension reads the key via a native messaging host and initiates a WebSocket handshake to `ws://127.0.0.1:8901`.
3. All subsequent messages are encrypted with that PSK (AES-256-GCM via the `ring` crate).

The pairing key rotates on each agent restart.

---

## 6. Regenerating Icons

After installing `@tauri-apps/cli`, replace the placeholder icons with properly sized assets:

```bash
pnpm exec tauri icon path/to/source.png
```

Use a 1024x1024 PNG source for best results. This regenerates `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.ico`, and `icon.png` inside `src-tauri/icons/`.

See `src-tauri/icons/ICONS_NOTE.md` for details.

---

## 7. MVP Scope

| Feature | Status |
|---|---|
| System-tray icon + settings window | Scaffold only |
| UIA element tree (Windows) | Placeholder (`src-tauri/src/uia/`) |
| IPC server on ws://127.0.0.1:8901 | Placeholder (`src-tauri/src/ipc_server.rs`) |
| PSK pairing + AES-256-GCM crypto | Placeholder (`src-tauri/src/crypto.rs`) |
| Profile sync | Placeholder (`src-tauri/src/profile_store.rs`) |
| Font-scaling demo | Phase 1 implementation |
| macOS / Linux | Phase 2 (`#[cfg(not(windows))]` stubs present) |

---

## 8. Troubleshooting

### SmartScreen blocks the MSI

The MSI is self-signed. On first install, click **More info → Run anyway** in the SmartScreen dialog. To suppress for development, sign the binary with a code-signing certificate.

### Port 8901 already in use

Check what is using the port:
```
netstat -ano | findstr :8901
```
Kill the process or configure a different port in `src-tauri/src/ipc_server.rs` (once implemented).

### Missing WiX / `tauri build` fails

Ensure `wix` is on PATH:
```
wix --version
```
If not found, re-run `dotnet tool install --global wix` and open a new terminal.

### `cargo build` fails on non-Windows

The `uia` and `windows` crates are gated behind `#[cfg(windows)]`. Non-Windows builds use `uia_stub` instead. Ensure you are building for the correct target.
