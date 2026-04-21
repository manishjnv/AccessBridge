//! Cross-platform accessibility permission API.
//!
//! On macOS, users must explicitly grant Accessibility API access via System
//! Preferences › Privacy & Security › Accessibility. On Windows and Linux,
//! no equivalent permission gate exists, so `check_accessibility_permission()`
//! always returns `Granted` on those platforms.

// ── Platform dispatch ─────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows as platform;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as platform;

// ── Public types ──────────────────────────────────────────────────────────────

/// The current state of the process's accessibility permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionStatus {
    /// The process has been granted accessibility access.
    Granted,
    /// The user has explicitly denied accessibility access.
    Denied,
    /// The permission has neither been granted nor denied (first-run or reset).
    ///
    /// On macOS, `AXIsProcessTrustedWithOptions` does not distinguish `Denied`
    /// from `NotDetermined`; we use the conservative `NotDetermined` default.
    NotDetermined,
}

/// Errors that can occur when requesting accessibility permission.
#[derive(Debug, thiserror::Error)]
pub enum PermissionError {
    /// Failed to spawn a helper process (e.g. `open` on macOS).
    #[error("spawn failed: {0}")]
    Spawn(String),
    /// The current platform does not support this operation.
    #[error("unsupported platform: {0}")]
    Unsupported(String),
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Return the current accessibility permission status for this process.
///
/// On Windows and Linux this is always `Granted`. On macOS it reflects the
/// real TCC (Transparency, Consent, and Control) state.
pub fn check_accessibility_permission() -> PermissionStatus {
    platform::check_accessibility_permission()
}

/// Prompt the user to grant accessibility access, or open the relevant settings
/// page so they can do so manually.
///
/// On Windows and Linux this is a silent no-op. On macOS it triggers the system
/// permission dialog (if not already determined) **and** opens System Preferences.
pub fn request_accessibility_permission() -> Result<(), PermissionError> {
    platform::request_accessibility_permission()
}

/// Return a platform-specific deep-link URL that opens the relevant system
/// settings panel for accessibility permissions, if one exists.
pub fn platform_settings_url() -> Option<&'static str> {
    platform::platform_settings_url()
}

// ── Platform-agnostic tests ───────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Enum values must serialize to kebab-case strings.
    #[test]
    fn permission_status_serializes_to_kebab_case() {
        assert_eq!(
            serde_json::to_string(&PermissionStatus::Granted).unwrap(),
            "\"granted\""
        );
        assert_eq!(
            serde_json::to_string(&PermissionStatus::Denied).unwrap(),
            "\"denied\""
        );
        assert_eq!(
            serde_json::to_string(&PermissionStatus::NotDetermined).unwrap(),
            "\"not-determined\""
        );
    }

    /// Deserialization must round-trip correctly.
    #[test]
    fn permission_status_round_trips() {
        for status in [
            PermissionStatus::Granted,
            PermissionStatus::Denied,
            PermissionStatus::NotDetermined,
        ] {
            let json = serde_json::to_string(&status).unwrap();
            let back: PermissionStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(back, status);
        }
    }

    /// PermissionError::Spawn must include the inner message in its Display.
    #[test]
    fn permission_error_spawn_display() {
        let e = PermissionError::Spawn("test-error".to_string());
        assert!(e.to_string().contains("test-error"));
        assert!(e.to_string().starts_with("spawn failed:"));
    }

    /// PermissionError::Unsupported must include the platform in its Display.
    #[test]
    fn permission_error_unsupported_display() {
        let e = PermissionError::Unsupported("plan9".to_string());
        assert!(e.to_string().contains("plan9"));
        assert!(e.to_string().starts_with("unsupported platform:"));
    }
}
