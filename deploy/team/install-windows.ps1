#Requires -Version 5.1
<#
.SYNOPSIS
    AccessBridge Team-tier deployment installer for Windows.

.DESCRIPTION
    Installs the AccessBridge Chrome extension via per-user registry policy and
    optionally the desktop agent MSI.  Designed for department-scale rollouts
    (10-1000 users) without full MDM/ADMX infrastructure.

    Author  : Manish Kumar
    Project : AccessBridge v0.22.0
    Session : 24 — Team-tier installer
    Updated : 2026-04-21

.PARAMETER Profile
    Preset profile name.  Must match a JSON file in deploy/team/profiles/.
    Default: pilot-default

.PARAMETER Observatory
    opt-in  — enable anonymous observatory metrics in the written profile.
    off     — disable (default).

.PARAMETER Agent
    yes — download and install the desktop agent MSI (requires admin).
    no  — extension only (default).

.PARAMETER LogLevel
    quiet   — errors only.
    normal  — key steps (default).
    verbose — every operation.

.PARAMETER DryRun
    Print what would happen; write no files, touch no registry, install nothing.

.PARAMETER NoAdmin
    Force user-scope-only install.  If -Agent yes is also set and the process
    is not elevated, exits with code 4 rather than self-elevating.

.PARAMETER PilotId
    Optional string baked into the default-profile.json for observatory tagging.

.EXAMPLE
    pwsh -File install-windows.ps1 -DryRun -Profile pilot-dyslexia -LogLevel verbose

.EXAMPLE
    pwsh -File install-windows.ps1 -Profile pilot-tamil -Observatory opt-in -Agent no

.NOTES
    Exit codes:
        0  success
        1  generic error
        2  Chrome not found
        3  download failure
        4  admin rights needed (agent install requested, not elevated, not -NoAdmin)
#>

[CmdletBinding()]
param(
    [string]$Profile      = 'pilot-default',
    [ValidateSet('opt-in', 'off')][string]$Observatory = 'off',
    [ValidateSet('yes', 'no')][string]$Agent           = 'no',
    [ValidateSet('quiet', 'normal', 'verbose')][string]$LogLevel = 'normal',
    [switch]$DryRun,
    [switch]$NoAdmin,
    [string]$PilotId      = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$script:VERSION              = '0.22.0'
$script:EXTENSION_ID         = 'REPLACE_WITH_REAL_EXTENSION_ID'
$script:UPDATE_URL           = 'https://accessbridge.space/chrome/updates.xml'
$script:FORCE_INSTALL_ENTRY  = "$($script:EXTENSION_ID);$($script:UPDATE_URL)"
$script:AGENT_MSI_URL        = "https://accessbridge.space/downloads/accessbridge-desktop-agent_$($script:VERSION)_x86_64.msi?v=$($script:VERSION)"
$script:AGENT_MSI_SHA256     = $null   # placeholder — set to hex string when known
$script:PROFILE_DIR          = Join-Path $PSScriptRoot 'profiles'

# Registry path for per-user Chrome policy (no admin required)
$script:CHROME_POLICY_HKCU   = 'HKCU:\Software\Policies\Google\Chrome\ExtensionInstallForcelist'
# Registry path for per-user Edge policy (no admin required)
$script:EDGE_POLICY_HKCU     = 'HKCU:\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist'

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
$script:LogFile = $null   # set after admin-scope decision

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR', 'VERBOSE')][string]$Level = 'INFO'
    )

    $shouldPrint = switch ($LogLevel) {
        'quiet'   { $Level -eq 'ERROR' }
        'normal'  { $Level -ne 'VERBOSE' }
        'verbose' { $true }
    }

    if ($shouldPrint) {
        $prefix = switch ($Level) {
            'INFO'    { '[INFO]   ' }
            'WARN'    { '[WARN]   ' }
            'ERROR'   { '[ERROR]  ' }
            'VERBOSE' { '[VERBOSE]' }
        }
        $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $prefix $Message"
        Write-Host $line
        if ((-not $DryRun) -and ($script:LogFile -ne $null)) {
            Add-Content -Path $script:LogFile -Value $line -Encoding UTF8
        }
    }
}

function Write-DryRun {
    param([string]$Message)
    Write-Host "[DRY-RUN] $Message" -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# Helper: is the current process elevated?
# ---------------------------------------------------------------------------
function Test-IsAdmin {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = [System.Security.Principal.WindowsPrincipal]$id
    return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---------------------------------------------------------------------------
# Helper: self-elevate via RunAs and exit the current process
# ---------------------------------------------------------------------------
function Invoke-SelfElevate {
    param([string[]]$PassArgs)
    Write-Log 'Not elevated — relaunching as administrator.' 'WARN'
    $argString = $PassArgs -join ' '
    Start-Process -FilePath 'pwsh.exe' `
                  -ArgumentList "-NonInteractive -File `"$PSCommandPath`" $argString" `
                  -Verb RunAs
    exit 0
}

# ---------------------------------------------------------------------------
# Helper: safely resolve a profile-relative path without path injection
# ---------------------------------------------------------------------------
function Resolve-ProfilePath {
    param([string]$Name)
    # Reject any name that contains path separators or parent-traversal tokens
    if ($Name -match '[\\/:.]') {
        Write-Log "Invalid profile name '$Name' — must not contain path characters." 'ERROR'
        exit 1
    }
    return Join-Path $script:PROFILE_DIR "$Name.json"
}

# ---------------------------------------------------------------------------
# Helper: write a registry value under ExtensionInstallForcelist
#   The forcelist uses numeric names (1, 2, 3, …). We find the next free slot.
# ---------------------------------------------------------------------------
function Set-ExtensionForceInstall {
    param(
        [string]$KeyPath,
        [string]$EntryValue
    )

    if ($DryRun) {
        Write-DryRun "Would ensure registry key: $KeyPath"
        Write-DryRun "Would set extension force-install entry: $EntryValue"
        return
    }

    if (-not (Test-Path $KeyPath)) {
        New-Item -Path $KeyPath -Force | Out-Null
        Write-Log "Created registry key: $KeyPath" 'VERBOSE'
    }

    # Check if entry already present (any value)
    $existing = Get-ItemProperty -Path $KeyPath -ErrorAction SilentlyContinue
    if ($existing -ne $null) {
        $props = $existing.PSObject.Properties |
                 Where-Object { $_.Name -notmatch '^PS' } |
                 Select-Object -ExpandProperty Value
        if ($props -contains $EntryValue) {
            Write-Log "Extension entry already present in $KeyPath — skipping." 'VERBOSE'
            return
        }
    }

    # Find next numeric slot
    $slot = 1
    while ($null -ne (Get-ItemProperty -Path $KeyPath -Name "$slot" -ErrorAction SilentlyContinue)) {
        $slot++
    }
    Set-ItemProperty -Path $KeyPath -Name "$slot" -Value $EntryValue -Type String
    Write-Log "Registered extension at slot $slot in $KeyPath" 'INFO'
}

# ---------------------------------------------------------------------------
# Helper: detect browser installs via Uninstall registry
# ---------------------------------------------------------------------------
function Find-Browser {
    param([string]$DisplayNamePattern)
    $paths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($p in $paths) {
        $found = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue |
                 Where-Object { $_.DisplayName -like $DisplayNamePattern }
        if ($found) { return $true }
    }
    return $false
}

# ---------------------------------------------------------------------------
# Helper: download a file with cache-bust query param
# ---------------------------------------------------------------------------
function Invoke-Download {
    param(
        [string]$Url,
        [string]$Destination,
        [string]$Label
    )
    Write-Log "Downloading $Label from $Url" 'INFO'
    if ($DryRun) {
        Write-DryRun "Would download: $Url -> $Destination"
        return $true
    }
    try {
        $wc = New-Object System.Net.WebClient
        $wc.DownloadFile($Url, $Destination)
        Write-Log "Downloaded $Label to $Destination" 'VERBOSE'
        return $true
    }
    catch {
        Write-Log "Download failed for $Label : $_" 'ERROR'
        return $false
    }
}

# ---------------------------------------------------------------------------
# Helper: verify SHA-256 of a file (warns if expected hash is null)
# ---------------------------------------------------------------------------
function Test-FileSHA256 {
    param(
        [string]$FilePath,
        [string]$Expected
    )
    if ($null -eq $Expected -or $Expected -eq '') {
        Write-Log 'SHA-256 expected hash is not configured — skipping integrity check.' 'WARN'
        return $true
    }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $FilePath).Hash
    if ($actual -ne $Expected.ToUpper()) {
        Write-Log "SHA-256 mismatch for $FilePath : expected $Expected, got $actual" 'ERROR'
        return $false
    }
    Write-Log "SHA-256 verified for $FilePath" 'VERBOSE'
    return $true
}

# ---------------------------------------------------------------------------
# Helper: write profile JSON to the correct data directory
# ---------------------------------------------------------------------------
function Write-DefaultProfile {
    param(
        [string]$ProfileJson,      # raw JSON string from the preset file
        [string]$DataDir,          # resolved data dir (ProgramData or LOCALAPPDATA)
        [bool]$IsAdmin
    )
    $destPath = Join-Path $DataDir 'default-profile.json'

    if ($DryRun) {
        Write-DryRun "Would write default-profile.json to: $destPath"
        Write-DryRun "Would set ACL: Users=Read, Admins=FullControl (admin-scope only)"
        return
    }

    if (-not (Test-Path $DataDir)) {
        New-Item -Path $DataDir -ItemType Directory -Force | Out-Null
        Write-Log "Created directory: $DataDir" 'VERBOSE'
    }

    Set-Content -Path $destPath -Value $ProfileJson -Encoding UTF8
    Write-Log "Wrote default-profile.json to $destPath" 'INFO'

    # Apply explicit ACL only when running elevated (NTFS ACL APIs require the dir to be ours)
    if ($IsAdmin) {
        try {
            $acl = Get-Acl -Path $destPath
            $acl.SetAccessRuleProtection($true, $false)  # disable inheritance, clear inherited

            $adminRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                'BUILTIN\Administrators',
                'FullControl',
                'Allow'
            )
            $usersRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                'BUILTIN\Users',
                'Read',
                'Allow'
            )
            $acl.AddAccessRule($adminRule)
            $acl.AddAccessRule($usersRule)
            Set-Acl -Path $destPath -AclObject $acl
            Write-Log "ACL set: Users=Read, Admins=FullControl on $destPath" 'VERBOSE'
        }
        catch {
            Write-Log "ACL adjustment skipped (non-fatal): $_" 'WARN'
        }
    }
}

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

# --- Step 0: Validate profile name before anything else --------------------
$profilePath = Resolve-ProfilePath $Profile
if (-not (Test-Path $profilePath)) {
    $available = (Get-ChildItem -Path $script:PROFILE_DIR -Filter '*.json' -ErrorAction SilentlyContinue |
                  ForEach-Object { $_.BaseName }) -join ', '
    Write-Host "[ERROR]   Profile '$Profile' not found at $profilePath"
    Write-Host "[ERROR]   Available profiles: $available"
    exit 1
}

# --- Step 1: Decide admin scope -------------------------------------------
$isAdmin = Test-IsAdmin

# Agent install requires elevation
if ($Agent -eq 'yes' -and (-not $isAdmin)) {
    if ($NoAdmin) {
        Write-Host '[ERROR]   -Agent yes requires admin rights, but -NoAdmin was specified.'
        exit 4
    }
    # Re-launch elevated, forwarding all params
    $fwdArgs = @("-Profile `"$Profile`"", "-Observatory `"$Observatory`"",
                 "-Agent `"$Agent`"", "-LogLevel `"$LogLevel`"")
    if ($DryRun)    { $fwdArgs += '-DryRun' }
    if ($NoAdmin)   { $fwdArgs += '-NoAdmin' }
    if ($PilotId -ne '') { $fwdArgs += "-PilotId `"$PilotId`"" }
    Invoke-SelfElevate -PassArgs $fwdArgs
}

# --- Step 2: Resolve data directory & log file ----------------------------
if ($isAdmin -and (-not $NoAdmin)) {
    $dataDir = Join-Path $env:ProgramData 'AccessBridge'
} else {
    $dataDir = Join-Path $env:LOCALAPPDATA 'AccessBridge'
}
$logDir = Join-Path $dataDir 'logs'

if (-not $DryRun) {
    if (-not (Test-Path $logDir)) {
        New-Item -Path $logDir -ItemType Directory -Force | Out-Null
    }
    $script:LogFile = Join-Path $logDir "install-$(Get-Date -Format yyyyMMddHHmmss).log"
}

Write-Log "AccessBridge Team Installer v$($script:VERSION) starting" 'INFO'
Write-Log "Profile: $Profile | Observatory: $Observatory | Agent: $Agent | DryRun: $DryRun" 'INFO'
Write-Log "Running as admin: $isAdmin | Data dir: $dataDir" 'VERBOSE'

# --- Step 3: Detect Chrome ------------------------------------------------
Write-Log 'Detecting installed browsers...' 'VERBOSE'
$chromeFound = Find-Browser -DisplayNamePattern '*Google Chrome*'
$edgeFound   = Find-Browser -DisplayNamePattern '*Microsoft Edge*'

if ($DryRun) {
    Write-DryRun "Chrome detected: $chromeFound"
    Write-DryRun "Edge detected:   $edgeFound"
} else {
    Write-Log "Chrome found: $chromeFound | Edge found: $edgeFound" 'INFO'
}

if (-not $chromeFound -and -not $edgeFound) {
    Write-Log 'Neither Google Chrome nor Microsoft Edge detected. Cannot configure extension.' 'ERROR'
    exit 2
}

if (-not $chromeFound) {
    Write-Log 'Google Chrome not found; will configure Edge only.' 'WARN'
}

# --- Step 4: Load and patch the preset profile ----------------------------
Write-Log "Loading preset profile: $profilePath" 'VERBOSE'
$presetRaw  = Get-Content -Path $profilePath -Raw -Encoding UTF8
$presetObj  = $presetRaw | ConvertFrom-Json

# Apply observatory opt-in override
if ($Observatory -eq 'opt-in') {
    $presetObj.observatoryOptIn = $true
    $presetObj.profile.shareAnonymousMetrics = $true
    $presetObj.profile.observatoryEnrolled   = $true
    Write-Log 'Observatory opt-in applied to profile.' 'VERBOSE'
}

# Apply pilotId if provided
if ($PilotId -ne '') {
    $presetObj.pilotId = $PilotId
    Write-Log "PilotId '$PilotId' baked into profile." 'VERBOSE'
}

# Update timestamps in the inner profile
$nowMs = [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$presetObj.profile.updatedAt = $nowMs

$patchedJson = $presetObj | ConvertTo-Json -Depth 20 -Compress:$false

# --- Step 5: Write default-profile.json -----------------------------------
Write-Log 'Writing default-profile.json...' 'INFO'
Write-DefaultProfile -ProfileJson $patchedJson -DataDir $dataDir -IsAdmin $isAdmin

# --- Step 6: Configure Chrome extension force-install ---------------------
if ($chromeFound) {
    Write-Log 'Configuring Chrome ExtensionInstallForcelist (HKCU)...' 'INFO'
    Set-ExtensionForceInstall -KeyPath $script:CHROME_POLICY_HKCU -EntryValue $script:FORCE_INSTALL_ENTRY
}

if ($edgeFound) {
    Write-Log 'Configuring Edge ExtensionInstallForcelist (HKCU)...' 'INFO'
    Set-ExtensionForceInstall -KeyPath $script:EDGE_POLICY_HKCU -EntryValue $script:FORCE_INSTALL_ENTRY
}

# --- Step 7: Desktop agent install (optional) -----------------------------
if ($Agent -eq 'yes') {
    Write-Log 'Desktop agent install requested.' 'INFO'

    $tmpMsi = Join-Path ([System.IO.Path]::GetTempPath()) "accessbridge-agent-$($script:VERSION).msi"
    $downloaded = Invoke-Download -Url $script:AGENT_MSI_URL -Destination $tmpMsi -Label 'Desktop Agent MSI'

    if (-not $downloaded) {
        exit 3
    }

    $hashOk = Test-FileSHA256 -FilePath $tmpMsi -Expected $script:AGENT_MSI_SHA256
    if (-not $hashOk) {
        Write-Log 'Aborting agent install due to SHA-256 mismatch.' 'ERROR'
        exit 3
    }

    if ($DryRun) {
        Write-DryRun "Would run: msiexec /i `"$tmpMsi`" /qn /norestart"
    } else {
        Write-Log "Installing desktop agent from $tmpMsi ..." 'INFO'
        $msi = Start-Process -FilePath 'msiexec.exe' `
                             -ArgumentList "/i `"$tmpMsi`" /qn /norestart" `
                             -Wait -PassThru
        if ($msi.ExitCode -ne 0) {
            Write-Log "msiexec exited with code $($msi.ExitCode)." 'ERROR'
            exit 1
        }
        Write-Log 'Desktop agent installed successfully.' 'INFO'

        # Clean up temp MSI
        Remove-Item -Path $tmpMsi -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Log 'Desktop agent install skipped (-Agent no).' 'VERBOSE'
}

# --- Step 8: Summary ------------------------------------------------------
if ($DryRun) {
    Write-DryRun '--- DRY RUN COMPLETE: no changes were made ---'
} else {
    Write-Log '--- AccessBridge Team Install COMPLETE ---' 'INFO'
    Write-Log "Profile written  : $(Join-Path $dataDir 'default-profile.json')" 'INFO'
    if ($script:LogFile -ne $null) {
        Write-Log "Log file         : $($script:LogFile)" 'INFO'
    }
    Write-Log 'Chrome will apply the extension force-install on next browser restart.' 'INFO'
}

exit 0
