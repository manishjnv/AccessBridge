# Team Deployment — AccessBridge

This guide covers the AccessBridge Team deployment mode: scripted installation for departments of 10–1,000 users. No MDM infrastructure or Active Directory is required — a single install command per machine, plus an optional preset profile, is all that is needed. For larger managed rollouts with policy lockdown, see [docs/deployment/group-policy.md](group-policy.md) and [docs/deployment/enterprise-chrome.md](enterprise-chrome.md).

---

## Table of Contents

1. [When Team Mode Applies](#1-when-team-mode-applies)
2. [Architecture Overview](#2-architecture-overview)
3. [Install Command Cheat Sheet](#3-install-command-cheat-sheet)
4. [Command Flags](#4-command-flags)
5. [Preset Profile Catalog](#5-preset-profile-catalog)
6. [Phased Rollout Recipe](#6-phased-rollout-recipe)
7. [Collecting Feedback and Filing Issues](#7-collecting-feedback-and-filing-issues)
8. [Upgrade Path: Team → Enterprise](#8-upgrade-path-team--enterprise)
9. [Troubleshooting](#9-troubleshooting)
10. [Security Model](#10-security-model)

---

## 1. When Team Mode Applies

| Attribute | Self-install | **Team** | Enterprise |
|---|---|---|---|
| Target size | 1–10 users | **10–1,000 users** | 1,000+ users |
| Install mechanism | User drags CRX or clicks store link | **IT admin runs a scripted one-liner per device or via remote execution tool** | MDM / SCCM / GPO force-install; no user action |
| Policy control | None — user has full control | **Shared default profile pushed at install time; user may customize afterwards** | `chrome.storage.managed` lockdown via ADMX / mobileconfig / policy JSON; user cannot override locked keys |
| Central server requirement | None | **None — no server required; observatory is opt-in** | None beyond what MDM already provides |
| Pilot-analytics support | Not available | **Available — pass `--pilot-id` flag** | Available via `orgHash` Group Policy |
| Support SLA expectation | Community / GitHub Issues | **Departmental IT — internal ticket queue** | Enterprise support contract |
| Best for | Individual power users, developers, accessibility testers | **Departments, pilot cohorts, SMBs, universities** | Large enterprises with existing MDM, strict compliance requirements |

Team mode completes the Plan Section 9.2 deployment-modes matrix. As of Session 24, all three modes (Self-install ✓, **Team ✓**, Enterprise ✓) are available.

---

## 2. Architecture Overview

A Team deployment has three components. All three are optional beyond the extension itself.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Each user machine                                                  │
│                                                                     │
│  ┌─────────────────────────┐   ┌───────────────────────────────┐   │
│  │  AccessBridge extension │   │  Desktop Agent (optional)     │   │
│  │  (Chrome MV3)           │   │  Tauri 2 binary — pairs via   │   │
│  │                         │◀──│  PSK over 127.0.0.1:8901     │   │
│  │  Shared default profile │   │  (Windows UIA / macOS NS /   │   │
│  │  written at install time│   │   Linux AT-SPI)              │   │
│  └─────────────────────────┘   └───────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                        │  opt-in telemetry
                        ▼
          ┌─────────────────────────────┐
          │  Observatory VPS (optional) │
          │  ops/observatory/server.js  │
          │  http://72.61.227.64:8300/  │
          │  /observatory/              │
          │                             │
          │  Pilot dashboard at         │
          │  /observatory/pilot.html    │
          └─────────────────────────────┘
```

**Key design decisions:**

- **No central server required for installation.** The install scripts download the extension zip from `https://accessbridge.space/downloads/` and write the managed-policy JSON (or Chrome ExtensionSettings) locally. No VPN, no internal server.
- **Profile is shared, not locked.** A preset profile file is written to `chrome.storage.local` at install time. Users can change any setting after installation. If you need settings that users cannot change, upgrade to Enterprise mode (see §8).
- **Observatory is opt-in and aggregated.** When a user enables observatory sharing in the extension popup, daily metrics are sent with Laplace differential-privacy noise. No URLs, no content, no identity. See [docs/features/compliance-observatory.md](../features/compliance-observatory.md).
- **Pilot tracking is additive.** Passing `--pilot-id` at install time tags observatory submissions with a cohort identifier, enabling the pilot dashboard to break metrics out by cohort. Removing the tag is a one-command re-install.

---

## 3. Install Command Cheat Sheet

All install commands download the extension zip from `https://accessbridge.space/downloads/accessbridge-extension.zip?v=<version>` — the `?v=` query string is always appended to bust Cloudflare's cache (see BUG-010). The scripts verify the SHA-256 checksum of the downloaded zip before writing any files.

### Windows (PowerShell 5.1+)

```powershell
# Minimal install — default profile, no pilot tracking
iwr https://accessbridge.space/team/install.ps1 | iex

# With a preset profile
iwr https://accessbridge.space/team/install.ps1 | iex -args '--profile banking'

# With pilot tracking
iwr https://accessbridge.space/team/install.ps1 | iex -args '--profile default --pilot-id pilot-2026-q2'

# With desktop agent
iwr https://accessbridge.space/team/install.ps1 | iex -args '--profile default --install-agent'
```

### macOS (bash 3.2+)

```bash
# Minimal install — default profile, no pilot tracking
curl -fsSL https://accessbridge.space/team/install.sh | bash

# With a preset profile
curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- --profile banking

# With pilot tracking
curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- --profile default --pilot-id pilot-2026-q2

# With desktop agent
curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- --profile default --install-agent
```

### Linux (bash, systemd optional)

```bash
# Minimal install — default profile, no pilot tracking
curl -fsSL https://accessbridge.space/team/install.sh | bash

# With a preset profile
curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- --profile dyslexia

# With pilot tracking
curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- --profile default --pilot-id pilot-2026-q2

# With desktop agent (systemd user service)
curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- --install-agent
```

### Universal dispatcher (runs platform detection automatically)

```bash
# On macOS or Linux
curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- [flags]

# On Windows
iwr https://accessbridge.space/team/install.ps1 | iex -args '[flags]'
```

The universal dispatcher at [`deploy/team/install.sh`](../../deploy/team/install.sh) and [`deploy/team/install.ps1`](../../deploy/team/install.ps1) detects the OS and delegates to the OS-specific script at [`deploy/team/install-windows.ps1`](../../deploy/team/install-windows.ps1), [`deploy/team/install-macos.sh`](../../deploy/team/install-macos.sh), or [`deploy/team/install-linux.sh`](../../deploy/team/install-linux.sh).

---

## 4. Command Flags

All flags apply to all three OS-specific installers unless noted otherwise.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--profile <name>` | string | `default` | Preset profile to write at install time. One of: `default`, `tamil`, `banking`, `dyslexia`, `fatigue-study`, `motor`. See §5 for details. |
| `--pilot-id <id>` | string | _(none)_ | Cohort identifier for observatory pilot analytics. Written to the managed policy JSON so every observatory submission carries this tag. Omit if you are not running a tracked pilot. |
| `--install-agent` | flag | off | Also install the AccessBridge Desktop Agent binary alongside the extension. On Linux, registers a systemd user service. |
| `--agent-version <semver>` | string | `latest` | Pin a specific agent version. Defaults to the version string returned by `/api/version`. |
| `--skip-checksum` | flag | off | Skip SHA-256 verification of the downloaded extension zip. Use only in air-gapped environments where you supply the zip from a local mirror — never in internet-connected deployments. |
| `--zip-url <url>` | string | _(server default)_ | Override the extension zip download URL. Useful when self-hosting artifacts on an internal mirror. The URL should still include `?v=<version>` to prevent cache staleness. |
| `--chrome-policy-dir <path>` | string | OS default | Override the Chrome managed-policy directory. Default per OS: Windows `HKLM\SOFTWARE\Policies\Google\Chrome`, macOS `/Library/Managed Preferences/`, Linux `/etc/opt/chrome/policies/managed/`. |
| `--no-observatory` | flag | off | Skip writing the observatory opt-in setting. User will see the opt-in prompt at first launch rather than inheriting the preset's default. |
| `--dry-run` | flag | off | Print every action that would be taken without executing any of them. Useful for auditing the installer behavior before mass deployment. |
| `--uninstall` | flag | off | Remove the managed-policy JSON written by a previous Team install. Does not uninstall Chrome or remove the extension binary — Chrome handles extension removal on next restart when the force-install entry is absent. |
| `--version` | flag | off | Print the installer version and exit. |
| `--quiet` | flag | off | Suppress all informational output. Errors are still written to stderr. |
| `--log-file <path>` | string | _(none)_ | Write a verbose install log to the specified path. Useful for remote-execution audit trails. |

### Windows-only flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--all-users` | flag | off | Write Chrome policy to HKLM (all users on this machine) instead of HKCU (current user). Requires administrator elevation. |
| `--webview2` | flag | off | Download and install the WebView2 Evergreen bootstrapper before installing the desktop agent. Only needed on Windows 10 machines that have not received WebView2 via Windows Update. |

### Linux-only flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--no-systemd` | flag | off | Skip systemd user-service registration for the desktop agent. The agent binary is still installed; launch it manually as needed. |
| `--deb` / `--rpm` / `--appimage` | flag | auto-detect | Force a specific desktop-agent package format. Default: `.deb` on Debian/Ubuntu, `.rpm` on Fedora/RHEL, AppImage otherwise. |

---

## 5. Preset Profile Catalog

Preset profiles are JSON files located at [`deploy/team/profiles/`](../../deploy/team/profiles/). Each preset is a partial `AccessibilityProfile` object — only the keys listed are overridden; all other keys use the extension's factory defaults.

| Preset name | File | Use-case | Key settings | Audience |
|---|---|---|---|---|
| `default` | [`pilot-default.json`](../../deploy/team/profiles/pilot-default.json) | General-purpose starting point for any department. Balanced settings suitable for most users, with observatory opt-in suggested but not forced. | `fontScale: 1.0`, `contrastLevel: 1.0`, `reducedMotion: false`, `autoSummarize: false`, `observatoryOptIn: false` | Any department beginning a pilot with no specific accessibility focus |
| `tamil` | [`pilot-tamil.json`](../../deploy/team/profiles/pilot-tamil.json) | Deployments where Tamil is the preferred language. Enables Tamil voice commands and sets the default language for captions and simplification. | `language: 'ta'`, `voiceNavigationEnabled: true`, `liveCaptionsEnabled: true`, `captionLanguage: 'ta-IN'` | Regional offices, educational institutions, and public-sector teams serving Tamil-speaking users |
| `banking` | [`pilot-banking.json`](../../deploy/team/profiles/pilot-banking.json) | Financial-sector teams where the Banking domain connector (D-01) should be active by default and cloud AI is inappropriate for data-residency reasons. | `domains: ['banking']`, `allowCloudAI: false`, `autoSummarize: true` (local tier only), `observatoryOptIn: false` | Bank branches, NBFC operations teams, financial advisors |
| `dyslexia` | [`pilot-dyslexia.json`](../../deploy/team/profiles/pilot-dyslexia.json) | Users with dyslexia or reading difficulties. Activates the typographic adaptations, reading guide, and reading mode with a default dyslexia-friendly font stack. | `fontScale: 1.2`, `lineHeight: 1.8`, `letterSpacing: 0.12em`, `readingModeEnabled: true`, `readingGuideEnabled: true`, `colorCorrectionMode: 'none'` | Schools, HR teams running accessibility pilots, any org with dyslexia disclosure requests |
| `fatigue-study` | [`pilot-fatigue-study.json`](../../deploy/team/profiles/pilot-fatigue-study.json) | Research deployments measuring Fatigue-Adaptive UI (C-07) effectiveness. Enables fatigue adaptation at level 2 by default and turns on observatory for study data collection with opt-in acknowledged. | `fatigueAdaptiveUI: true`, `fatigueLevel: 2`, `adaptationMode: 'auto'`, `observatoryOptIn: true`, `observatoryStudyMode: true` | Academic researchers, UX research teams running controlled fatigue studies |
| `motor` | [`pilot-motor.json`](../../deploy/team/profiles/pilot-motor.json) | Users with motor impairments who rely primarily on keyboard navigation, dwell click, or voice. Activates keyboard-only mode, dwell click with a 600 ms delay, and the smart click target enlarger. | `keyboardOnlyMode: true`, `dwellClickEnabled: true`, `dwellClickDelay: 600`, `smartClickTargets: true`, `voiceNavigationEnabled: true` | Occupational therapy teams, assistive-tech pilot programs, HR accessibility requests |

### Customizing a preset before deployment

Clone the preset JSON and edit it before running the installer:

```bash
# Download the banking preset
curl -fsSL https://accessbridge.space/team/profiles/pilot-banking.json -o my-banking.json

# Edit my-banking.json with your preferred settings
nano my-banking.json

# Install with the local file
curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- \
  --profile-file /path/to/my-banking.json \
  --pilot-id my-bank-q2-pilot
```

The `--profile-file` flag (path to a local JSON file) is accepted by all three OS-specific installers alongside `--profile <name>` (a preset from the server).

---

## 6. Phased Rollout Recipe

A phased rollout limits the blast radius of configuration problems. The four-phase cadence below matches the observatory's k-anonymity floor of 5 devices per daily cohort; a cohort below 5 devices does not produce statistical findings (see §10).

### Week 1 — Pilot cohort (10 users)

**Goal:** Validate that the install command works on your OS images, the preset profile is appropriate, and the extension loads without Chrome policy conflicts.

**Actions:**
1. Select 10 technically-comfortable volunteers from the target department.
2. Run the install command on each machine:
   ```bash
   curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- \
     --profile <your-preset> \
     --pilot-id <dept>-week1
   ```
3. Ask each user to enable observatory opt-in in the extension popup (Settings → Privacy → Share anonymous metrics).
4. After 48 hours, check the pilot dashboard at `http://72.61.227.64:8300/observatory/pilot.html?pilot_id=<dept>-week1`.
5. Confirm: feature-usage metrics appearing, no error spikes, struggle scores trending toward 0 (users adapting).
6. Collect qualitative feedback via the feedback widget (see §7) or a short Slack/Teams message.
7. Fix any issues before expanding. Common first-week issues are documented in §9.

### Week 2 — Expand to 50 users

**Goal:** Stress-test the preset against a broader population with more varied devices and Chrome versions.

**Actions:**
1. Add 40 more users from the same or adjacent teams.
2. Use a new pilot ID to keep week-2 data clean:
   ```bash
   bash -s -- --profile <your-preset> --pilot-id <dept>-week2
   ```
3. Review the observatory dashboard daily for the first 3 days (see [docs/operations/pilot-playbook.md](../operations/pilot-playbook.md) §3 for the daily review checklist).
4. If any device fails installation, collect the `--log-file` output and file a GitHub Issue (see §7).
5. Run `tools/pilot/generate-report.ts --pilot-id <dept>-week2 --days 7` at the end of the week.

### Week 3 — Expand to 100 users

**Goal:** Reach the minimum cohort for meaningful pilot analytics. This is the Plan Section 15 Phase 2 threshold.

**Actions:**
1. Add the remaining 50 users.
2. Continue with the same pilot ID or switch to a unified ID for reporting:
   ```bash
   bash -s -- --profile <your-preset> --pilot-id <dept>-full-pilot
   ```
3. Run the mid-pilot feedback survey (template in [docs/operations/pilot-playbook.md](../operations/pilot-playbook.md) §7).
4. Tune the preset if feedback reveals consistent friction (see §5 — Customizing a preset).
5. Re-enroll affected users with the updated preset file using `--profile-file`.

### Week 4+ — Department-wide

**Goal:** Full department coverage; stable configuration; decision point for Enterprise upgrade.

**Actions:**
1. Remove the pilot ID if you no longer need cohort tracking — standard observatory data continues.
2. Generate the final pilot report:
   ```bash
   npx ts-node tools/pilot/generate-report.ts \
     --pilot-id <dept>-full-pilot \
     --format pdf \
     --output reports/pilot-final.pdf
   ```
3. Share the report with department leadership and IT management.
4. Decide: stay on Team mode (no policy lockdown needed) or upgrade to Enterprise (need to lock specific settings).
5. If upgrading, proceed to §8.

---

## 7. Collecting Feedback and Filing Issues

### In-extension feedback widget

The extension popup includes a Feedback button (bottom of the Settings tab). Clicking it opens a five-question Likert survey that the user completes in-app. Responses are POSTed to `/api/pilot/feedback` on the observatory server, tagged with the `pilot_id` if one was set at install time. Results appear in the pilot dashboard under the **Feedback** tab.

To view aggregate feedback:

```
http://72.61.227.64:8300/observatory/pilot.html?pilot_id=<your-pilot-id>#feedback
```

### GitHub Issues

For installation failures, Chrome policy problems, or unexpected extension behavior:

1. Open the AccessBridge GitHub repository.
2. Click **Issues → New Issue**.
3. Select the **Team Deployment** issue template.
4. Paste the `--log-file` output (redact hostnames and usernames if needed).
5. Include your OS version, Chrome version, and the install command you ran.

**Expected response time:** 1–2 business days for Team-mode issues.

### Escalation path

```
User experiences issue
         │
         ▼
IT admin checks §9 Troubleshooting table
         │
         ├── Resolved → document fix in your internal runbook
         │
         └── Not resolved → file GitHub Issue with log output
                    │
                    └── Critical (data loss / security) → email directly
                         with subject [CRITICAL] AccessBridge <brief desc>
```

---

## 8. Upgrade Path: Team → Enterprise

Team and Enterprise modes are not mutually exclusive steps — they use different mechanisms to achieve similar goals. Upgrading means adding an ADMX / mobileconfig / policy JSON layer on top of an existing Team install. Profiles written at Team install time remain valid.

### Step 1 — Choose what to lock

Team mode writes a shared default profile that users can modify. Enterprise mode adds `chrome.storage.managed` policy keys that users cannot change. Decide which keys are worth locking.

Common candidates: `TelemetryLevel`, `AllowCloudAITier`, `DisabledFeaturesLockdown` for AI features that handle sensitive content. See [docs/deployment/group-policy.md](group-policy.md) for the full policy reference.

### Step 2 — Deploy the ADMX (Windows) or mobileconfig (macOS)

The enterprise ADMX is at [`deploy/enterprise/admx/AccessBridge.admx`](../../deploy/enterprise/admx/AccessBridge.admx). The mobileconfig is at [`deploy/enterprise/chrome-extension/AccessBridge.mobileconfig`](../../deploy/enterprise/chrome-extension/AccessBridge.mobileconfig). Follow [docs/deployment/group-policy.md](group-policy.md) §2 for the copy steps.

You do not need to re-run the Team installer — the ADMX layer is additive. The extension reads `chrome.storage.managed` at startup and merges it over the local profile; managed values take precedence over user-saved values for the same keys.

### Step 3 — Move to force-install (optional)

Team mode installs the extension via a local Chrome policy JSON that adds the extension to `ExtensionInstallForcelist` on that machine. This is equivalent to the force-install step in [docs/deployment/enterprise-chrome.md](enterprise-chrome.md). If you are moving to an MDM-managed environment, the MDM policy supercedes the local JSON; run the Team uninstaller (`--uninstall`) to clean up the local JSON and avoid conflicts:

```bash
curl -fsSL https://accessbridge.space/team/install.sh | bash -s -- --uninstall
```

### Step 4 — Verify

After deploying the ADMX, reload the extension on a test machine and check the extension popup for the "N settings managed by your organization" banner. Use `chrome://policy/` to confirm each policy key appears with `Source: Platform`.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Install script exits with `SHA-256 mismatch` | The downloaded zip was corrupted in transit or a stale Cloudflare edge served the wrong version | Re-run the installer — scripts always use `?v=<version>` URLs (BUG-010) to force cache revalidation. If the error persists, pass `--zip-url` pointing to the raw origin URL `https://accessbridge.space/downloads/accessbridge-extension.zip?v=<version>&nocache=1` |
| Chrome policy not applied — extension loads but shows no "managed by" banner | The policy JSON was written to the wrong path, or Chrome was not restarted after install | Run `--dry-run` to print the exact path the installer would write. Compare against the OS defaults in §4. Fully quit Chrome (not just close the window) and relaunch. On macOS, use `quit Chrome` from the Chrome menu, not the red button. |
| Chrome policy JSON present but `chrome://policy/` shows no AccessBridge keys | File permissions too restrictive — Chrome cannot read the JSON | On Linux, the file at `/etc/opt/chrome/policies/managed/accessbridge.json` must be `chmod 644` and owned by root. The installer sets this; check if a subsequent `umask` or `chmod` changed it. |
| Desktop agent not starting on Linux | systemd user service failed to enable | Run `systemctl --user status accessbridge-agent` and `journalctl --user -u accessbridge-agent -n 50`. Common cause: the agent binary path in the `.service` file does not match the install location. Re-run with `--log-file /tmp/ab-install.log` and inspect. |
| `pilot_id` not appearing in the observatory dashboard | The managed-policy JSON was written before the observatory server received the pilot registration | Wait 24 hours — pilot IDs appear after the first observatory POST from an enrolled device. If the dashboard still shows nothing after 48 hours, check that users enabled observatory opt-in in the popup. |
| Extension installs but shows "This extension is not from the Chrome Web Store" | Expected behavior for policy-sideloaded extensions in non-developer Chrome | This banner is cosmetic and does not affect functionality. For enterprise deployments that need this suppressed, see [docs/deployment/enterprise-chrome.md](enterprise-chrome.md) §6 for force-install with `installation_mode: force_installed`. |
| Installer refuses to write to target directory — `symlink detected` | The target path is a symlink — installer applies BUG-018 symlink refusal | Check whether your Chrome policy directory is a symlink. If your system uses a symlinked `/etc/opt` → `/opt`, pass `--chrome-policy-dir` with the real canonical path. |
| Profile JSON written with wrong permissions | Installer ran as root but `umask` was set to 022 | The installer writes profile JSON with `umask 077` before file creation (BUG-017/019 mode-on-creation rule), so the file should be `600` by default. If your deployment tool resets `umask`, pass `--log-file` and inspect the creation step. |

---

## 10. Security Model

### Download integrity — SHA-256 pinned checksums

Every install script downloads the extension zip from `https://accessbridge.space/downloads/accessbridge-extension.zip?v=<version>`. The `?v=` query parameter is mandatory — it prevents Cloudflare from serving a cached copy of a previous version (BUG-010 cache-bust rule). After download, the script computes the SHA-256 hash of the zip and compares it against the expected checksum published in the installer itself. If the hashes do not match, the installer exits with a non-zero code and removes the partially-downloaded file.

Note: AccessBridge Team mode uses pinned SHA-256 checksums, not GPG signatures. GPG-signed artifacts are reserved for Enterprise deployments; the GPG signing pipeline is documented in [docs/operations/signing.md](../operations/signing.md) §8. SHA-256 verification provides integrity guarantees equivalent to GPG for the download transit case — it does not provide key-based provenance (i.e. you trust the hash embedded in the install script, which you fetched over HTTPS with TLS certificate validation).

### Policy file writes — mode-on-creation and symlink refusal

Two BUG classes affect policy file writes on Linux and macOS:

**BUG-017/019 — mode-on-creation:** The installer uses `umask 077` before creating any profile JSON or policy file. This means the file is created with permissions `600` (owner read/write only) from the first `open()` system call. A `chmod` applied after file creation would leave a race window during which the file exists with weaker permissions. The mode-on-creation approach closes that window.

**BUG-018 — symlink refusal:** Before writing any file, the installer resolves the target path and refuses to write if the resolved path differs from the nominal path by more than a single canonical expansion (i.e. the path is a symlink pointing elsewhere). This prevents a local privilege-escalation scenario where an attacker pre-places a symlink at the target location that points to a sensitive file. If your environment's Chrome policy directory is symlinked, pass `--chrome-policy-dir` with the canonical real path.

### Network communications

- All downloads use HTTPS. The TLS certificate for `accessbridge.space` is validated by the system CA store on each OS.
- Observatory submissions use HTTPS to port 8300 via the nginx proxy. The observatory server never receives raw event payloads — only per-day aggregate counters with Laplace noise applied on-device before transmission.
- The desktop agent binds only to `127.0.0.1:8901`. It is not accessible from outside the machine. The PSK handshake uses `sha256(psk ‖ nonce)` verified with constant-time comparison. See [packages/desktop-agent/src-tauri/src/crypto.rs](../../packages/desktop-agent/src-tauri/src/crypto.rs) and [packages/desktop-agent/src-tauri/src/ipc_server.rs](../../packages/desktop-agent/src-tauri/src/ipc_server.rs).

### What Team mode does NOT provide

- **No per-user audit trail.** Observatory data is differentially private and cannot be attributed to individual users. If you need per-user access logs, use Enterprise mode with a dedicated observatory endpoint.
- **No policy lockdown.** Users can change any setting after installation. If a compliance requirement forbids users from, e.g., enabling cloud AI, you must upgrade to Enterprise mode and set `AllowCloudAITier = 0` in the ADMX.
- **No signing ceremony for the policy JSON.** The policy file is written by the install script. In environments with strict file-integrity monitoring (FIM), add the expected `accessbridge.json` SHA-256 to your FIM allowlist so the installer does not trip an alert.

---

*AccessBridge Team Deployment — maintained by Manish Kumar. For questions, open a GitHub Issue or check the pilot playbook at [docs/operations/pilot-playbook.md](../operations/pilot-playbook.md).*
