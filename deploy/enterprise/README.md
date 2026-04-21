# AccessBridge Enterprise Deployment Guide

This guide covers everything an IT administrator needs to deploy the AccessBridge Chrome extension and desktop agent at enterprise scale. It explains what enterprise deployment mode provides, which policy files to use on each platform, how to stage a rollout, how to interpret telemetry level settings, and how to perform an emergency rollback. All policy templates live in the subdirectories next to this file.

---

## Table of Contents

1. [Overview](#overview)
2. [Deployment Matrix](#deployment-matrix)
3. [Signing Requirements](#signing-requirements)
4. [Phased Rollout](#phased-rollout)
5. [Telemetry Per Phase](#telemetry-per-phase)
6. [Rollback Procedure](#rollback-procedure)
7. [FAQ](#faq)
8. [Files in This Directory](#files-in-this-directory)

---

## Overview

Enterprise deployment mode gives administrators control over which AccessBridge features are available to users, which telemetry level is in effect, and whether the desktop agent is required. Policies are delivered through the platform-native policy infrastructure — Windows Group Policy Objects (GPO), macOS Mobile Device Management (MDM) profiles, or a JSON file on Linux. Chrome reads these policies through the `chrome.storage.managed` namespace; the extension's background service worker picks them up at startup and re-applies them on each policy refresh. Policy values take precedence over user-set preferences for the keys they cover, but keys the administrator does not configure remain under user control. Force-installation is handled through the `ExtensionInstallForcelist` / `ExtensionSettings` Chrome policies, which live separately from the AccessBridge application policies described in this guide.

---

## Deployment Matrix

| Environment | Package file | Deploy tool | Best for | Effort |
|---|---|---|---|---|
| Windows GPO | `admx/AccessBridge.admx` + `en-US/AccessBridge.adml` | Group Policy Management Console (GPMC) | Active Directory domains; any size | Low — ADMX is self-documenting in GPMC |
| macOS MDM | `chrome-extension/AccessBridge.mobileconfig` | Jamf Pro / Kandji / Microsoft Intune; or manual System Preferences for ≤10 devices | Jamf-managed fleets; Apple School Manager | Medium — mobileconfig must be uploaded and scoped to a device group; force-install requires a Chrome management profile alongside |
| Linux JSON | `chrome-extension/chrome-policy.json` | Configuration management (Ansible / Chef / Puppet) or manual copy | Debian/Ubuntu/RHEL fleets running Chrome or Chromium | Low — one JSON file, one copy step, restart Chrome |
| Chrome Web Store Enterprise | N/A (use Chrome Browser Cloud Management) | Chrome Browser Cloud Management console | Organizations without on-premises AD; mixed OS environments | Medium-high — requires separate enrollment in Chrome Browser Cloud Management; not yet documented for AccessBridge; planned for a future session |

Note on Windows GPO: this is the best-supported path. The ADMX schema is validated, the ADML strings cover all 9 policies in both English (`en-US`) and Hindi (`hi-IN`), and behavior is tested against Chrome 88+ on Windows 10/11.

Note on macOS: the mobileconfig is provided and documented, but AccessBridge does not run a Jamf-integrated test environment. Admins should verify the mobileconfig profile loads correctly in their specific MDM before rolling out broadly.

Note on Chrome Web Store Enterprise: this path is mentioned for completeness. It requires registering the extension through the Chrome Web Store and enrolling browsers in Chrome Browser Cloud Management. It is not the recommended path for organizations that already operate Active Directory or MDM infrastructure.

---

## Signing Requirements

The Chrome extension CRX must be signed with a key whose public hash matches the extension ID deployed in your policy files. The desktop agent MSI must be signed with an EV code-signing certificate to suppress SmartScreen prompts at scale. Self-signed artifacts are suitable for pilot deployments only.

See [docs/operations/signing.md](../../docs/operations/signing.md) for:
- The dev vs. production key strategy
- How to sign the CRX and MSI
- How to store signing keys securely (Azure Key Vault / YubiKey HSM)
- The revocation flow if a key is compromised

---

## Phased Rollout

Staged deployment reduces risk by limiting the blast radius of a misconfigured policy and allows the compliance observatory to detect anomalies before full-scale impact.

### Wave 1 — Pilot (Week 1–2)

- **Scope:** 100 users selected from IT or a volunteer cohort
- **Policy configuration:**
  - `TelemetryLevel`: `aggregated`
  - `ObservatoryOptInRequired`: not configured (user opt-in)
  - `EnabledFeaturesLockdown`: not configured (all features user-controlled)
- **Goal:** Confirm the extension force-installs cleanly, `chrome://policy/` reports the correct values, and no unexpected Chrome policy conflicts arise
- **Exit criteria:** Zero force-install failures; `chrome.storage.managed` populates correctly on all pilot devices; no critical bugs filed in the first week

### Wave 2 — Department (Week 3–4)

- **Scope:** 1,000 users in a target department (e.g. customer support, HR)
- **Policy configuration:**
  - `TelemetryLevel`: `aggregated`
  - `ObservatoryOptInRequired`: `1` (force opt-in for compliance reporting)
  - `DefaultLanguage`: set if the department has a dominant language preference
- **Goal:** Exercise the compliance observatory at department scale; confirm `orgHash` appears correctly in the observatory dashboard
- **Exit criteria:** Observatory dashboard shows department-level data; no policy application failures reported by helpdesk; update mechanism confirmed working

### Wave 3 — Enterprise (Week 5+)

- **Scope:** 10,000+ users across all departments
- **Policy configuration:** Per-department OU policies may override the domain-level defaults; telemetry level is set per organizational policy
- **Goal:** Full coverage; administrators use OU-level GPO overrides for department-specific feature lockdowns
- **Exit criteria:** All OUs report correct policy application in `gpresult`; observatory dashboard available for HR/compliance team; helpdesk ticket volume within expected range

---

## Telemetry Per Phase

AccessBridge supports three telemetry levels controlled by the `TelemetryLevel` policy. These levels are orthogonal to the user's individual opt-in toggle: the policy sets the ceiling, not the floor.

| Level | What is collected | User can opt out? |
|---|---|---|
| `none` | Nothing. No data leaves the browser. | N/A |
| `aggregated` | Daily anonymized feature-usage counters with Laplace differential-privacy noise applied before transmission. No URLs, no content, no user identifiers. | Yes — user can toggle off in the extension settings. Policy value sets the maximum; it does not force enrollment. |
| `full` | Same as `aggregated` plus coarser session-duration buckets. Still no URLs, content, or identifiers. | Yes, unless `ObservatoryOptInRequired=1` forces enrollment. |

The privacy guarantee is architectural, not administrative: the extension's `observatory-publisher.ts` applies Laplace noise to all counters before the HTTP POST. The administrator cannot configure the noise parameter or disable the anonymization layer. Even with `TelemetryLevel=full` and `ObservatoryOptInRequired=1`, the transmitted data cannot be traced to an individual user.

For a detailed description of the telemetry pipeline, the Merkle commitment scheme, and the zero-knowledge attestation layer, see [docs/features/compliance-observatory.md](../../docs/features/compliance-observatory.md).

The `orgHash` field in telemetry payloads is a Merkle hash generated by the Session 20 observatory pipeline. It identifies the organization cohort without revealing the organization's identity to anyone reading the raw publish stream. See Sonnet #4's observatory changes in `ops/observatory/server.js` for the derivation details.

---

## Rollback Procedure

### Windows GPO

1. Open Group Policy Management Console.
2. Navigate to the GPO that enables `AccessBridgeForcedInstall` or `AccessBridgeExtensionSettings`.
3. To block the extension immediately: open Computer Configuration → Policies → Administrative Templates → Google → Google Chrome → Extensions → Extension blocklist. Add the AccessBridge extension ID to `ExtensionInstallBlocklist`. This supersedes the force-install setting and removes the extension from all managed browsers within one policy refresh cycle (default: ~90 minutes, or `gpupdate /force` to refresh immediately).
4. To fully revert: delete or disable the `AccessBridgeForcedInstall` setting in the GPO. The extension will be removed on the next Chrome restart on managed devices.
5. For the desktop agent (when the MSI is available): deploy an uninstall script via SCCM or Intune using the MSI product code. See [docs/deployment/sccm-intune.md](../../docs/deployment/sccm-intune.md).

### macOS MDM

1. In Jamf Pro / Kandji: navigate to the profile containing the AccessBridge Chrome extension policy.
2. Remove the force-install configuration profile or remove the AccessBridge entry from `ExtensionInstallForcelist`.
3. Push the updated profile to the device group. Chrome will remove the force-installed extension on the next policy sync.
4. If the extension was also added to `ExtensionSettings` with `installation_mode: force_installed`, add an entry with `installation_mode: blocked` to the same `ExtensionSettings` key to prevent reinstallation.

### Linux JSON

1. Remove or empty the JSON file at `/etc/opt/chrome/policies/managed/accessbridge.json`.
2. If you want to block reinstallation, add the extension ID to an `ExtensionInstallBlocklist` entry in the same file before removing the force-install entry.
3. Restart Chrome on affected machines. The policy change takes effect on the next Chrome startup.

### Emergency — All Platforms

If a compromised extension version must be blocked immediately across all platforms simultaneously:
1. Add the extension ID to `ExtensionInstallBlocklist` via GPO (Windows) or MDM profile (macOS) or JSON policy (Linux).
2. Notify the AccessBridge team to push a remediated signed version.
3. After the new version is available, remove the blocklist entry and re-add the force-install setting.
4. See [docs/operations/signing.md](../../docs/operations/signing.md) §Revocation Flow for the key-compromise signing procedure.

---

## FAQ

**Q: We sign users into Chrome with personal Google accounts on unmanaged browsers. Will the managed policies apply?**

No. Chrome's managed policy (from ADMX/mobileconfig/JSON) applies to Chrome installations on managed computers, not to Chrome profiles signed in with personal Google accounts on unmanaged machines. If a user installs Chrome on a personal laptop and signs in with their personal account, that Chrome installation does not pick up machine-level policies from your domain. Policies are machine-scoped (`class="Machine"` in the ADMX), so they require the machine to be enrolled in the domain (Windows) or MDM (macOS).

**Q: What happens when a managed laptop is off the corporate network (e.g. a remote employee)?**

The extension continues to function with the last-applied policy values cached in Chrome's policy store. Policy values are not re-fetched from the domain controller while the device is off-network; they persist from the last successful `gpupdate` or MDM sync. Feature functionality that does not require outbound access (all sensory, cognitive, and motor features) works fully offline. Observatory telemetry is buffered locally and published when connectivity resumes; if publishing fails for more than one day the daily counter is discarded (not retried indefinitely) to prevent stale data from inflating observatory counts.

**Q: Our users are on VPN. Are there specific hostnames AccessBridge must reach?**

For self-update checks and observatory telemetry, the extension contacts `https://accessbridge.space`. This is the nginx reverse-proxy endpoint (port 8300 internally). VPN-split-tunnel configurations should allowlist `accessbridge.space`. If the update endpoint is unreachable the extension continues to work; it will not apply updates until connectivity is restored. There is no hard requirement on update connectivity for basic accessibility functionality.

**Q: We want users to be able to override a few policy keys (e.g. `DefaultLanguage`) but not others. Is that supported?**

Partially. The `packages/extension/src/background/enterprise/policy.ts` merge logic applies policy values from `chrome.storage.managed` as overrides over user-stored values in `chrome.storage.local`. If a key is present in `chrome.storage.managed`, the policy value wins and the user-facing control for that key is grayed out in the extension UI. If a key is absent from `chrome.storage.managed`, the user's preference applies. To allow a user override for a specific key, simply do not configure that policy in your ADMX/JSON/mobileconfig. This is the correct pattern: configure only the keys you want locked; leave everything else unconfigured.

**Q: Chrome shows "An administrator policy prevents changes to these settings" but the policy never took effect (the features are not actually locked). What is wrong?**

The extension's policy reader polls `chrome.storage.managed` at startup and on the `chrome.storage.onChanged` event. If Chrome shows the managed policy banner but the extension behavior does not reflect it, the likely cause is that the extension was already running with a cached `chrome.storage.local` value that was not cleared when the policy was deployed. Try: (1) open `chrome://extensions/` → find AccessBridge → click the reload icon; (2) if still not applied, disable and re-enable the extension from `chrome://extensions/`. If the extension was sideloaded (dev mode) rather than force-installed, managed policies may not apply — see the next question.

**Q: How do we verify the policy took effect?**

1. On a managed device, open `chrome://policy/` in Chrome. Scroll to the "Extension policies" section and find the AccessBridge extension ID. All configured policy keys should appear with their values and `Source: Platform`.
2. Open the AccessBridge extension popup → look for the "N settings managed by your organization" banner at the top. The number N should equal the count of policies you configured.
3. Open Chrome DevTools on any page → navigate to the extension background service worker (via `chrome://extensions/` → AccessBridge → "Service worker" link) → in the console, run `chrome.storage.managed.get(null, console.log)`. The output should show all configured policy keys and their values.
4. Run `gpresult /h policy-report.html /scope computer` on Windows and open the HTML report. Find the AccessBridge GPO under "Applied GPOs". See [docs/deployment/group-policy.md](../../docs/deployment/group-policy.md) §Test Against gpresult for the full verification workflow.

---

## Files in This Directory

```
deploy/enterprise/
├── README.md                                  ← This file
│
├── admx/                                      ← AccessBridge application ADMX (9 policies)
│   ├── AccessBridge.admx                      ← Policy definitions (machine-scoped)
│   ├── en-US/                                 ← English ADML strings (copy to PolicyDefinitions\en-US\)
│   │   └── AccessBridge.adml
│   └── hi-IN/                                 ← Hindi ADML strings (copy to PolicyDefinitions\hi-IN\)
│       └── AccessBridge.adml
│
└── chrome-extension/                          ← Chrome extension force-install templates
    ├── AccessBridge-ChromeExtension.admx      ← ADMX for Chrome Extensions GPO node (Windows)
    ├── AccessBridge-ChromeExtension.adml      ← ADML strings for the above
    ├── AccessBridge.mobileconfig              ← Apple MDM profile (macOS; Jamf/Kandji/Intune)
    ├── chrome-policy.json                     ← Linux managed policy JSON
    └── updates.xml                            ← Chrome extension update manifest (self-hosted CRX)
```

**Note:** A `desktop-agent/` subdirectory containing the signed MSI and MST transform file will be added in Session 21 when the production MSI build pipeline is complete. See [docs/deployment/sccm-intune.md](../../docs/deployment/sccm-intune.md) for the SCCM/Intune deployment workflow that will use those artifacts.

Related documentation:
- [Enterprise Chrome deployment](../../docs/deployment/enterprise-chrome.md) — step-by-step GPO, MDM, and Linux instructions
- [Group Policy reference](../../docs/deployment/group-policy.md) — detailed policy reference with example configurations
- [SCCM/Intune deployment](../../docs/deployment/sccm-intune.md) — desktop agent deployment (forward-looking; Session 21)
- [Signing strategy](../../docs/operations/signing.md) — key management, CRX and MSI signing, revocation
- [Compliance Observatory](../../docs/features/compliance-observatory.md) — telemetry pipeline details
- [Feature catalog](../../FEATURES.md) — full list of 34 features and their IDs

---

## Policy Keys Quick Reference

The table below lists every policy key the extension reads from `chrome.storage.managed`. Keys absent from managed storage are fully user-controlled. Use this as a one-page summary when authoring policy files or debugging `chrome://policy/` output.

| Key | Type | Valid values | Affects |
| --- | --- | --- | --- |
| `EnabledFeaturesLockdown` | string array | Feature IDs from [FEATURES.md](../../FEATURES.md) | Locks listed features ON; user cannot disable |
| `DisabledFeaturesLockdown` | string array | Feature IDs from [FEATURES.md](../../FEATURES.md) | Locks listed features OFF; user cannot enable |
| `ObservatoryOptInRequired` | integer | `0` or `1` | `1` = force observatory enrollment; `0` = force opt-out |
| `TelemetryLevel` | string | `"none"`, `"aggregated"`, `"full"` | Maximum telemetry level; user may lower to `"none"` unless `ObservatoryOptInRequired=1` |
| `AllowCloudAITier` | integer | `0` or `1` | `0` = cloud AI providers blocked (default); `1` = permitted |
| `CustomAPIEndpoint` | string | HTTPS URL | Overrides the built-in AI provider URL |
| `DefaultLanguage` | string | BCP-47 tag (e.g. `"en-US"`, `"hi-IN"`) | Default language for voice commands and captions |
| `ProfileSyncMode` | string | `"off"`, `"local-only"`, `"relay"` | Controls profile sync scope |
| `MinimumAgentVersion` | string | Semver (e.g. `"0.21.0"`) | Extension warns if paired agent is below this version |

Policy key names are case-sensitive and must match exactly. The extension's `packages/extension/src/background/enterprise/policy.ts` reads these keys at startup and on every `chrome.storage.onChanged` event.

---

## Security Considerations

### Least Privilege

Configure only the policies you need. Every policy key you set narrows the user's ability to adjust their own accessibility experience. Accessibility tools should default to user control; administrator policy should be the exception, not the rule.

The recommended approach is:

1. Set `TelemetryLevel` and `ObservatoryOptInRequired` at the domain level if compliance reporting is required.
2. Set `AllowCloudAITier = 0` at the domain level if data residency is a concern.
3. Use `EnabledFeaturesLockdown` and `DisabledFeaturesLockdown` only at the OU level for specific scenarios (kiosks, legal, etc.).
4. Leave `DefaultLanguage`, `ProfileSyncMode`, and `MinimumAgentVersion` unconfigured unless you have a specific operational reason.

### Policy Integrity

The Chrome extension reads policies from `chrome.storage.managed`, which is populated by Chrome from the operating system policy store (HKLM registry, MDM profile, or JSON file). The extension does not validate the source of these values beyond trusting the OS policy infrastructure. This means:

- On a domain-joined machine, only domain admins can write to `HKLM\SOFTWARE\Policies\AccessBridge`. Protect your domain admin credentials accordingly.
- On an unmanaged machine, a local administrator can write to the local machine policy store and affect the extension's behavior. This is expected; do not deploy the extension to machines where you do not trust the local administrator.

### Data Residency and Cloud AI

The `AllowCloudAITier` policy defaults to `0` (blocked) in managed environments. When set to `1`, the extension may send page content to external AI providers (Gemini or Claude) for summarization and text simplification. Review the data-processing agreements of these providers before enabling this policy in regulated industries (healthcare, legal, financial services). The local AI tier (offline, rule-based) is always available regardless of this policy setting.

### Observatory Privacy Guarantees

The observatory telemetry pipeline applies Laplace differential-privacy noise to all counters before transmission. This is enforced in `packages/extension/src/background/observatory-publisher.ts` and cannot be disabled by policy. Even with `ObservatoryOptInRequired = 1` and `TelemetryLevel = full`, the transmitted data cannot be reverse-engineered to identify an individual user's behavior. The privacy guarantee is architectural, not administrative — it holds even if the VPS is compromised or the policy administrator is malicious.

---

## Deployment Checklist

Use this checklist before completing each wave of the phased rollout.

### Pre-deployment (all waves)

- [ ] Real extension ID confirmed and substituted in all policy files (`chrome-policy.json`, `AccessBridge-ChromeExtension.admx`, `AccessBridge.mobileconfig`)
- [ ] `updates.xml` hosted at `https://accessbridge.space/chrome/updates.xml` and returning a valid XML response (verify with `curl`)
- [ ] CRX signing key backed up; extension ID recorded in the deployment runbook
- [ ] ADMX files copied to PolicyDefinitions central store; GPMC shows AccessBridge category without errors
- [ ] Target OU / device group / managed policy directory created and populated
- [ ] Network allowlist updated: `accessbridge.space` reachable on HTTPS from client machines
- [ ] WebView2 Runtime deployed to Windows 10 clients (if desktop agent is included in this wave)

### Post-deployment verification (per wave)

- [ ] `chrome://policy/` on a sample client shows AccessBridge policies with `Source: Platform`
- [ ] Extension appears with "Installed by policy" badge in `chrome://extensions/`
- [ ] Extension popup shows "N settings managed by your organization" banner
- [ ] `chrome.storage.managed.get()` in the extension SW console returns the expected keys
- [ ] Observatory dashboard (if `ObservatoryOptInRequired=1`) shows new device enrollments within 24 hours
- [ ] Helpdesk ticket volume monitored for unexpected installation failures or user complaints
- [ ] `gpresult /h` report reviewed for each OU; no denied GPOs

### Rollback readiness

- [ ] `ExtensionInstallBlocklist` policy prepared and tested in a staging GPO; can be promoted to production within 15 minutes
- [ ] MSI uninstall string documented in the deployment runbook (for desktop agent)
- [ ] Admin email distribution list prepared for key-compromise notification scenario

---

## Session 20 Status

The following items are complete as of Session 20:

- All ADMX/ADML policy files for the Chrome extension and AccessBridge application policies (9 policies)
- macOS mobileconfig template
- Linux managed policy JSON
- `updates.xml` update manifest
- This README and the four deployment guides listed below

The following items are deferred to Session 21:

- Signed MSI artifact for the desktop agent (`deploy/enterprise/desktop-agent/`)
- Silent MST transform file
- `tools/sign-extension.sh` and `tools/sign-package.ps1`
- Azure Key Vault integration for CI signing
- EV code-signing certificate procurement

See [docs/operations/signing.md](../../docs/operations/signing.md) for the complete signing strategy and the blockers for 250k-scale production deployment.
