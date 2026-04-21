# AccessBridge Signing Strategy

This document describes how to sign the three AccessBridge release artifacts — the Chrome extension CRX, the desktop agent MSI, and (future) the macOS pkg — and how to manage signing keys securely across the development and production lifecycle. It is intended for DevOps engineers and release managers. For context on the artifacts themselves, see [docs/features/desktop-agent.md](../features/desktop-agent.md) (MSI) and [deploy/enterprise/README.md](../../deploy/enterprise/README.md) (enterprise deployment overview).

---

## Table of Contents

1. [Overview](#overview)
2. [Dev vs. Production Keys](#dev-vs-production-keys)
3. [Chrome Extension — CRX Signing](#chrome-extension--crx-signing)
4. [MSI Signing](#msi-signing)
5. [macOS mobileconfig Signing](#macos-mobileconfig-signing)
6. [Enterprise Lockdown Security Model](#enterprise-lockdown-security-model)
7. [Production Deploy Pipeline](#production-deploy-pipeline)
8. [Revocation Flow](#revocation-flow)
9. [Key Rotation](#key-rotation)
10. [Environment Variables for CI Signing](#environment-variables-for-ci-signing)
11. [Session 20 Status](#session-20-status)

---

## Overview

Three artifacts require code-signing before production deployment:

| Artifact | Signing method | Why signing matters |
|---|---|---|
| Chrome extension CRX | RSA-2048 PEM key (Chrome-native) | The CRX public-key hash determines the extension ID. All user installations, policy force-installs, and `updates.xml` references are keyed to this ID. Losing the key orphans every installed extension. |
| Desktop agent MSI | EV code-signing certificate (Authenticode / SHA-256) | SmartScreen assigns "Unknown Publisher" reputation to unsigned MSIs. At enterprise scale this produces a helpdesk ticket for every install. An EV certificate suppresses the SmartScreen prompt immediately on first use. |
| macOS pkg (future) | Apple Developer ID certificate (Gatekeeper) | macOS Gatekeeper blocks unsigned packages from running unless the user manually overrides Gatekeeper. Required for any distribution outside the Mac App Store. |

This document covers the CRX and MSI. The macOS pkg signing workflow is deferred to when macOS support is added to the desktop agent (see [docs/features/desktop-agent.md §11 Phase 2 Roadmap](../features/desktop-agent.md)).

---

## Dev vs. Production Keys

### Development (self-signed)

During development and for pilot deployments, the extension CRX can be signed with a self-generated PEM key. Chrome generates one automatically when you use "Pack extension" from `chrome://extensions/` or when you use the `crx3` npm package. A self-signed CRX:

- Is valid for loading in developer mode or via force-install when the exact extension ID is in the policy
- Produces the "This extension is not from the Chrome Web Store" banner when installed via policy in non-developer-mode Chrome (expected behavior for enterprise sideloading)
- Does NOT suppress SmartScreen for the MSI; the MSI would still show "Unknown Publisher"

The development key is stored at `secrets/accessbridge.pem`. This file is excluded from the repository via `.gitignore`. See the `.envrc.example` section for the environment variable that points build scripts to this file.

### Production (EV certificate)

For production deployments reaching more than a pilot group:

- **CRX:** Use the same self-signed PEM key but ensure it is backed up in Azure Key Vault. The key itself does not change between dev and production for CRX — the extension ID is locked to the key generated at project inception.
- **MSI:** Obtain an EV (Extended Validation) code-signing certificate from a trusted CA. DigiCert and Sectigo (formerly Comodo CA) are commonly used. An EV certificate:
  - Requires identity verification by the CA (typically 1–3 business days)
  - Carries immediate SmartScreen reputation — no "reputation building" period needed
  - Must be stored on an HSM (Hardware Security Module); most EV issuers require HSM key storage and will not issue a software-exportable EV certificate

**Key storage recommendation:**

- **Azure Key Vault with HSM-backed keys:** The signing key never leaves the HSM. CI pipelines authenticate with a service principal (`AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET`) and use the Key Vault SDK to sign artifact digests. The private key is never written to disk on the build agent.
- **YubiKey HSM (local alternative):** A YubiKey 5 series device with PIV support can hold the EV signing certificate. Suitable for small teams where a dedicated Key Vault subscription is not justified. The YubiKey must be physically connected to the signing machine.
- **NEVER store keys in the repository.** The `secrets/` directory is in `.gitignore`. Any accidental commit of key material requires immediate key rotation and a credential-scanning sweep of git history.

---

## Chrome Extension — CRX Signing

### Key generation (first time only)

The extension ID is the SHA-256 of the public key, encoded in a specific Chrome format. Once generated, this key must be preserved for the entire lifetime of the extension. Every installed copy of AccessBridge is linked to this key.

```bash
# Generate a new RSA-2048 key (run once at project inception; key is already generated for AccessBridge)
openssl genrsa -out secrets/accessbridge.pem 2048
```

This has already been done for AccessBridge. Do not generate a new key unless you are intentionally changing the extension ID (which would orphan all existing installations).

### Building a signed CRX

The production signing script is defined but not yet implemented:

```bash
bash tools/sign-extension.sh  # To be implemented in Session 21
```

When implemented, this script will:
1. Run `pnpm build` to produce `dist/`
2. Zip `dist/` into `accessbridge-extension.zip`
3. Use the `crx3` npm package (or the `google-chrome --pack-extension` CLI) to sign the zip with `secrets/accessbridge.pem`
4. Output `accessbridge-extension.crx` and `accessbridge-extension.pem.pub` (the public key, safe to commit)

For development, the current workflow produces an unsigned zip. The `updates.xml` in `deploy/enterprise/chrome-extension/updates.xml` references the CRX path on `accessbridge.space`. When the CRX is available, update `updates.xml` with the CRX URL and `prodversionmin` value.

### Loading the production key from Azure Key Vault at build time

```bash
# Download the PEM key from Key Vault to a temporary file at build time
az keyvault secret download \
  --vault-name "$AZURE_KEY_VAULT_NAME" \
  --name "$AZURE_KEY_VAULT_CERT_NAME" \
  --file /tmp/accessbridge-signing.pem

# Use the temporary key for signing
CRX3_PRIVATE_KEY_PATH=/tmp/accessbridge-signing.pem bash tools/sign-extension.sh

# Shred the temporary key after signing
shred -u /tmp/accessbridge-signing.pem
```

The key is never persisted to disk between builds. On Azure Pipelines or GitHub Actions, use a temporary workspace path that is wiped after the job completes.

---

## MSI Signing

### Requirements

The MSI signing workflow requires:
- `signtool.exe` from the Windows SDK (included in Visual Studio Build Tools)
- An EV code-signing certificate installed in the Windows certificate store, or access to an Azure Key Vault-backed certificate via the `AzureSignTool` utility
- A timestamp URL from the CA's Time Stamping Authority (TSA)

### Signing command

```powershell
# Sign the MSI with Authenticode SHA-256 and a trusted timestamp
signtool sign `
  /fd SHA256 `
  /tr http://timestamp.digicert.com `
  /td SHA256 `
  /sha1 <certificate-thumbprint> `
  "packages\desktop-agent\src-tauri\target\release\bundle\msi\AccessBridge-DesktopAgent-x64.msi"
```

The production signing script is:

```powershell
# To be implemented in Session 21
.\tools\sign-package.ps1
```

**Important:** Always timestamp the signature. A signature without a timestamp expires when the code-signing certificate expires (typically 1–3 years). With a trusted timestamp, the signature remains valid indefinitely as long as the certificate was valid at the time of signing. This is critical for enterprise deployments where MSIs may be stored and reinstalled years after the certificate expires.

### Azure Key Vault signing (CI/CD)

For automated pipelines where the certificate is HSM-backed in Azure Key Vault, use `AzureSignTool` instead of `signtool`:

```powershell
AzureSignTool sign `
  --azure-key-vault-url "https://$env:AZURE_KEY_VAULT_NAME.vault.azure.net/" `
  --azure-key-vault-client-id $env:AZURE_CLIENT_ID `
  --azure-key-vault-client-secret $env:AZURE_CLIENT_SECRET `
  --azure-key-vault-tenant-id $env:AZURE_TENANT_ID `
  --azure-key-vault-certificate $env:AZURE_KEY_VAULT_CERT_NAME `
  --timestamp-rfc3161 $env:SIGNTOOL_TIMESTAMP_URL `
  --timestamp-digest sha256 `
  --file-digest sha256 `
  "packages\desktop-agent\src-tauri\target\release\bundle\msi\AccessBridge-DesktopAgent-x64.msi"
```

`AzureSignTool` is available at [github.com/vcsjones/AzureSignTool](https://github.com/vcsjones/AzureSignTool).

---

## Production Deploy Pipeline

The production release flow combines the build, signing, and publish steps. Signing is I/O-bound on the HSM (approximately 5 seconds per artifact); running signing steps in parallel reduces total pipeline time.

```
[1] pnpm build                                        (~90s)
    ├── [1a] extension dist + zip
    └── [1b] desktop agent cargo build (Session 21+)

[2] Sign artifacts in parallel                        (~10s total, I/O-bound on HSM)
    ├── [2a] Sign MSI     → tools/sign-package.ps1
    └── [2b] Sign CRX     → tools/sign-extension.sh

[3] Publish                                           (~30s)
    ├── [3a] rsync signed MSI to deploy/enterprise/desktop-agent/
    ├── [3b] rsync CRX + updates.xml to accessbridge.space/chrome/
    └── [3c] rsync extension zip to accessbridge.space/downloads/
         (append ?v=<version> cache-buster per BUG-010)

[4] Health check
    curl https://accessbridge.space/api/version → verify version matches
```

Step 2 parallelism: the CRX signing tool runs in bash and the MSI signing tool runs in PowerShell; they can be launched as background processes in the same CI job and awaited together before step 3.

---

## Revocation Flow

If a signing key is compromised (the CRX PEM key is leaked, or the EV certificate private key is exposed):

### Step 1 — Revoke the certificate at the CA

For EV certificates: contact DigiCert or Sectigo's revocation support immediately. Provide the certificate serial number. They will add it to the Certificate Revocation List (CRL) and OCSP. This prevents new signatures from being made with the compromised certificate, but does not invalidate existing signed binaries that were timestamped before revocation.

For the CRX PEM key: there is no formal revocation process for Chrome extension keys. Proceed to step 2 immediately.

### Step 2 — Push ExtensionInstallBlocklist to block the compromised extension ID

Deploy a Group Policy update (or MDM profile update for macOS) that adds the current extension ID to `ExtensionInstallBlocklist`:

```
ExtensionInstallBlocklist = [<compromised-extension-id>]
```

This causes Chrome to disable and remove the extension from all managed browsers within one policy refresh cycle. Unmanaged browsers (personal devices) cannot be reached this way; coordinate with your security team on communication to affected users.

### Step 3 — Push a new signed version with a new extension ID

Generate a new CRX PEM key:

```bash
openssl genrsa -out secrets/accessbridge-new.pem 2048
# Derive new extension ID from the new public key
```

Build and sign a new CRX with the new key. The new extension ID will be different. Update all policy files and `updates.xml` with the new ID. Deploy the new extension via the standard force-install procedure.

Note: users with the old extension installed will not automatically migrate to the new extension ID. They must be managed through the blocklist (which removes the old one) and the force-install policy (which installs the new one). Plan a communication window where both are pushed together.

### Step 4 — Notify affected administrators

Email administrators in all affected organizations with:
- The compromised extension ID
- The new extension ID
- Instructions for updating their policy files
- The timeline for when the blocklist will be enforced

### Step 5 — Rotate key material

```bash
# Remove the compromised key
shred -u secrets/accessbridge.pem

# Move the new key into place
mv secrets/accessbridge-new.pem secrets/accessbridge.pem

# Update Key Vault with the new key
az keyvault secret set \
  --vault-name "$AZURE_KEY_VAULT_NAME" \
  --name "$AZURE_KEY_VAULT_CERT_NAME" \
  --file secrets/accessbridge.pem
```

---

## Key Rotation

Annual rotation is recommended for the EV code-signing certificate (most EV certificates are issued with 1-year or 2-year validity; plan rotation before the expiry date to avoid a gap).

CRX PEM key rotation should be avoided unless the key is compromised. Rotating the CRX key changes the extension ID, which requires updating every policy file in every organization that has deployed the extension. The cost of rotation is therefore very high for the CRX key; protect it accordingly.

### Overlap period

When rotating the EV certificate (MSI signing):
- Begin using the new certificate for new releases 30 days before the old certificate expires.
- Keep old-certificate-signed MSIs in the download path alongside new-certificate-signed MSIs for the same 30-day window. Some enterprise software inventory systems cache the MSI certificate thumbprint and will flag a mismatch if the certificate changes mid-deployment.
- After 30 days, remove old-certificate MSIs from the download path.

For the CRX key (extension ID change scenario), there is no clean overlap period — the extension ID changes immediately. Minimize the migration window by coordinating the blocklist push and new-extension force-install in the same GPO update.

---

## Environment Variables for CI Signing

The following environment variables must be set in the CI/CD environment (GitHub Actions secrets, Azure Pipelines variable groups, or equivalent). Do not hardcode values; do not commit them to the repository.

```
AZURE_KEY_VAULT_NAME=
AZURE_KEY_VAULT_CERT_NAME=
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
AZURE_TENANT_ID=
SIGNTOOL_TIMESTAMP_URL=http://timestamp.digicert.com
CRX3_PRIVATE_KEY_PATH=./secrets/accessbridge.pem
```

These variables are consumed by `tools/sign-package.ps1` and `tools/sign-extension.sh` (both to be implemented in Session 21). See the project `.envrc.example` file for a local development template.

A local `.envrc` file (not committed to the repository) can use these variables with the `direnv` tool:

```bash
# .envrc (not committed — add to .gitignore)
export AZURE_KEY_VAULT_NAME=accessbridge-keyvault
export AZURE_KEY_VAULT_CERT_NAME=accessbridge-ev-cert
export AZURE_CLIENT_ID=<service-principal-id>
export AZURE_CLIENT_SECRET=<service-principal-secret>
export AZURE_TENANT_ID=<tenant-id>
export SIGNTOOL_TIMESTAMP_URL=http://timestamp.digicert.com
export CRX3_PRIVATE_KEY_PATH=./secrets/accessbridge.pem
```

---

## macOS mobileconfig Signing

The file `deploy/enterprise/chrome-extension/AccessBridge.mobileconfig` is shipped **unsigned**. An unsigned configuration profile installs on macOS but displays a "Profile is not signed" warning and lets users inspect or modify the raw XML before confirming. For MDM distribution through Jamf, Kandji, or Intune, admins must sign the profile with their organization's Apple Developer ID certificate before uploading.

### Signing command for mobileconfig

```bash
security cms -S -N "Developer ID Application: Your Organization (TEAMID)" \
  -i AccessBridge.mobileconfig \
  -o AccessBridge-signed.mobileconfig
```

- `-S` — sign the input
- `-N` — common name of a certificate already installed in your Keychain
- Produces `AccessBridge-signed.mobileconfig` alongside the unsigned input

### Verification

```bash
security cms -D -i AccessBridge-signed.mobileconfig
```

Outputs the signed payload plus the signing certificate details. A successful parse without the "Error reading signature" message confirms the signature is well-formed.

### What signing the mobileconfig does NOT give you

Signing establishes the profile's provenance (the user sees `"Signed by <org-name>"` on install, where `<org-name>` is replaced with the signing certificate common name). It does NOT:

- Prevent the user from removing the profile later
- Prevent a user with `sudo` from removing the profile via `profiles remove -identifier com.accessbridge.chrome-policy`
- Bind the profile to the target machine; a signed profile can be copied elsewhere and installed

For stronger enforcement, combine with Jamf/Kandji's "force profile" policy, which reinstalls the profile on removal.

### CI note

Signing the mobileconfig in CI requires the Apple Developer ID certificate in the CI environment's Keychain. Typically this is handled by an Apple-specific CI tool (Fastlane's `match` or a dedicated signing host). Do NOT embed the `.p12` certificate file in the repository.

---

## Enterprise Lockdown Security Model

What enterprise lockdown actually guarantees.

The AccessBridge enterprise lockdown layer (managed-policy-driven profile locking, see [`packages/extension/src/background/enterprise/policy.ts`](../../packages/extension/src/background/enterprise/policy.ts)) is an **honest contract between the shipped extension and the admin**, not a cryptographic boundary. Admins must understand this distinction before relying on the lockdown for compliance-critical deployments.

### What the in-extension lockdown gives you

- The stock AccessBridge extension respects every managed-policy value it understands. Feature toggles, language defaults, observatory telemetry, AI-tier restrictions, and org-hash grouping are all enforced at the background service worker.
- Users cannot unlock settings through the popup UI — toggles and sliders for locked keys are visually disabled with a "Managed by your organization" tooltip.
- The `SAVE_PROFILE` background handler re-applies the managed-policy merge on every save, so even a direct `chrome.runtime.sendMessage({type:'SAVE_PROFILE'})` from the popup cannot bypass locked values.

### What the in-extension lockdown does NOT give you

- **A locally-rebuilt extension can ignore every managed-policy value.** The lockdown enforcement lives inside the extension's own code; a user (or a malware author) who rebuilds the extension with the enforcement stripped out will see all features unlocked. This is a fundamental limitation of every Chrome managed-storage-based lockdown system, not something AccessBridge can solve unilaterally.
- **A user who sideloads a different extension with the same ID can replace the stock build.** Chrome's managed-storage API exposes the policy to any extension with the matching ID, but nothing prevents a user from replacing the extension binary.
- **Developer-mode Chrome can load arbitrary unpacked extensions.** A user with developer mode enabled can load a modified version of AccessBridge that ignores policy.

### How to achieve real enterprise lockdown

Combine the in-extension policy with three Chrome-platform-level controls:

1. **Force-install via `ExtensionInstallForcelist`** — The ADMX at `deploy/enterprise/chrome-extension/AccessBridge-ChromeExtension.admx` configures this. A force-installed extension cannot be disabled or uninstalled by the user; attempts to unload the extension are reverted by Chrome at next startup.
2. **Pin the exact extension ID + version via `ExtensionSettings`** — The same ADMX includes a `minimum_version_required` field. Chrome refuses to load a lower version of the extension ID, so a user who replaces the signed CRX with an older attacker-supplied build gets blocked.
3. **Disable developer mode via `DeveloperToolsAvailability`** — Set the Chrome policy `DeveloperToolsAvailability` to `2` (blocked) organization-wide. This prevents users from loading unpacked extensions or attaching debuggers that could bypass the extension's internal policy enforcement.

With all three in place, the lockdown becomes cryptographically enforced end-to-end:

- The signed CRX cannot be tampered with without invalidating the signature
- Chrome refuses to load an unsigned or wrong-signature CRX under the force-installed ID
- Users cannot sideload a replacement because developer mode is off
- The running extension honors managed policy because we verify every `SAVE_PROFILE` against the current lockdown snapshot

**Any enterprise deployment that skips one of the three — force-install, minimum-version pin, developer-mode block — leaves a user-accessible bypass.**

### Threat model this does NOT cover

- Compromised Group Policy infrastructure (rogue AD admin pushing weaker policies). Defense: monitor ADMX settings via SIEM; require dual-approval on ADMX edits.
- OS-level privilege escalation (user obtains local admin and disables Chrome policy inheritance). Defense: harden endpoint management; regular Intune/SCCM compliance scans.
- Supply-chain attacks on the signed CRX (compromised signing key). Defense: [Revocation Flow](#revocation-flow) + HSM-backed key storage + code-signing audit logs.

---

## Linux Package Signing

Linux artifacts ship in three formats — `.deb`, `.rpm`, and AppImage — plus a Flatpak that is signed by the build system's ostree metadata. Each format uses GPG for artifact integrity.

> **Warning:** MSI and DMG signing are handled by the CI matrix (Windows and macOS runners). Linux signing currently requires the maintainer's GPG key, which is out-of-tree. See `DEFERRED.md` for the roadmap item to integrate Linux GPG signing into CI.

### .deb — sign with dpkg-sig

```bash
# Sign the .deb with the maintainer's GPG key
gpg --detach-sign -o accessbridge-agent.deb.sig accessbridge-agent.deb

# Alternative: embed the signature inside the .deb using dpkg-sig
dpkg-sig --sign builder accessbridge-agent.deb
```

Users verify a dpkg-sig-signed package with:

```bash
dpkg-sig --verify accessbridge-agent.deb
```

For a standalone detached signature:

```bash
gpg --verify accessbridge-agent.deb.sig accessbridge-agent.deb
```

### .rpm — sign with rpmsign

```bash
# Ensure ~/.rpmmacros contains:
#   %_gpg_name  Manish Kumar <your-gpg-email>

rpmsign --addsign accessbridge-agent.rpm
```

Users verify with:

```bash
rpm --checksig accessbridge-agent.rpm
```

The verifying machine must have the public key imported: `rpm --import accessbridge-gpg-pubkey.asc`.

### AppImage — detached GPG signature + zsyncmake

```bash
# Sign the AppImage
gpg --detach-sign -o accessbridge-agent.AppImage.sig accessbridge-agent.AppImage

# Generate a zsync file for delta updates
zsyncmake accessbridge-agent.AppImage -o accessbridge-agent.AppImage.zsync
```

Publish `accessbridge-agent.AppImage`, `accessbridge-agent.AppImage.sig`, and `accessbridge-agent.AppImage.zsync` alongside each other. Users verify:

```bash
gpg --verify accessbridge-agent.AppImage.sig accessbridge-agent.AppImage
```

### Flatpak — ostree repo signing

When publishing to a self-hosted Flatpak repository (not Flathub), the ostree metadata must be GPG-signed so clients can verify the repo:

```bash
# Sign the ostree commit when publishing to the repo
flatpak build-sign <build-dir> --gpg-sign=<key-id> --gpg-homedir=~/.gnupg

# Sign the repo summary (required for remote add --gpg-import to work)
flatpak build-update-repo <repo-dir> --gpg-sign=<key-id>
```

Users add the repo with:

```bash
flatpak remote-add --gpg-import=accessbridge-gpg-pubkey.asc \
  accessbridge https://accessbridge.space/flatpak/repo
```

The Flathub path (future) handles signing transparently — Flathub's CI signs all ostree commits with the Flathub GPG key, which is bundled with `flatpak` on all supported distros.

---

## Session 20 Status

Current state of signing infrastructure:

| Item | Status |
|---|---|
| CRX PEM key (`secrets/accessbridge.pem`) | Generated; excluded from repository via `.gitignore`; not yet backed up to Key Vault |
| EV code-signing certificate | Not obtained. Self-signed artifacts are acceptable for pilot / lab deployments. |
| `tools/sign-extension.sh` | Not yet implemented. Planned for Session 21. |
| `tools/sign-package.ps1` | Not yet implemented. Planned for Session 21. |
| Azure Key Vault integration | Not yet configured. |
| MSI artifact | Not yet built. Requires Rust + MSVC + WiX toolchain in CI. Planned for Session 21. |

Blockers for 250,000-user scale deployment:

1. **EV certificate required.** Without it, every MSI install on Windows triggers a SmartScreen "Unknown Publisher" prompt. At 250k scale, this will generate an unacceptable helpdesk volume and many users will decline to install.
2. **Key Vault integration required.** Signing keys stored on local developer machines are not acceptable for production. A key compromise on a developer laptop would require the full revocation flow described above.
3. **`tools/sign-extension.sh` and `tools/sign-package.ps1` must be implemented.** The deploy pipeline cannot run unattended signing without these scripts.
4. **`updates.xml` must reference a signed CRX.** The current `updates.xml` in `deploy/enterprise/chrome-extension/updates.xml` references the CRX URL on `accessbridge.space`, but the CRX file is not yet hosted there. Until the CRX is signed and uploaded, force-install via policy will install the extension from the Chrome Web Store instead (if it is published there), or will fail if the Web Store listing does not exist.

Admins deploying for pilot (under 100 users) may proceed with the self-signed CRX and unsigned MSI, accepting the SmartScreen prompt. For any broader deployment, complete the signing setup in Session 21 before proceeding.
