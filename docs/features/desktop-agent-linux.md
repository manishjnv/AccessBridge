# Desktop Agent — Linux (Session 22)

**Status:** Shipped Session 22 (2026-04-21). AT-SPI2 adapter is fully functional — not a stub.
**Code (Rust):** [`packages/desktop-agent/src-tauri/src/platform/linux.rs`](../../packages/desktop-agent/src-tauri/src/platform/linux.rs), [`packages/desktop-agent/src-tauri/src/platform/linux_caps.rs`](../../packages/desktop-agent/src-tauri/src/platform/linux_caps.rs)
**Companion docs:** [desktop-agent.md](desktop-agent.md) for the cross-platform overview, [../operations/signing.md](../operations/signing.md) for signing notes including the Linux GPG section.

---

## 1. Overview

Session 22 ships the Linux build of the AccessBridge Desktop Agent, completing three-OS parity alongside the Windows UIA adapter (Session 19) and the macOS NSAccessibility adapter (Session 21). The Linux adapter is implemented in Rust via the `atspi` crate (v0.22) and `zbus` (v4.4), which communicate with the AT-SPI2 D-Bus accessibility bus present on every major GTK- and Qt-based desktop environment.

The agent binary is the same Tauri 2 Rust process used on all platforms. It pairs with the browser extension over an identical loopback WebSocket (127.0.0.1:8901) using the same PSK handshake defined in the IPC protocol. Font-scale and cursor-size adaptations are applied system-wide via `gsettings` on GNOME-family desktops (GNOME, Cinnamon, MATE, Budgie) and via `~/.config/kdeglobals` on KDE Plasma. AT-SPI element inspection is available on all supported desktop environments — it does not depend on gsettings.

---

## 2. Supported Distros and Desktop Environments

### Distribution bundles

| Distro | Versions | Bundle |
|---|---|---|
| Ubuntu | 22.04, 24.04 | .deb |
| Debian | 12+ | .deb |
| Linux Mint | 21+ | .deb |
| Fedora | 40+ | .rpm |
| RHEL | 9+ | .rpm |
| openSUSE Tumbleweed | rolling | .rpm |
| Arch | rolling | AppImage / Flatpak manual |
| Any glibc-based | — | AppImage |

### Desktop-environment capability matrix

| DE | FontScale | CursorSize | AT-SPI Inspection |
|---|---|---|---|
| GNOME | via `gsettings` | via `gsettings` | AT-SPI |
| Cinnamon | via `gsettings` | via `gsettings` | AT-SPI |
| MATE | via `gsettings` | via `gsettings` | AT-SPI |
| Budgie | via `gsettings` | via `gsettings` | AT-SPI |
| KDE Plasma | via `kdeglobals` (app restart required) | — (not exposed by KDE gsettings API) | AT-SPI |
| XFCE | — (no unified mechanism) | — | AT-SPI (inspection only) |
| Unknown | — | — | AT-SPI (inspection only) |

**Implementation detail:** `XDG_CURRENT_DESKTOP` is parsed by `linux_caps::detect_desktop_environment()` at runtime. The variable may be colon-separated (e.g., `ubuntu:GNOME` on Ubuntu); the first recognised token wins. Token matching is case-insensitive.

---

## 3. Installation

### Ubuntu / Debian / Linux Mint (.deb)

```bash
wget https://accessbridge.space/downloads/linux/accessbridge-agent.deb
sudo dpkg -i accessbridge-agent.deb
sudo apt-get install -f   # fetch any missing dependencies
```

The `.deb` package installs the binary to `/usr/local/bin/accessbridge-agent`, the desktop entry to `/usr/share/applications/io.accessbridge.Desktop.desktop`, and the systemd user-service unit to `/usr/lib/systemd/user/accessbridge.service`.

### Fedora / RHEL (.rpm)

```bash
wget https://accessbridge.space/downloads/linux/accessbridge-agent.rpm
sudo dnf install accessbridge-agent.rpm
```

### AppImage (universal glibc-based distros)

```bash
wget https://accessbridge.space/downloads/linux/accessbridge-agent.AppImage
chmod +x accessbridge-agent.AppImage
./accessbridge-agent.AppImage
```

The AppImage bundles all required shared libraries except glibc and zlib, which are present on every modern Linux system. No installation step is required — the AppImage is self-contained and runs from any directory.

### Flatpak (build from source — not on Flathub yet)

```bash
git clone https://github.com/manishjnv/AccessBridge
cd AccessBridge
flatpak-builder --install --user build \
  packages/desktop-agent/src-tauri/resources/linux/io.accessbridge.Desktop.yaml
flatpak run io.accessbridge.Desktop
```

See [§10](#10-flatpak-build-from-source-guide) for the full walkthrough, including the `--share=network` security tradeoff.

---

## 4. AT-SPI Runtime Dependency

The agent requires the AT-SPI2 D-Bus accessibility infrastructure. On most desktop installations it is already present. If the agent fails to enumerate windows, install it with the appropriate command for your distro:

**Ubuntu / Debian / Linux Mint:**
```bash
sudo apt-get install at-spi2-core dbus
```

**Fedora / RHEL:**
```bash
sudo dnf install at-spi2-core dbus
```

**openSUSE:**
```bash
sudo zypper install at-spi2-core dbus-1
```

**Arch:**
```bash
sudo pacman -S at-spi2-core dbus
```

### Verify AT-SPI is running

```bash
busctl --user list | grep a11y
```

You should see at least one entry for `org.a11y.Bus` or `org.a11y.atspi.Registry`. If the output is empty, start the AT-SPI bus:

```bash
systemctl --user start at-spi-dbus-bus
```

On systems without systemd, or where the user service is not available, AT-SPI is typically started automatically when the first accessibility-aware application launches.

---

## 5. systemd User Service (Optional Auto-Start)

The agent ships a systemd user-service unit that starts the agent automatically on graphical session login.

### Enable and start

```bash
systemctl --user enable --now accessbridge.service
```

### Check status

```bash
systemctl --user status accessbridge.service
```

### Follow logs

```bash
journalctl --user -u accessbridge.service -f
```

> **AppImage users:** systemd integration is available with the `.deb` and `.rpm` installers only. AppImage users can manually create the unit file at `~/.config/systemd/user/accessbridge.service` using the contents shown below, then run `systemctl --user daemon-reload && systemctl --user enable --now accessbridge.service`.

### Unit file contents

The unit file is installed by the `.deb` / `.rpm` packages and is also available in the source tree at [`packages/desktop-agent/src-tauri/resources/linux/accessbridge.service`](../../packages/desktop-agent/src-tauri/resources/linux/accessbridge.service):

```ini
[Unit]
Description=AccessBridge Accessibility Agent
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=%h/.local/bin/accessbridge-agent
Restart=on-failure
RestartSec=3
# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-write
PrivateTmp=true
# Session D-Bus access is not sandboxed — AT-SPI requires it

[Install]
WantedBy=default.target
```

The `%h` specifier expands to the user's home directory. When the agent is installed system-wide (`.deb` / `.rpm`), the binary is also available at `/usr/local/bin/accessbridge-agent`; the `ExecStart` path in the system-installed unit reflects the package's install prefix.

---

## 6. XDG Paths

The agent respects the XDG Base Directory Specification. All paths fall back to their conventional defaults when the corresponding `XDG_*` environment variable is unset.

```
Config:  $XDG_CONFIG_HOME/accessbridge/   (default: ~/.config/accessbridge/)
Data:    $XDG_DATA_HOME/accessbridge/     (default: ~/.local/share/accessbridge/)  — profile.db (SQLCipher)
Cache:   $XDG_CACHE_HOME/accessbridge/    (default: ~/.cache/accessbridge/)
State:   $XDG_STATE_HOME/accessbridge/    (default: ~/.local/state/accessbridge/)  — logs
Runtime: $XDG_RUNTIME_DIR/accessbridge/   — pair.key (PSK; tmpfs on most distros, ephemeral)
```

The PSK lives in `$XDG_RUNTIME_DIR` which is a per-user tmpfs on modern systemd systems (mode `0700`, owned by the user). It is not persisted across reboots. On next agent start, the PSK is regenerated if the file is absent — re-pairing with the extension is required after a reboot unless the PSK was also stored in the keyring (keyring storage is used when `secret-service` is available; file fallback otherwise).

---

## 7. Pairing Flow

Pairing works identically to Windows and macOS:

1. Launch the agent (via the `.AppImage`, the system-installed binary, or the systemd service).
2. The agent's system-tray icon appears. Click it to open the settings window.
3. Navigate to the **Overview** tab. Copy the PSK shown in the "Pair Key" field.
4. Open the Chrome extension popup → Settings → "Pair with Desktop Agent".
5. Paste the PSK and click **Pair**.
6. The status badge changes to "Connected (Linux, v0.21.0)".

Because `$XDG_RUNTIME_DIR` is mode `0700` and owned exclusively by the running user, the PSK file is protected from other users on the same machine without requiring additional ACL configuration.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `busctl --user list \| grep a11y` returns empty | AT-SPI bus not running | `systemctl --user start at-spi-dbus-bus` or install `at-spi2-core` |
| "Font scale not supported on XFCE" | Expected — XFCE has no unified font-scale mechanism | Use per-application font settings or switch to a supported DE |
| `gsettings: command not found` | Minimal distro without gsettings | Install `glib2` (Fedora/RHEL) or `libglib2.0-bin` (Debian/Ubuntu) |
| Popup shows "Connected (Linux, v0.21.0)" without distro name | `/etc/os-release` unreadable | Agent still functions; the distro hint shown in the popup is cosmetic |
| Agent fails to bind port 8901 | Another process is already using the loopback port | `lsof -i :8901` to identify the PID; stop that process or change `DEFAULT_PORT` in `ipc_server.rs` and rebuild |
| KDE font change has no immediate effect | KDE Plasma reads `kdeglobals` at application startup | Restart affected applications after applying the font-scale adaptation |
| Flatpak agent cannot be reached by extension | Flatpak network namespace isolation | Ensure `--share=network` is present in the manifest (it is — see `io.accessbridge.Desktop.yaml`); verify the extension and agent are on the same host |
| AT-SPI tree is empty or partial | Some apps do not expose AT-SPI | Use `accerciser` to inspect the live AT-SPI tree: `sudo apt install accerciser` (Debian/Ubuntu) or `sudo dnf install accerciser` (Fedora) |
| `pair.key` absent after reboot | `$XDG_RUNTIME_DIR` is tmpfs — files are not persisted | Expected. Re-pair after reboot, or configure keyring storage (agent uses `secret-service` crate when available) |

---

## 9. Uninstall

### Packaged installs

**.deb:**
```bash
sudo dpkg -r accessbridge-agent
```

**.rpm:**
```bash
sudo dnf remove accessbridge-agent
```

### AppImage

```bash
rm accessbridge-agent.AppImage
```

### Flatpak

```bash
flatpak uninstall io.accessbridge.Desktop
```

### Remove configuration and data

```bash
rm -rf ~/.config/accessbridge \
       ~/.local/share/accessbridge \
       ~/.cache/accessbridge \
       ~/.local/state/accessbridge
```

`$XDG_RUNTIME_DIR/accessbridge/` (containing the ephemeral PSK) is cleared automatically on session logout by the init system.

---

## 10. Flatpak Build-from-Source Guide

The Flatpak manifest lives at [`packages/desktop-agent/src-tauri/resources/linux/io.accessbridge.Desktop.yaml`](../../packages/desktop-agent/src-tauri/resources/linux/io.accessbridge.Desktop.yaml).

### Prerequisites

```bash
# Fedora / RHEL
sudo dnf install flatpak flatpak-builder

# Ubuntu / Debian
sudo apt-get install flatpak flatpak-builder

# Add the Freedesktop runtime (SDK + Platform)
flatpak remote-add --user --if-not-exists \
  flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub \
  org.freedesktop.Platform//23.08 \
  org.freedesktop.Sdk//23.08 \
  org.freedesktop.Sdk.Extension.rust-stable//23.08
```

### Build and install

```bash
git clone https://github.com/manishjnv/AccessBridge
cd AccessBridge

flatpak-builder \
  --install \
  --user \
  --force-clean \
  build \
  packages/desktop-agent/src-tauri/resources/linux/io.accessbridge.Desktop.yaml
```

This step compiles the Rust agent from source inside the Flatpak sandbox. The first build downloads the Rust stable toolchain and all Cargo dependencies; expect 10–20 minutes on first run. Subsequent builds use the Flatpak build cache.

### Run

```bash
flatpak run io.accessbridge.Desktop
```

### `--share=network` security tradeoff

The manifest includes `--share=network` in `finish-args`. This is required because the browser extension (running outside the Flatpak sandbox) must reach the agent's loopback WebSocket at `127.0.0.1:8901`. Flatpak's default isolated network namespace blocks inbound connections from the host, so without `--share=network` the extension cannot connect.

`--share=network` grants access to the full host network namespace — broader than strictly necessary (loopback only would suffice). There is currently no narrower Flatpak portal for "loopback-only" access. The PSK authentication in `ipc_server.rs` provides the primary defense: every connection must present a valid PSK hash before any message is processed, so even if a local process reaches the loopback port it cannot interact with the agent without the PSK.

The preferred future migration path is Unix-domain sockets via `--filesystem=xdg-run/accessbridge.sock:create`, which would allow removing `--share=network` entirely. This requires corresponding changes on the extension side to use a socket path instead of a TCP port. Tracked in `DEFERRED.md`.

---

## 11. Security Invariants (Linux-specific)

- All WS traffic remains on `127.0.0.1`. No frame leaves the machine.
- PSK: 32 random bytes from `ring::SystemRandom`. Stored in `$XDG_RUNTIME_DIR/accessbridge/pair.key` (mode `0600`). Falls back to the `secret-service` keyring when available.
- SQLCipher master key: stored in the `secret-service` keyring as `service=accessbridge, account=db-key`; file fallback at `$XDG_DATA_HOME/accessbridge/db.key` (mode `0600`).
- All `gsettings` invocations use `Command::new("gsettings").args(...)` — no shell interpolation. Numeric values are formatted before passing as arguments.
- `kdeglobals` writes use `std::fs::write` with a string built entirely from internal state — no user-supplied content is interpolated into the file path or value.
- The systemd unit includes `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=read-write`, and `PrivateTmp=true`.
- The Flatpak sandbox uses `--share=network` with PSK gating (see §10 for the tradeoff).

---

## 12. See Also

- [desktop-agent.md](desktop-agent.md) — cross-platform architecture overview (Sessions 19 + 21 + 22)
- [desktop-agent-macos.md](desktop-agent-macos.md) — macOS NSAccessibility adapter (Session 21)
- [../operations/signing.md](../operations/signing.md) — signing strategy including Linux GPG notes
- [`packages/desktop-agent/src-tauri/src/platform/linux.rs`](../../packages/desktop-agent/src-tauri/src/platform/linux.rs) — AT-SPI adapter implementation
- [`packages/desktop-agent/src-tauri/src/platform/linux_caps.rs`](../../packages/desktop-agent/src-tauri/src/platform/linux_caps.rs) — DE detection and capability probing
- [`packages/desktop-agent/src-tauri/resources/linux/accessbridge.service`](../../packages/desktop-agent/src-tauri/resources/linux/accessbridge.service) — systemd unit file
- [`packages/desktop-agent/src-tauri/resources/linux/io.accessbridge.Desktop.yaml`](../../packages/desktop-agent/src-tauri/resources/linux/io.accessbridge.Desktop.yaml) — Flatpak manifest
- [RCA.md](../../RCA.md) — bug log
