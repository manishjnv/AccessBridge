# Enterprise Chrome Extension Deployment

This guide explains how to force-install the AccessBridge Chrome extension and apply managed policies on Windows (Group Policy), macOS (MDM), and Linux (JSON). It covers the exact file-copy steps, verification checklist, and common problems with their fixes. For an overview of all enterprise artifacts and the phased rollout strategy, see [deploy/enterprise/README.md](../../deploy/enterprise/README.md).

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Windows — ADMX via Group Policy](#windows--admx-via-group-policy)
3. [macOS — mobileconfig via MDM](#macos--mobileconfig-via-mdm)
4. [Linux — Managed Policy JSON](#linux--managed-policy-json)
5. [Verification Checklist](#verification-checklist)
6. [Common Problems](#common-problems)

---

## Prerequisites

- **Chrome version:** 88 or later on all client machines. Managed policy for extensions uses the `ExtensionInstallForcelist` and `ExtensionSettings` Chrome policy nodes, which have been stable since Chrome 88.
- **Admin rights:** You need domain admin (Windows), MDM admin (macOS/Intune), or root access (Linux) to deploy policy files.
- **Extension ID:** The AccessBridge extension has a fixed ID tied to its signing key. The placeholder ID in the template files is `abcdefghijklmnopqrstuvwxyzabcdef`. Replace this with the real extension ID before deploying. The real ID is visible on `chrome://extensions/` when the extension is loaded, and it must match the ID embedded in your `updates.xml` and policy files. See [docs/operations/signing.md](../operations/signing.md) for how the extension ID is derived from the signing key.
- **Extension host URL:** The update manifest is served at `https://accessbridge.space/chrome/updates.xml`. This URL must be reachable from client machines. If your network uses a proxy or allowlist, add `accessbridge.space` before deploying.
- **Policy deployment tool:** Group Policy Management Console (Windows), Jamf Pro / Kandji / Microsoft Intune (macOS), or a configuration management system (Linux).

---

## Windows — ADMX via Group Policy

This is the recommended path for Active Directory environments. Steps apply to any Windows domain with a SYSVOL central store. If you do not have a central store, the local machine path is given as an alternative.

### Step 1 — Copy the ADMX and ADML files

Copy the Chrome extension ADMX (for force-install) to the PolicyDefinitions central store. This is separate from the AccessBridge application ADMX (which controls AccessBridge-specific settings like `TelemetryLevel`).

**Central Store (recommended — applies to all domain controllers):**

```
Source: deploy\enterprise\chrome-extension\AccessBridge-ChromeExtension.admx
Dest:   \\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions\AccessBridge-ChromeExtension.admx

Source: deploy\enterprise\chrome-extension\AccessBridge-ChromeExtension.adml
Dest:   \\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions\en-US\AccessBridge-ChromeExtension.adml
```

**Local machine (alternative — affects only this machine's GPMC view):**

```
Source: deploy\enterprise\chrome-extension\AccessBridge-ChromeExtension.admx
Dest:   C:\Windows\PolicyDefinitions\AccessBridge-ChromeExtension.admx

Source: deploy\enterprise\chrome-extension\AccessBridge-ChromeExtension.adml
Dest:   C:\Windows\PolicyDefinitions\en-US\AccessBridge-ChromeExtension.adml
```

Also copy the AccessBridge application ADMX if you want to set `TelemetryLevel`, `EnabledFeaturesLockdown`, or other application policies:

```
Source: deploy\enterprise\admx\AccessBridge.admx
Dest:   \\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions\AccessBridge.admx

Source: deploy\enterprise\admx\en-US\AccessBridge.adml
Dest:   \\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions\en-US\AccessBridge.adml

# Optional — Hindi strings
Source: deploy\enterprise\admx\hi-IN\AccessBridge.adml
Dest:   \\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions\hi-IN\AccessBridge.adml
```

### Step 2 — Open Group Policy Management Editor

1. On a domain controller or management workstation with GPMC installed, open **Group Policy Management** from Server Manager or by running `gpmc.msc`.
2. Expand the forest → domain → navigate to the OU containing the computers you want to manage.
3. Right-click the OU → **Create a GPO in this domain, and link it here** (or edit an existing GPO).
4. Right-click the GPO → **Edit**. This opens the Group Policy Management Editor.
5. Navigate to: **Computer Configuration → Policies → Administrative Templates → Google → Google Chrome → Extensions**.

If the "Google Chrome" node is not present, you have not yet added the Google Chrome ADMX. Download `chrome.admx` and `chrome.adml` from the [Chrome Enterprise policy templates](https://chromeenterprise.google/policies/#download) and copy them to PolicyDefinitions alongside the AccessBridge files.

### Step 3 — Enable force-install

1. In the Extensions node, double-click **Configure the list of force-installed apps and extensions** (`ExtensionInstallForcelist`).
2. Set to **Enabled**.
3. Click **Show** in the Options panel. Add one entry:
   ```
   abcdefghijklmnopqrstuvwxyzabcdef;https://accessbridge.space/chrome/updates.xml
   ```
   Replace `abcdefghijklmnopqrstuvwxyzabcdef` with the real extension ID.
4. Click **OK** to close the list, then **OK** to apply.

### Step 4 — Configure Extension Settings (toolbar pin + minimum version)

1. In the same Extensions node, double-click **Configure extension management settings** (`ExtensionSettings`).
2. Set to **Enabled**.
3. In the Extension settings field, enter a JSON object. Use the template from `deploy/enterprise/chrome-extension/chrome-policy.json` as a reference:
   ```json
   {
     "abcdefghijklmnopqrstuvwxyzabcdef": {
       "installation_mode": "force_installed",
       "update_url": "https://accessbridge.space/chrome/updates.xml",
       "toolbar_pin": "force_pinned",
       "minimum_version_required": "0.19.0"
     }
   }
   ```
   Replace the extension ID and adjust `minimum_version_required` as needed.
4. Click **OK**.

### Step 5 — Apply AccessBridge application policies (optional)

If you want to set `TelemetryLevel`, `EnabledFeaturesLockdown`, or other AccessBridge-specific policies:
1. Navigate to: **Computer Configuration → Policies → Administrative Templates → AccessBridge**.
2. Configure each policy as needed. See [docs/deployment/group-policy.md](group-policy.md) for policy reference and example configurations.

### Step 6 — Force a policy refresh on clients

Run on each client, or via a remote management tool:

```cmd
gpupdate /force
```

Without `/force`, the policy refreshes on the next background cycle (every 90 minutes by default for computer policy).

### Step 7 — Verify

After `gpupdate /force`, open Chrome on a managed client. See the [Verification Checklist](#verification-checklist) below.

---

## macOS — mobileconfig via MDM

### Jamf Pro

1. In the Jamf Pro console, go to **Computers → Configuration Profiles → New**.
2. Set **Name** to "AccessBridge Chrome Extension" and assign a **Category**.
3. Click **Upload** and select `deploy/enterprise/chrome-extension/AccessBridge.mobileconfig`.
4. In the **Scope** tab, add the target computer group.
5. Click **Save** and then **Distribute**.

After the next Jamf agent check-in (or trigger a check-in manually), Chrome reads the new managed preferences and force-installs the extension.

### Kandji

1. In the Kandji Library, go to **Add Item → Custom Profile**.
2. Upload `deploy/enterprise/chrome-extension/AccessBridge.mobileconfig`.
3. Assign to a blueprint covering the target devices.
4. Kandji pushes the profile on the next agent sync.

### Microsoft Intune

1. In the Microsoft Intune admin center, go to **Devices → macOS → Configuration profiles → Create profile**.
2. Choose **Profile type: Templates → Custom**.
3. Set a name and upload `deploy/enterprise/chrome-extension/AccessBridge.mobileconfig` as the custom configuration profile.
4. Assign to the target group.

### Manual install (small deployments — 10 or fewer devices)

1. Copy `AccessBridge.mobileconfig` to the target Mac.
2. Double-click the file. macOS opens the profile installer.
3. Open **System Preferences → Profiles** and click **Install** for the AccessBridge profile.
4. Restart Chrome.

Note: manual profiles installed this way are labeled "Not verified" in System Preferences because they are not MDM-enrolled. For production deployments, use Jamf, Kandji, or Intune.

---

## Linux — Managed Policy JSON

The managed policy file must be placed at a path Chrome reads on startup. Only policies in the `managed` directory are enforced (they cannot be overridden by the user); policies in the `recommended` directory are defaults that the user can change.

### Step 1 — Create the managed policy directory

```bash
sudo mkdir -p /etc/opt/chrome/policies/managed
```

For Chromium:
```bash
sudo mkdir -p /etc/chromium/policies/managed
```

### Step 2 — Copy the policy file

```bash
sudo cp deploy/enterprise/chrome-extension/chrome-policy.json \
  /etc/opt/chrome/policies/managed/accessbridge.json
sudo chmod 644 /etc/opt/chrome/policies/managed/accessbridge.json
```

Before copying, edit `chrome-policy.json` to replace the placeholder extension ID `abcdefghijklmnopqrstuvwxyzabcdef` with the real extension ID.

### Step 3 — Restart Chrome

Chrome re-reads managed policies on startup. Existing Chrome instances must be fully quit and restarted:

```bash
# Close all Chrome windows, then launch Chrome
google-chrome
```

Or via a remote command on a fleet using your configuration management tool (Ansible example):

```yaml
- name: Restart Chrome on all nodes
  ansible.builtin.command: pkill -u "{{ item }}" google-chrome
  with_items: "{{ managed_users }}"
  ignore_errors: true
```

### Automation with Ansible / Chef / Puppet

The JSON copy step is idempotent. A minimal Ansible task:

```yaml
- name: Deploy AccessBridge managed policy
  ansible.builtin.copy:
    src: chrome-policy.json
    dest: /etc/opt/chrome/policies/managed/accessbridge.json
    owner: root
    group: root
    mode: '0644'
  notify: restart chrome
```

---

## Verification Checklist

After deployment, verify the following on at least one client in each deployment wave:

1. **Extension appears force-installed.** Open `chrome://extensions/`. The AccessBridge extension should appear with a "Installed by policy" badge and no "Remove" button.

2. **Toolbar is pinned.** The AccessBridge toolbar icon appears in the Chrome toolbar (not hidden in the extension overflow menu). If `toolbar_pin: "force_pinned"` was set in `ExtensionSettings`, the user cannot unpin it.

3. **`chrome://policy/` shows policies.** Open `chrome://policy/` in Chrome. Scroll to the "Extension policies" section. Find the AccessBridge extension ID row. Each configured policy key should appear with `Source: Platform` and the value you set. If policies appear but `Source` is `Cloud` or `User`, they are coming from a different source.

4. **User cannot uninstall.** In `chrome://extensions/`, there is no "Remove" button for AccessBridge. Attempting to drag it out of the toolbar is also blocked.

5. **Update check succeeds.** In `chrome://extensions/`, click the **Update** button (or enable Developer mode to see the update button). The extension should not report an update error. If it does, see the `update_url HTTPS rejected` item in [Common Problems](#common-problems) below.

6. **`chrome.storage.managed` populates.** Open the AccessBridge extension popup. The popup banner near the top should display "N settings managed by your organization" if you configured any AccessBridge application policies. For a programmatic check: right-click the AccessBridge toolbar icon → **Inspect Popup** → in the DevTools console, run:
   ```js
   chrome.storage.managed.get(null, v => console.log(JSON.stringify(v, null, 2)))
   ```
   The output should contain the keys you configured in the ADMX/mobileconfig/JSON.

---

## Common Problems

### Extension not force-installed

**Symptom:** `chrome://extensions/` does not show AccessBridge, or it shows without the "Installed by policy" badge.

**Fix:** The extension ID in the policy file does not match the extension ID Chrome computed from the CRX. Open `chrome://extensions/`, load the CRX manually to get its ID, then update the policy file to match. Run `gpupdate /force` (Windows) or push the updated MDM profile / JSON and restart Chrome.

### Managed policy values not appearing in the extension

**Symptom:** `chrome://policy/` shows the AccessBridge policies as configured, but `chrome.storage.managed.get()` in the extension returns an empty object `{}`.

**Fix:** The user is signed into Chrome with a personal Google account on a browser that is not enrolled in your domain (e.g. Chrome was installed on a personal laptop and the user signed into their work profile manually). Machine-level policies from GPO and MDM profiles apply to the Chrome installation on the managed machine, but Chrome profile–level policies from a personal Google account can shadow them. Ensure the Chrome installation is properly managed (domain-joined Windows, MDM-enrolled macOS) and verify that `chrome://management/` shows your organization name.

### `update_url` HTTPS rejected

**Symptom:** Chrome shows an error in `chrome://extensions/` when the extension tries to update. The error message contains "Cannot download CRX. Update URL is not HTTPS."

**Fix:** Chrome requires the `update_url` in force-install policies to use valid HTTPS with a browser-trusted certificate. The `accessbridge.space` domain uses a valid TLS certificate; if you are self-hosting the CRX, ensure your server uses a trusted certificate, not a self-signed one. Do not use an HTTP `update_url` in production.

### User still sees "Paired by developer mode" badge

**Symptom:** The extension shows a developer mode warning badge even though it was force-installed via policy.

**Fix:** The extension was previously sideloaded (loaded unpacked from the Extensions page in developer mode). The developer mode badge attaches to the sideloaded instance, not the policy-installed one. Remove the sideloaded instance: open `chrome://extensions/` → find the AccessBridge entry with the developer mode badge → click **Remove**. The policy-installed instance (no Remove button) remains. If developer mode was enabled on this browser, disable it in `chrome://extensions/`.

### Chrome updates hang after deployment

**Symptom:** Chrome fails to check for or apply extension updates. The extension update mechanism also stops working.

**Fix:** The Chrome update check for the extension goes to `https://accessbridge.space/chrome/updates.xml`. If the client's network blocks this hostname (proxy allowlist, firewall, DNS filtering), all extension update checks from that URL will fail silently. Add `accessbridge.space` to the proxy allowlist or firewall rule for outbound HTTPS on client machines. To verify connectivity, run from the affected machine:
```
curl -I https://accessbridge.space/chrome/updates.xml
```
A `200 OK` response confirms the URL is reachable.
