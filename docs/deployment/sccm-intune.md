# SCCM and Intune Deployment — AccessBridge Desktop Agent

> **Session 20 status**: This guide describes the SCCM/Intune deployment flow that will be available after the Desktop Agent MSI is built with signing in Session 21. Currently the MSI config exists (`packages/desktop-agent/src-tauri/tauri.conf.json` targets WiX) but the binary artifact is not yet produced. Admins can prepare their SCCM/Intune packages using the documentation below and plug in the signed MSI + MST files once released.

This guide describes how to deploy the AccessBridge Desktop Agent using Microsoft SCCM (Configuration Manager) and Microsoft Intune. The desktop agent is a Windows-only Tauri 2 companion process that provides Windows UI Automation (UIA) inspection and cross-surface profile synchronization when paired with the Chrome extension. See [docs/features/desktop-agent.md](../features/desktop-agent.md) for the agent architecture, IPC protocol, and PSK pairing flow.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [SCCM — Classic Application Model](#sccm--classic-application-model)
3. [Intune — Win32 App](#intune--win32-app)
4. [Detection Rule Templates](#detection-rule-templates)
5. [Required Return Codes](#required-return-codes)
6. [Logging and Troubleshooting](#logging-and-troubleshooting)

---

## Prerequisites

- **SCCM path:** System Center Configuration Manager (SCCM) 2002 or later, or Microsoft Endpoint Configuration Manager 2006+. Earlier versions lack the App Model improvements needed for reliable MSI transforms.
- **Intune path:** Microsoft Intune with a subscription that includes Win32 app management. The `IntuneWinAppUtil.exe` packaging tool is required; download it from the [Microsoft Win32 Content Prep Tool](https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool) GitHub repository.
- **MSI artifact:**

  > **Requires the production MSI (see Session 21 for build pipeline).** The files `deploy/enterprise/desktop-agent/AccessBridge-DesktopAgent-x64.msi` and `deploy/enterprise/desktop-agent/accessbridge-silent.mst` do not exist yet. The WiX configuration at `packages/desktop-agent/src-tauri/tauri.conf.json` targets MSI output, but the Rust + MSVC + WiX build pipeline has not been run in CI. The MSI will be produced and signed in Session 21.

- **Signing:** The MSI must be signed with an EV code-signing certificate before enterprise deployment to suppress SmartScreen prompts. See [docs/operations/signing.md](../operations/signing.md) for the signing procedure.
- **WebView2 Runtime:** The desktop agent uses Tauri 2, which requires the WebView2 Runtime on Windows 10. WebView2 is pre-installed on Windows 11. For Windows 10 fleets, deploy the WebView2 Evergreen bootstrapper before or alongside the agent MSI. The bootstrapper is available from Microsoft at `https://go.microsoft.com/fwlink/p/?LinkId=2124703`.
- **Client OS:** Windows 10 (build 1809+) or Windows 11. The UIA dispatcher is Windows-only; macOS and Linux are no-op stubs (see [docs/features/desktop-agent.md §2](../features/desktop-agent.md)).

---

## SCCM — Classic Application Model

### Step 1 — Add the application

In the Configuration Manager console:

1. Navigate to **Software Library → Application Management → Applications**.
2. Right-click **Applications → Create Application**.
3. Select **Manually specify the application information** and click **Next**.
4. Fill in:
   - **Name:** `AccessBridge Desktop Agent`
   - **Publisher:** `Manish Kumar`
   - **Software version:** match the version in the MSI (e.g. `0.21.0`)
5. Click through the wizard to the **Deployment Types** page.

### Step 2 — Add the MSI deployment type

> **Requires the production MSI (see Session 21 for build pipeline).**

1. Click **Add** to create a deployment type.
2. Select **Windows Installer (`*.msi` file)**.
3. Browse to `\\<fileserver>\share\AccessBridge\AccessBridge-DesktopAgent-x64.msi`.
4. SCCM reads the MSI metadata automatically. Verify the product name and version are correct.
5. On the **Deployment Type Experience** page, set:
   - **Installation behavior:** Install for system
   - **Logon requirement:** Whether or not a user is logged on
   - **Installation program visibility:** Hidden

### Step 3 — Apply the silent transform

> **Requires the production MSI (see Session 21 for build pipeline).**

The MST file `accessbridge-silent.mst` suppresses the GUI installer and sets default install paths. To apply it:

1. On the **Content** page of the deployment type wizard, set the installation program to:
   ```
   msiexec.exe /i "AccessBridge-DesktopAgent-x64.msi" TRANSFORMS="accessbridge-silent.mst" /qn /l*v "%WINDIR%\Logs\AccessBridge-Install.log"
   ```
2. Set the uninstall program to:
   ```
   msiexec.exe /x {PRODUCT-CODE-GUID} /qn
   ```
   Replace `{PRODUCT-CODE-GUID}` with the actual product code from the MSI (visible in the SCCM MSI metadata reader, or via `msiexec /a AccessBridge-DesktopAgent-x64.msi /qb` on a test machine).

PowerShell equivalent for testing on a single machine before SCCM deployment:

```powershell
$msiPath = "C:\Staging\AccessBridge-DesktopAgent-x64.msi"
$mstPath = "C:\Staging\accessbridge-silent.mst"
$logPath = "$env:WINDIR\Logs\AccessBridge-Install-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"

$args = @(
    "/i", "`"$msiPath`"",
    "TRANSFORMS=`"$mstPath`"",
    "/qn",
    "/l*v", "`"$logPath`""
)

$proc = Start-Process -FilePath "msiexec.exe" -ArgumentList $args -Wait -PassThru
Write-Host "Exit code: $($proc.ExitCode)"
```

### Step 4 — Set the detection method

Use the MSI product code detection method. SCCM uses this to determine whether the application is already installed before deploying or uninstalling.

1. On the **Detection Method** page, choose **Use Windows Installer product code detection**.
2. Enter the product code GUID from the MSI properties.

See [Detection Rule Templates](#detection-rule-templates) for the product code and registry fallback snippets.

### Step 5 — Deploy to collection

1. Complete the wizard and save the application.
2. Right-click the application → **Deploy**.
3. Select the target collection (e.g. "AccessBridge Pilot — Wave 1").
4. Set **Action** to **Install** and **Purpose** to **Required** (or **Available** for user-initiated install).
5. Set the **Schedule** for when the deployment should occur.
6. On the **User Experience** page, set **Installation behavior** to **Install silently** and **Post installation behavior** to **No action required** (or **ConfigMgr client restarts** if the agent requires a system restart, which it does not in the current implementation).
7. Complete the wizard.

---

## Intune — Win32 App

### Step 1 — Package the MSI with IntuneWinAppUtil

> **Requires the production MSI (see Session 21 for build pipeline).**

IntuneWinAppUtil wraps the MSI into a `.intunewin` container that Intune can upload and deploy.

```cmd
IntuneWinAppUtil.exe -c "C:\Staging\AccessBridge" -s "AccessBridge-DesktopAgent-x64.msi" -o "C:\Staging\Intune" -q
```

Parameter reference:
- `-c`: the folder containing the MSI and its dependencies (transforms, prerequisites)
- `-s`: the setup file name (the MSI) relative to `-c`
- `-o`: output folder for the `.intunewin` file
- `-q`: quiet mode (no interactive prompts)

The output file will be `C:\Staging\Intune\AccessBridge-DesktopAgent-x64.intunewin`.

### Step 2 — Upload to Intune Admin Center

> **Requires the production MSI (see Session 21 for build pipeline).**

1. Open the [Microsoft Intune Admin Center](https://intune.microsoft.com).
2. Navigate to **Apps → Windows → Add**.
3. Select **App type: Windows app (Win32)** and click **Select**.
4. Click **Select app package file** and upload the `.intunewin` file.
5. Intune reads the app metadata from the `.intunewin` container. Verify the name and version.

### Step 3 — Configure install and uninstall commands

On the **Program** tab:

- **Install command:**
  ```
  msiexec.exe /i "AccessBridge-DesktopAgent-x64.msi" TRANSFORMS="accessbridge-silent.mst" /qn /l*v "%WINDIR%\Logs\AccessBridge-Install.log"
  ```
- **Uninstall command:**
  ```
  msiexec.exe /x {PRODUCT-CODE-GUID} /qn
  ```
- **Install behavior:** System
- **Device restart behavior:** App install may force a device restart (choose "No specific action" for the agent — it does not require a reboot)

### Step 4 — Set the detection rule

On the **Detection rules** tab, configure the MSI product code rule:

1. **Rule type:** MSI
2. **MSI product code:** `{PRODUCT-CODE-GUID}` (from the MSI)
3. **MSI product version check:** Optional — configure if you want Intune to detect version upgrades

See [Detection Rule Templates](#detection-rule-templates) for both the MSI product code rule and a registry-key fallback.

### Step 5 — Set requirements

On the **Requirements** tab:
- **OS architecture:** 64-bit
- **Minimum OS:** Windows 10 20H2 (build 19042) or later

### Step 6 — Assign to group

On the **Assignments** tab:
- For required deployment: add to **Required** → select the target Entra ID group
- For available deployment: add to **Available for enrolled devices** → select the target group

Complete the wizard and click **Review + create → Create**.

---

## Detection Rule Templates

### MSI Product Code Detection

For both SCCM and Intune, the MSI product code is the primary detection method.

> **Requires the production MSI (see Session 21 for build pipeline).** The product code GUID is embedded in the MSI and will be published in the Session 21 release notes. The placeholder below must be replaced before deployment.

```xml
<!-- SCCM detection method XML snippet (paste into custom detection script if needed) -->
<!-- Replace {PRODUCT-CODE-GUID} with the actual GUID from the signed MSI -->
<Detection Type="MSI" ProductCode="{PRODUCT-CODE-GUID}" />
```

PowerShell detection script for SCCM (custom script detection method):

```powershell
# Checks MSI product code in the registry
$productCode = "{PRODUCT-CODE-GUID}"  # Replace with actual GUID
$regPath = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$productCode"

if (Test-Path $regPath) {
    $entry = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
    if ($entry -and $entry.DisplayName -like "AccessBridge*") {
        Write-Host "Detected"
        exit 0
    }
}
exit 1
```

### Registry Key Fallback Detection

Use this if MSI product code detection is unavailable (e.g. the install was done outside of Windows Installer):

```powershell
# Registry key fallback detection
$regPath = "HKLM:\SOFTWARE\AccessBridge"
$versionKey = "Version"
$minimumVersion = [System.Version]"0.21.0"  # Adjust to the deployed version

try {
    $installedVersion = [System.Version](Get-ItemPropertyValue -Path $regPath -Name $versionKey -ErrorAction Stop)
    if ($installedVersion -ge $minimumVersion) {
        Write-Host "Detected version $installedVersion"
        exit 0
    }
} catch {
    # Key not found or value missing
}
exit 1
```

The agent writes its version to `HKLM\SOFTWARE\AccessBridge\Version` during MSI installation (via a WiX `RegistryValue` element). This key persists even if the MSI is repaired, making it a reliable fallback.

---

## Required Return Codes

Both SCCM and Intune interpret MSI exit codes. The following codes are expected from `msiexec.exe` during AccessBridge agent installation:

| Exit Code | Meaning | SCCM interpretation | Intune interpretation | Admin action |
|---|---|---|---|---|
| 0 | Success — installation completed | Success | Success | None |
| 3010 | Success — reboot required to complete installation | Soft reboot pending | Soft reboot pending | Schedule a reboot window; the agent itself does not strictly require a reboot, but Windows Installer signals this if it replaced system files |
| 1603 | Fatal error during installation | Failure | Failure | Check `%WINDIR%\Logs\AccessBridge-Install-<timestamp>.log` for the specific error; common causes: insufficient permissions on `%LOCALAPPDATA%`, missing WebView2 Runtime |
| 1618 | Another installation is already in progress | Failure | Failure | Wait for the conflicting installation to complete; SCCM retry schedule will re-attempt |
| 1619 | Installation package could not be opened | Failure | Failure | Verify the MSI path is accessible from the client, the file is not corrupted, and the share permissions are correct |
| 1641 | Installation initiated a reboot | Hard reboot | Hard reboot | Expected only if the WiX package specifies `ForceReboot`; the current configuration does not set this |

For Intune Win32 app deployments, add these return codes in the **Return codes** tab when configuring the app. SCCM reads them from the MSI headers automatically for MSI-type deployment types; they are relevant primarily for custom script detection.

---

## Logging and Troubleshooting

### Installation Log Location

The install command in this guide writes a verbose log to:

```
%WINDIR%\Logs\AccessBridge-Install-<timestamp>.log
```

Where `<timestamp>` is the datetime at install time (format `yyyyMMdd-HHmmss`). In a silent deployment without `%WINDIR%\Logs\` write access, change the log path to a user-writable location or to a UNC share for centralized log collection.

### Common Installation Errors

**SmartScreen blocks the MSI**

- **Symptom:** The MSI launches briefly then closes with no visible output; the log shows `"The execution of setup failed"` or the installer is terminated by Windows Defender SmartScreen.
- **Cause:** The MSI is not signed, or is signed with a standard (non-EV) certificate that has no reputation history.
- **Fix:** Sign the MSI with an EV code-signing certificate as described in [docs/operations/signing.md](../operations/signing.md). In SCCM/Intune silent deployments, SmartScreen typically does not intervene (SYSTEM context); this is more relevant to user-interactive deployments. If it occurs in SYSTEM context, check whether Windows Defender Application Control (WDAC) or AppLocker policies are blocking the MSI.

**WebView2 Runtime missing**

- **Symptom:** Installation completes (exit code 0) but the agent does not start; the system tray icon does not appear. Event Viewer shows a .NET or WebView2 initialization error from `AccessBridge.exe`.
- **Cause:** WebView2 Evergreen Runtime is not installed. This affects Windows 10 machines that have not received it via Windows Update.
- **Fix:** Deploy the [WebView2 Evergreen bootstrapper](https://go.microsoft.com/fwlink/p/?LinkId=2124703) as a prerequisite application in SCCM, or as a dependency in Intune (add the WebView2 installer as a dependency on the **Dependencies** tab of the Win32 app). The bootstrapper is a small executable that downloads and installs the runtime silently: `MicrosoftEdgeWebview2Setup.exe /silent /install`.

**ACL denial on `%LOCALAPPDATA%`**

- **Symptom:** The agent installs but the PSK file (`%LOCALAPPDATA%\AccessBridge\pair.key`) cannot be created on first run. The agent tray icon appears but the settings window shows an error on the Overview tab.
- **Cause:** The MSI is installed in SYSTEM context, but `%LOCALAPPDATA%` resolves to the SYSTEM profile (`C:\Windows\System32\config\systemprofile\AppData\Local\`), not the logged-in user's local app data. The PSK file is then created in the SYSTEM profile, which the logged-in user cannot read.
- **Fix:** Ensure the MSI install behavior is configured as **Install for system** but the agent launch is triggered in the user context. In the WiX package (Session 21 build), the agent is registered as a per-user startup item so it launches under the user's token after login, at which point `%LOCALAPPDATA%` resolves correctly. If this persists, run a per-user install (`msiexec.exe /i ... ALLUSERS=""`) instead of a per-machine install; note that per-user installs from SCCM/Intune require the user to be logged in.

**Port 8901 in use**

- **Symptom:** The agent starts but the Chrome extension shows "Pairing failed — unable to connect." The agent log (viewable from the system-tray context menu → "View Logs") shows `address already in use: 127.0.0.1:8901`.
- **Cause:** Another process on the machine has bound TCP port 8901.
- **Fix:** On the affected machine, run `netstat -ano | findstr :8901` to identify the PID, then check what process that is. If it is a previous agent instance, kill it. If it is an unrelated process, the port conflict will be resolved in a future release by making the port configurable via an environment variable or registry key.
