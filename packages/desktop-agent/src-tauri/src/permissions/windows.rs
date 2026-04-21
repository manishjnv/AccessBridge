//! Windows accessibility permission stub.
//!
//! Windows has no Accessibility API permission gate analogous to macOS TCC.
//! UI Automation is available to any process without special entitlements;
//! elevated access (UAC) is a separate and orthogonal concern. Therefore
//! this platform always reports `Granted`.

use super::{PermissionError, PermissionStatus};

/// Always returns `Granted` — Windows has no AX-style permission gate.
pub fn check_accessibility_permission() -> PermissionStatus {
    PermissionStatus::Granted
}

/// No-op on Windows — there is nothing to request.
pub fn request_accessibility_permission() -> Result<(), PermissionError> {
    Ok(())
}

/// Windows has no deep-link URL for an accessibility settings panel.
pub fn platform_settings_url() -> Option<&'static str> {
    None
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_always_granted() {
        assert_eq!(check_accessibility_permission(), PermissionStatus::Granted);
    }

    #[test]
    fn windows_request_succeeds() {
        assert!(request_accessibility_permission().is_ok());
    }
}
