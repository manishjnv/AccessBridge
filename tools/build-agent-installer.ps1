# Build the AccessBridge Desktop Agent MSI installer and stage it for deploy.
#
# Requires Rust toolchain + MSVC Build Tools + WiX Toolset v4 installed.
# See packages/desktop-agent/README.md for toolchain setup.
#
# Session 19 — MVP.
#
# Usage:
#   pwsh tools/build-agent-installer.ps1
#
# Output artifacts (both identical to the bash script's outputs):
#   deploy/downloads/accessbridge-desktop-agent.msi
#   deploy/downloads/accessbridge-desktop-agent.msi.sha256

$ErrorActionPreference = 'Stop'

# ---- Resolve paths ----
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = Split-Path -Parent $ScriptDir
$AgentDir   = Join-Path $RepoRoot 'packages\desktop-agent'
$MsiSrcDir  = Join-Path $AgentDir 'src-tauri\target\release\bundle\msi'
$DeployDir  = Join-Path $RepoRoot 'deploy\downloads'
$DeployMsi  = Join-Path $DeployDir 'accessbridge-desktop-agent.msi'
$DeployHash = Join-Path $DeployDir 'accessbridge-desktop-agent.msi.sha256'

function Write-Bold  { param([string]$Msg) Write-Host $Msg -ForegroundColor White }
function Write-Info  { param([string]$Msg) Write-Host $Msg -ForegroundColor Cyan }
function Write-Warn  { param([string]$Msg) Write-Host $Msg -ForegroundColor Yellow }
function Write-Err   { param([string]$Msg) Write-Host $Msg -ForegroundColor Red }

# ---- [1/4] Toolchain check ----
Write-Bold '[1/4] Verifying Rust + MSVC + WiX toolchain'

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Err 'cargo not found — install Rust via https://rustup.rs'
    exit 1
}
Write-Info '  cargo OK'

if (-not (Get-Command cl -ErrorAction SilentlyContinue)) {
    Write-Warn '  MSVC cl not in PATH — Tauri will invoke it via Cargo link.exe detection; proceeding anyway'
} else {
    Write-Info '  cl (MSVC) OK'
}

if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
    Write-Warn '  WiX v4 not in PATH — Tauri bundler will try to download it; install via: dotnet tool install --global wix'
} else {
    Write-Info '  wix OK'
}

# ---- [2/4] Build ----
Write-Bold '[2/4] Building desktop-agent MSI'
Push-Location $AgentDir
try {
    & pnpm --filter '@accessbridge/desktop-agent' tauri build --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Tauri build failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}

# ---- [3/4] Locate MSI output ----
Write-Bold '[3/4] Locating MSI'
if (-not (Test-Path $MsiSrcDir)) {
    Write-Err "MSI output directory not found: $MsiSrcDir"
    Write-Err 'Check Tauri build output above.'
    exit 1
}

$MsiFiles = Get-ChildItem -Path $MsiSrcDir -Filter '*.msi' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
if ($MsiFiles.Count -eq 0) {
    Write-Err "No MSI produced in $MsiSrcDir — check Tauri build output above"
    exit 1
}
$SourceMsi = $MsiFiles[0].FullName
Write-Info "Found: $SourceMsi"

# ---- [4/4] Stage for deploy ----
Write-Bold '[4/4] Staging MSI + sha256 into deploy/downloads/'

if (-not (Test-Path $DeployDir)) {
    New-Item -ItemType Directory -Path $DeployDir -Force | Out-Null
}

Copy-Item -Path $SourceMsi -Destination $DeployMsi -Force

# Compute SHA-256 and write hash file (same format as sha256sum: "<hash>  <filename>")
$HashBytes  = [System.Security.Cryptography.SHA256]::Create().ComputeHash(
    [System.IO.File]::ReadAllBytes($DeployMsi)
)
$HashHex    = ($HashBytes | ForEach-Object { $_.ToString('x2') }) -join ''
$HashLine   = "$HashHex  accessbridge-desktop-agent.msi"
Set-Content -Path $DeployHash -Value $HashLine -Encoding ASCII

$SizeBytes = (Get-Item $DeployMsi).Length
$SizeMB    = [math]::Round($SizeBytes / 1MB, 2)

Write-Info "MSI staged:   $DeployMsi"
Write-Info "Hash file:    $DeployHash"
Write-Info "Size:         ${SizeMB} MB ($SizeBytes bytes)"
Write-Info 'Ready to deploy via ./deploy.sh (which rsyncs deploy/ to VPS).'
