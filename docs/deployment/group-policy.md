# AccessBridge Group Policy Reference

This guide covers the AccessBridge-specific ADMX (`AccessBridge.admx`) that ships in `deploy/enterprise/admx/`. It documents all 9 policies, explains how to install the ADMX to the SYSVOL central store, describes policy precedence and conflict resolution, gives GPO linking recommendations, and provides four worked example configurations for common enterprise scenarios. For force-installing the Chrome extension via Group Policy, see [docs/deployment/enterprise-chrome.md](enterprise-chrome.md). For an overview of the full enterprise artifact set, see [deploy/enterprise/README.md](../../deploy/enterprise/README.md).

---

## Table of Contents

1. [Overview — The 9 Policies at a Glance](#overview--the-9-policies-at-a-glance)
2. [Install the ADMX to the Central Store](#install-the-admx-to-the-central-store)
3. [Policy Precedence](#policy-precedence)
4. [GPO Linking Recommendations](#gpo-linking-recommendations)
5. [Example Configurations](#example-configurations)
6. [Test Against gpresult](#test-against-gpresult)
7. [Verifying on the Client](#verifying-on-the-client)

---

## Overview — The 9 Policies at a Glance

All policies write to `HKLM\SOFTWARE\Policies\AccessBridge`. The extension's `packages/extension/src/background/enterprise/policy.ts` reads them from `chrome.storage.managed` at startup and on every managed-storage change event.

| Policy Name | What it controls | Registry type | Default if not configured |
|---|---|---|---|
| `EnabledFeaturesLockdown` | List of feature names that are forcibly enabled; user cannot toggle them off | `REG_MULTI_SZ` | No features locked on |
| `DisabledFeaturesLockdown` | List of feature names that are forcibly disabled; user cannot toggle them on | `REG_MULTI_SZ` | No features locked off |
| `ObservatoryOptInRequired` | Whether the compliance observatory opt-in is mandatory (`1`) or forced off (`0`) | `REG_DWORD` | User's own opt-in toggle controls enrollment |
| `TelemetryLevel` | Maximum telemetry level: `none`, `aggregated`, or `full` | `REG_SZ` | `aggregated` (user can lower to `none` in settings) |
| `AllowCloudAITier` | Whether Tier 2 cloud AI providers (Gemini, Claude) are permitted | `REG_DWORD` | `0` — cloud AI off by default in managed environments |
| `CustomAPIEndpoint` | Override the AI provider URL with a custom endpoint (e.g. an internal LLM proxy) | `REG_SZ` | Not configured — extension uses its built-in provider URLs |
| `DefaultLanguage` | BCP-47 language tag for the extension's default language (`en-US`, `hi-IN`, etc.) | `REG_SZ` | Not configured — user's browser locale is used |
| `ProfileSyncMode` | Whether the accessibility profile syncs: `off`, `local-only`, or `relay` | `REG_SZ` | `local-only` — profile stays on the device |
| `MinimumAgentVersion` | Minimum semver for the AccessBridge desktop agent; extension warns if the paired agent is below this version | `REG_SZ` | Not configured — any agent version is accepted |

Feature names used in `EnabledFeaturesLockdown` and `DisabledFeaturesLockdown` match the feature IDs and canonical names in [FEATURES.md](../../FEATURES.md). Examples: `high_contrast`, `reduced_motion`, `reading_mode`, `live_captions`, `action_items`, `auto_summarize`, `vision_recovery`, `voice_navigation`, `keyboard_only`, `eye_tracking`. Use the internal key names, not the display strings shown in the extension popup.

The `AllowCloudAITier` policy defaults to blocked (`0`) in managed environments. This is intentional: cloud AI features (C-05 Auto-Summarize, C-06 Text Simplification via Gemini or Claude) send page content to external providers, which may be inappropriate for environments with strict data residency requirements. Enable this policy only after your legal/compliance team has reviewed the [AI engine documentation](../../docs/features/ai-engine.md) and the provider data-processing agreements.

---

## Install the ADMX to the Central Store

The SYSVOL central store is the recommended location. All domain controllers replicate files in SYSVOL automatically, so the ADMX is immediately available from any management workstation without local copies.

### Copy the ADMX

```cmd
:: Replace <domain> with your fully-qualified domain name
:: Example: corp.example.com

xcopy /Y "deploy\enterprise\admx\AccessBridge.admx" ^
  "\\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions\"

xcopy /Y "deploy\enterprise\admx\en-US\AccessBridge.adml" ^
  "\\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions\en-US\"
```

If you support Hindi-language administrators or want Hindi strings in GPMC:

```cmd
xcopy /Y "deploy\enterprise\admx\hi-IN\AccessBridge.adml" ^
  "\\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions\hi-IN\"
```

### Verify the import

1. Open Group Policy Management Console (`gpmc.msc`).
2. Edit any GPO → navigate to **Computer Configuration → Policies → Administrative Templates → AccessBridge**.
3. You should see five subcategories: **Accessibility**, **Privacy**, **AI Engine**, **Profile**, **Agent**.
4. Open any policy (e.g. **TelemetryLevel**) to verify the display name and description strings loaded correctly from the ADML.

If the AccessBridge category does not appear after closing and reopening GPMC, check that the `.admx` file is in `PolicyDefinitions\` (not in a subdirectory) and that the `.adml` file is in `PolicyDefinitions\en-US\`. GPMC caches the ADMX list; restarting GPMC clears the cache.

### Local machine alternative

For environments without a central store (small domains or workgroup machines):

```cmd
xcopy /Y "deploy\enterprise\admx\AccessBridge.admx" "%SystemRoot%\PolicyDefinitions\"
xcopy /Y "deploy\enterprise\admx\en-US\AccessBridge.adml" "%SystemRoot%\PolicyDefinitions\en-US\"
```

This makes the ADMX visible only in the local Group Policy Editor (`gpedit.msc`) on the machine where the files were copied, not in domain GPMC.

---

## Policy Precedence

### GPO Application Order

Windows applies Group Policy Objects in this order, from lowest to highest priority (later overwrites earlier):

1. **Local GPO** — `gpedit.msc` settings on the local machine
2. **Site-linked GPOs** — linked to the Active Directory site containing the computer
3. **Domain-linked GPOs** — linked to the domain root
4. **OU-linked GPOs** — applied from the top-level OU down to the OU containing the computer account; child OUs have higher priority than parent OUs
5. **User-scoped GPOs** — applied after computer GPOs if the computer policy allows it; AccessBridge ADMX policies are `class="Machine"` and are not affected by user GPO order

When multiple GPOs configure the same policy key, the last-applied value wins. In practice this means OU-linked GPOs override domain-linked GPOs, which override site-linked GPOs.

### AccessBridge Conflict Resolution

When both `EnabledFeaturesLockdown` and `DisabledFeaturesLockdown` are configured and a feature appears in both lists (which would be an authoring error), the `policy.ts` merge logic resolves the conflict by applying the most restrictive rule: if a feature is in `DisabledFeaturesLockdown`, it is disabled even if it also appears in `EnabledFeaturesLockdown`. This matches Chrome's own policy conflict resolution philosophy.

If two GPOs at different levels both configure `TelemetryLevel`, the standard GPO last-writer-wins rule applies: the OU-level GPO value overrides the domain-level value, regardless of whether the OU value is more or less restrictive. Administrators who want a floor (minimum telemetry level that OU admins cannot lower) must enforce that floor through other means, such as restricting who can edit the lower-priority GPO.

The `EnabledFeaturesLockdown` and `DisabledFeaturesLockdown` policies are `REG_MULTI_SZ` (multi-string) values. GPO merge for `REG_MULTI_SZ` replaces the whole value — it does not append. If a domain-level GPO sets `EnabledFeaturesLockdown = [high_contrast]` and an OU-level GPO sets `EnabledFeaturesLockdown = [reading_mode]`, the OU-level value wins and `high_contrast` is not locked on for users in that OU. If you need both features locked on, list both in the OU-level GPO.

---

## GPO Linking Recommendations

### Site Level — Enterprise-Wide Defaults

Link a GPO at the site level to set defaults that apply to every computer in the organization, regardless of which OU the computer account lives in. Use this for:

- `TelemetryLevel = aggregated` as the organization-wide default
- `AllowCloudAITier = 0` as an organization-wide block on cloud AI (override at OU level for departments that have approved it)
- `MinimumAgentVersion` — the minimum version your IT team supports

Site-level policies are useful for properties that should be universally true, but they have the lowest precedence. Any OU can override them.

### OU Level — Department Overrides

Link a GPO to a specific OU to customize behavior for a department. Examples:

- A legal department OU with `TelemetryLevel = none` and `DisabledFeaturesLockdown = [auto_summarize, vision_recovery]`
- An accessibility team OU with `AllowCloudAITier = 1` to allow cloud AI features
- A regional office OU with `DefaultLanguage = hi-IN`

OU-linked policies take precedence over site- and domain-level policies. This is the correct tier for department-specific customizations.

### Loopback Processing — Managed Kiosks

For kiosk scenarios (shared devices in hospital waiting rooms, library terminals, retail kiosks), enable **Group Policy Loopback Processing** in Merge or Replace mode. Loopback causes the computer-side GPO to also apply user-scoped settings, which is needed when multiple users log in to the same kiosk machine and you want a consistent extension policy regardless of who is logged in.

To enable loopback: **Computer Configuration → Policies → Administrative Templates → System → Group Policy → Configure user Group Policy loopback processing mode** → set to **Enabled**, mode **Merge** (to add computer-side user policies to user-side GPOs) or **Replace** (to discard user-side GPOs entirely and apply only computer-side GPOs).

For kiosk deployments, Replace mode is typically appropriate: the computer's access policy should override any user-level preferences entirely.

---

## Example Configurations

The following four scenarios show the exact policy values to configure for common enterprise deployment patterns. Apply each as a GPO linked at the appropriate level.

### Scenario 1 — Accessibility-First Shared Kiosk

**Use case:** Hospital waiting room, library terminal, or retail kiosk. Multiple anonymous users per day. Privacy is paramount; no telemetry. Specific accessibility features are always on.

**Policy values:**

| Policy | Value |
|---|---|
| `EnabledFeaturesLockdown` | `high_contrast` / `reduced_motion` / `reading_mode` |
| `DisabledFeaturesLockdown` | `auto_summarize` / `vision_recovery` |
| `DefaultLanguage` | `en-US` |
| `TelemetryLevel` | `none` |
| `ObservatoryOptInRequired` | `0` (force opt-out) |
| `AllowCloudAITier` | `0` (blocked) |
| `ProfileSyncMode` | `off` |

**Explanation:** High contrast, reduced motion, and reading mode are mandated on because they benefit users with visual or cognitive impairments who may not know to enable them. Auto-summarize and vision recovery are disabled because they may send content to external services. Telemetry is off because kiosk users do not consent individually. Profile sync is off because kiosk profiles should not persist between sessions or follow users to their personal devices.

**GPO link:** OU containing the kiosk computer accounts. Enable loopback processing in Replace mode.

### Scenario 2 — Hindi-First Regional Office

**Use case:** A regional office where most employees prefer Hindi. Live captions and action items are prioritized. Aggregated telemetry is acceptable for compliance reporting.

**Policy values:**

| Policy | Value |
|---|---|
| `DefaultLanguage` | `hi-IN` |
| `EnabledFeaturesLockdown` | `live_captions` / `action_items` |
| `TelemetryLevel` | `aggregated` |
| `ObservatoryOptInRequired` | `1` |
| `AllowCloudAITier` | `0` |

**Explanation:** Setting `DefaultLanguage = hi-IN` activates the Hindi voice commands (M-02), captions in Hindi, and the Hindi domain connector vocabulary where applicable. Live captions and action items are force-enabled because the office has identified them as productivity essentials. Cloud AI is blocked because data residency requirements apply; the local AI tier (offline rule-based summarization) is available and acceptable for this office.

**GPO link:** OU containing employee computer accounts for the regional office.

### Scenario 3 — Privacy-Sensitive Legal Department

**Use case:** Legal department handling privileged communications. No AI features that could exfiltrate content. No telemetry. Full keyboard and sensory accessibility support is fine.

**Policy values:**

| Policy | Value |
|---|---|
| `AllowCloudAITier` | `0` |
| `TelemetryLevel` | `none` |
| `ObservatoryOptInRequired` | `0` |
| `DisabledFeaturesLockdown` | `auto_summarize` / `vision_recovery` |

**Explanation:** Cloud AI is blocked. `auto_summarize` and `vision_recovery` are in the disabled lockdown list because both can optionally route through the Gemini/Claude providers (Tier 2) if the user has an API key configured — disabling them at the policy level prevents any route to external AI for these features, even if a user has a personal API key. All sensory (S-01 through S-07), cognitive focus features (C-01 through C-04, C-07), and motor features (M-01 through M-09) that do not touch AI are unaffected and remain user-controllable.

**GPO link:** OU containing legal department computer accounts. Apply at OU level to override any site-level defaults.

### Scenario 4 — Full Rollout with Observatory

**Use case:** Organization-wide deployment with compliance reporting enabled. HR and compliance teams use the observatory dashboard to verify accessibility tool adoption across departments.

**Policy values:**

| Policy | Value |
|---|---|
| `TelemetryLevel` | `aggregated` |
| `ObservatoryOptInRequired` | `1` |
| `AllowCloudAITier` | `0` |
| `ProfileSyncMode` | `local-only` |

**orgHash configuration:**

The `orgHash` field in telemetry payloads is not a Group Policy — it is generated by the observatory pipeline. To associate a department's telemetry with its Merkle cohort:

1. On the VPS, run the Session 20 observatory server (`ops/observatory/server.js`) which now accepts an `orgHash` in the POST body.
2. Generate the department Merkle hash using the instructions in the observatory documentation or ask Sonnet #4's changes to `ops/observatory/server.js` for the derivation API.
3. Distribute the `orgHash` value to the extension via a `CustomAPIEndpoint` policy value pointing to an internal endpoint that includes the `orgHash` in its response headers, or via a future `OrgHash` policy key planned for Session 21.

**Explanation:** Aggregated telemetry with forced opt-in gives HR/compliance teams visibility into department-level adoption patterns without collecting any personally identifiable information. The observatory's differential-privacy layer (Laplace noise applied before every POST) is architectural and cannot be disabled by policy. Even with `ObservatoryOptInRequired=1`, no individual user's behavior is recoverable from the published data. See [docs/features/compliance-observatory.md](../features/compliance-observatory.md) for the privacy model and data schema.

**GPO link:** Domain root or site level for the organization-wide default. Department OUs can override `TelemetryLevel` down to `none` if individual departments are exempt.

---

## Test Against gpresult

`gpresult` produces an HTML or XML report of which GPOs were applied to a computer and what values they set. Use it to verify that your AccessBridge GPO was applied correctly.

### Generate the report

Run on the managed client (requires administrator rights):

```cmd
gpresult /h "%USERPROFILE%\Desktop\gpresult-report.html" /scope computer /f
```

Parameters:
- `/h`: output format HTML (more readable than `/x` XML for manual inspection)
- `/scope computer`: include only computer-scoped GPOs (AccessBridge ADMX policies are all `class="Machine"`)
- `/f`: force — overwrite the output file if it exists

Open `gpresult-report.html` in a browser.

### What to look for

1. **"Applied GPOs" section:** Verify the GPO containing your AccessBridge settings appears with a green checkmark (Applied). A red X or "Denied (Security Filtering)" means the computer account is not in the security group the GPO targets.

2. **"Computer settings" → "Policies" → "Administrative Templates":** Expand the AccessBridge category. Each policy you configured should appear here with its value and the GPO name that set it.

3. **"Winning GPO" column:** If the same policy key is set in multiple GPOs, the report shows which one won. Use this to diagnose unexpected values when multiple GPOs target the same computer.

4. **"Denied GPOs" section:** If your AccessBridge GPO appears here, check the security filtering settings on the GPO in GPMC. The computer account (not just the user account) must be in the "Security Filtering" group.

### Force policy refresh before running gpresult

```cmd
gpupdate /force
gpresult /h "%USERPROFILE%\Desktop\gpresult-report.html" /scope computer /f
start "%USERPROFILE%\Desktop\gpresult-report.html"
```

The `gpupdate /force` ensures the latest GPO values are applied before the report is generated; without it, the report may reflect the previous policy cycle's values.

---

## Verifying on the Client

After `gpupdate /force` and Chrome restart, verify that policies reached the extension:

### Method 1 — Extension popup banner

Open the AccessBridge Chrome extension by clicking its toolbar icon. The popup banner near the top should display:

```
N settings managed by your organization
```

Where N is the number of AccessBridge application policies you configured. If this banner does not appear, either no policies are configured (expected if you only set force-install), or the extension has not yet read the managed storage values. Try reloading the extension from `chrome://extensions/`.

### Method 2 — `chrome://policy/`

Navigate to `chrome://policy/` in Chrome. In the "Extension policies" section, find the AccessBridge extension ID row. Each configured policy key should appear with:
- **Level:** Machine
- **Scope:** Machine
- **Source:** Platform
- **Status:** OK
- **Value:** the value you configured

A `Source` of `Cloud` or `User` means the value is coming from a different source than GPO. Verify the ADMX is in the central store and `gpupdate /force` was run.

### Method 3 — DevTools inspection

For a programmatic verification:

1. Open Chrome → navigate to `chrome://extensions/`.
2. Find AccessBridge → click "Service Worker" to open the background service worker DevTools.
3. In the console, run:

```javascript
chrome.storage.managed.get(null, function(items) {
  console.log('Managed policy values:');
  console.log(JSON.stringify(items, null, 2));
});
```

The output should contain every key you configured via ADMX. Example output for Scenario 2 (Hindi regional office):

```json
{
  "DefaultLanguage": "hi-IN",
  "EnabledFeaturesLockdown": ["live_captions", "action_items"],
  "TelemetryLevel": "aggregated",
  "ObservatoryOptInRequired": 1,
  "AllowCloudAITier": 0
}
```

If `chrome.storage.managed.get()` returns an empty object `{}` despite `chrome://policy/` showing the correct values, the extension's `chrome.storage.managed` access may not be initialized. This can happen if the extension was loaded before the policy was applied. Reload the extension from `chrome://extensions/` and retry.

### Method 4 — Locked controls in the extension UI

Navigate the extension popup to the affected features. Controls for features covered by `EnabledFeaturesLockdown` or `DisabledFeaturesLockdown` should appear grayed out with a lock icon or a "Managed by your organization" tooltip. This visual feedback is rendered by the extension UI when `policy.ts` returns a locked state for that feature key.
