//! macOS accessibility permission module.
//!
//! Uses the `AXIsProcessTrustedWithOptions` function from the Accessibility
//! framework to check/request TCC accessibility permission. The function
//! signature is:
//!
//!   bool AXIsProcessTrustedWithOptions(CFDictionaryRef options);
//!
//! Passing `{ kAXTrustedCheckOptionPrompt: true }` triggers the system dialog
//! (and opens System Preferences on subsequent calls after first denial).
//! Passing `{ kAXTrustedCheckOptionPrompt: false }` (or `NULL`) is a silent
//! status check.

use super::{PermissionError, PermissionStatus};

// ── FFI declaration ───────────────────────────────────────────────────────────

/// Raw extern "C" binding for AXIsProcessTrustedWithOptions.
///
/// The function lives in the Accessibility framework, which is always linked on
/// macOS. We declare it here rather than pulling in a third-party wrapper so
/// that we avoid adding a new Cargo dependency.
///
/// Safety: `options` must be NULL or a valid `CFDictionaryRef`. We always pass
/// a properly-constructed dictionary, so the invariant is satisfied at the
/// call sites below.
mod ffi {
    use core_foundation_sys::base::CFTypeRef;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        /// Check (and optionally request) whether the calling process is a
        /// trusted accessibility client.
        ///
        /// # Safety
        /// `options` must be NULL or a valid CFDictionaryRef for the lifetime
        /// of the call. The caller is responsible for releasing any CF objects
        /// it created.
        pub fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Build a `CFDictionary` with the single key `AXTrustedCheckOptionPrompt`.
///
/// `prompt` — if `true`, the OS will show the permission dialog on first call
/// and open System Preferences on subsequent calls.
///
/// Returns the raw `CFTypeRef` for the dictionary. The caller must release it
/// via `CFRelease` when done (or let the returned `CFDictionary` wrapper drop).
fn call_ax_trusted(prompt: bool) -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    // Build the key and value as CF types.
    let key = CFString::new("AXTrustedCheckOptionPrompt");
    let value = if prompt {
        CFBoolean::true_value()
    } else {
        CFBoolean::false_value()
    };

    // `CFDictionary::from_CFType_pairs` retains both key and value, so the
    // dictionary owns them. It is released when `dict` drops at end of scope.
    let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);

    // SAFETY: `dict` is a valid, fully-initialized CFDictionaryRef. The
    // function only reads from it synchronously and does not retain it after
    // the call returns.
    unsafe { ffi::AXIsProcessTrustedWithOptions(dict.as_CFTypeRef()) }
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Check whether this process currently has accessibility permission.
///
/// Returns `Granted` if trusted, `NotDetermined` otherwise. macOS does not
/// expose a way to distinguish "denied" from "never asked" via this API, so
/// we conservatively return `NotDetermined` for both.
#[cfg(not(test))]
pub fn check_accessibility_permission() -> PermissionStatus {
    if call_ax_trusted(false) {
        PermissionStatus::Granted
    } else {
        PermissionStatus::NotDetermined
    }
}

/// Test-mode replacement: never calls the real AX API (which has side effects).
#[cfg(test)]
pub fn check_accessibility_permission() -> PermissionStatus {
    // In tests we can't call AXIsProcessTrustedWithOptions because it may
    // trigger a system dialog. Return a fixed value so tests are hermetic.
    PermissionStatus::NotDetermined
}

/// Request accessibility access.
///
/// 1. Calls `AXIsProcessTrustedWithOptions` with `Prompt: true`, which causes
///    the OS to display the permission dialog on first invocation (or opens
///    System Preferences if the user previously denied access).
/// 2. As a belt-and-braces measure, also opens the Accessibility Privacy pane
///    directly via `open`.
///
/// Returns `Err(PermissionError::Spawn(...))` if the `open` command fails to
/// execute. The first step (dialog) never errors.
#[cfg(not(test))]
pub fn request_accessibility_permission() -> Result<(), PermissionError> {
    // Step 1 — trigger the system prompt.
    call_ax_trusted(true);

    // Step 2 — belt-and-braces: open the Accessibility settings pane.
    let url = platform_settings_url().unwrap_or(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
    std::process::Command::new("open")
        .arg(url)
        .status()
        .map_err(|e| PermissionError::Spawn(e.to_string()))?;

    Ok(())
}

/// Test-mode replacement: no-op so tests don't open System Preferences.
#[cfg(test)]
pub fn request_accessibility_permission() -> Result<(), PermissionError> {
    Ok(())
}

/// The deep-link URL that opens the Accessibility Privacy pane.
pub fn platform_settings_url() -> Option<&'static str> {
    Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::PermissionStatus;

    /// The settings URL constant must be the correct Apple deep-link.
    #[test]
    fn settings_url_is_correct() {
        let url = platform_settings_url().expect("macOS must return a settings URL");
        assert!(
            url.starts_with("x-apple.systempreferences:"),
            "URL must be a systempreferences deep-link, got: {url}"
        );
        assert!(
            url.contains("Privacy_Accessibility"),
            "URL must target Privacy_Accessibility, got: {url}"
        );
    }

    /// The test-mode check returns NotDetermined (no real AX call made).
    #[test]
    fn check_returns_not_determined_in_tests() {
        // In test mode check_accessibility_permission() returns NotDetermined
        // unconditionally — verifies the mock shim is wired correctly.
        let status = check_accessibility_permission();
        assert_eq!(status, PermissionStatus::NotDetermined);
    }

    /// request_accessibility_permission is a no-op in tests and must succeed.
    #[test]
    fn request_is_noop_in_tests() {
        assert!(request_accessibility_permission().is_ok());
    }
}
