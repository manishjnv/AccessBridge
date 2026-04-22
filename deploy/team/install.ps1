#Requires -Version 5.1
<#
.SYNOPSIS
    AccessBridge Team-tier Universal Installer — Windows PowerShell dispatcher.

.DESCRIPTION
    Dispatches to install-windows.ps1 in the same directory, with optional
    SHA-256 integrity verification and automatic download if needed.

    Author  : Manish Kumar
    Project : AccessBridge v0.22.0
    Session : 24 — Team-tier installer
    Updated : 2026-04-21

    USAGE (local checkout):
        pwsh -File deploy/team/install.ps1 [OPTIONS]

    USAGE (remote):
        irm https://accessbridge.space/team/install.ps1 | iex
        # — or with args —
        & ([scriptblock]::Create((irm https://accessbridge.space/team/install.ps1))) -Profile pilot-tamil -DryRun

    SHA-256 MANIFEST:
        When placeholders are present the script uses LOCAL files from the
        same directory. Replace placeholders with real hex hashes for
        signed release builds.

.PARAMETER Profile
    Preset profile name. Default: pilot-default

.PARAMETER Observatory
    opt-in | off   Enable anonymous observatory metrics. Default: off

.PARAMETER Agent
    yes | no   Install desktop agent. Default: no

.PARAMETER LogLevel
    quiet | normal | verbose. Default: normal

.PARAMETER PilotId
    Pilot cohort identifier baked into the profile.

.PARAMETER DryRun
    Print what would happen; write nothing.

.PARAMETER Help
    Show this help and exit.

.EXAMPLE
    pwsh -File deploy/team/install.ps1 -Profile pilot-dyslexia -DryRun -LogLevel verbose

.EXAMPLE
    pwsh -File deploy/team/install.ps1 -Profile pilot-tamil -Observatory opt-in -Agent no
#>

[CmdletBinding()]
param(
    [string]$Profile      = 'pilot-default',
    [ValidateSet('opt-in', 'off')][string]$Observatory = 'off',
    [ValidateSet('yes', 'no')][string]$Agent           = 'no',
    [ValidateSet('quiet', 'normal', 'verbose')][string]$LogLevel = 'normal',
    [string]$PilotId      = '',
    [switch]$DryRun,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# SHA-256 manifest — replace PLACEHOLDER_* before publishing a signed release
# ---------------------------------------------------------------------------
$EXPECTED_SHA256 = [ordered]@{
    'install-windows.ps1' = 'PLACEHOLDER_WINDOWS_SHA256'
}

$ACCESSBRIDGE_VERSION = '0.22.0'
$BASE_URL             = 'https://accessbridge.space/team'

# ---------------------------------------------------------------------------
# Help block
# ---------------------------------------------------------------------------
function Show-Help {
    Write-Host @"
AccessBridge Team Installer — Windows PowerShell Dispatcher v$ACCESSBRIDGE_VERSION
Author: Manish Kumar

USAGE
  pwsh -File deploy/team/install.ps1 [OPTIONS]

OPTIONS
  -Profile <name>         Preset profile name (must exist in deploy/team/profiles/)
                          Default: pilot-default
  -Observatory <value>    opt-in | off   Enable anonymous observatory metrics
                          Default: off
  -Agent <value>          yes | no       Install desktop agent
                          Default: no
  -LogLevel <value>       quiet | normal | verbose
                          Default: normal
  -PilotId <string>       Pilot cohort identifier baked into the profile
  -DryRun                 Print what would happen; write nothing
  -Help                   Show this help and exit

EXIT CODES
  0   success
  1   generic error
  2   Chrome not found
  3   download / integrity failure
  4   admin rights needed (-Agent yes without elevation)

EXAMPLES
  pwsh -File deploy/team/install.ps1 -Profile pilot-dyslexia -DryRun -LogLevel verbose
  pwsh -File deploy/team/install.ps1 -Profile pilot-tamil -Observatory opt-in -Agent yes
"@
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Info  { param([string]$Msg) Write-Host "[INFO]    $Msg" }
function Write-Warn  { param([string]$Msg) Write-Host "[WARN]    $Msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$Msg) Write-Host "[ERROR]   $Msg" -ForegroundColor Red }

function Test-IsPlaceholder {
    param([string]$Val)
    return $Val.StartsWith('PLACEHOLDER_')
}

function Get-FileSHA256 {
    param([string]$FilePath)
    return (Get-FileHash -Algorithm SHA256 -Path $FilePath).Hash.ToLower()
}

# ---------------------------------------------------------------------------
# Resolve installer script: local first, then download + verify
# ---------------------------------------------------------------------------
function Resolve-InstallerScript {
    param([string]$ScriptName)

    $scriptDir   = Split-Path -Parent $MyInvocation.ScriptName
    $localPath   = Join-Path $scriptDir $ScriptName
    $expectedHash = $EXPECTED_SHA256[$ScriptName]

    if (Test-IsPlaceholder $expectedHash) {
        # Manifest not populated — use local file if available
        if (Test-Path $localPath) {
            Write-Info "SHA-256 manifest not populated; using local file: $localPath"
            return $localPath
        }
        else {
            Write-Err "SHA-256 manifest not populated and local file not found: $localPath"
            Write-Err "Clone the repo and run deploy/team/install.ps1 directly, or populate the SHA-256 manifest."
            exit 1
        }
    }

    # Populated manifest: check local first
    if (Test-Path $localPath) {
        $actualHash = Get-FileSHA256 $localPath
        if ($actualHash -eq $expectedHash.ToLower()) {
            Write-Info "Verified local $ScriptName (SHA-256 OK)"
            return $localPath
        }
        else {
            Write-Warn "Local $ScriptName hash mismatch — will download fresh copy."
        }
    }

    # Download to temp
    $tmpDir  = [System.IO.Path]::GetTempPath()
    $tmpFile = Join-Path $tmpDir $ScriptName
    $url     = "${BASE_URL}/${ScriptName}?v=${ACCESSBRIDGE_VERSION}"

    Write-Info "Downloading $ScriptName from $url"
    try {
        $wc = New-Object System.Net.WebClient
        $wc.DownloadFile($url, $tmpFile)
    }
    catch {
        Write-Err "Download failed for ${ScriptName}: $_"
        exit 3
    }

    # Verify integrity
    $actualHash = Get-FileSHA256 $tmpFile
    if ($actualHash -ne $expectedHash.ToLower()) {
        Write-Err "SHA-256 integrity check FAILED for ${ScriptName}"
        Write-Err "  Expected : $expectedHash"
        Write-Err "  Got      : $actualHash"
        Write-Err "Aborting — the downloaded file may have been tampered with."
        Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
        exit 3
    }

    Write-Info "SHA-256 verified for $ScriptName"
    return $tmpFile
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

# Show help when -Help passed or no args at all
if ($Help -or ($PSBoundParameters.Count -eq 0 -and $args.Count -eq 0)) {
    Show-Help
    exit 0
}

$scriptPath = Resolve-InstallerScript 'install-windows.ps1'

# Build a clean splatted argument table from our own bound parameters,
# excluding the -Help switch (not accepted by install-windows.ps1).
$forwardParams = @{}
foreach ($key in $PSBoundParameters.Keys) {
    if ($key -ne 'Help') {
        $forwardParams[$key] = $PSBoundParameters[$key]
    }
}

Write-Info "Dispatching to: $scriptPath"
& $scriptPath @forwardParams
exit $LASTEXITCODE
