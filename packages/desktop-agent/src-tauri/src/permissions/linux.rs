//! Linux accessibility permission stub.
//!
//! Linux uses AT-SPI2 for accessibility, which does not have a per-process
//! permission gate comparable to macOS TCC. Any application can use AT-SPI2
//! provided the `at-spi2-core` daemon is running; per-app restrictions are
//! handled out-of-band (e.g. AppArmor/SELinux policy), not via a runtime
//! consent API. Therefore this platform always reports `Granted`.

use super::{PermissionError, PermissionStatus};

/// Always returns `Granted` — Linux has no AT-SPI permission gate.
pub fn check_accessibility_permission() -> PermissionStatus {
    PermissionStatus::Granted
}

/// No-op on Linux — there is nothing to request.
pub fn request_accessibility_permission() -> Result<(), PermissionError> {
    Ok(())
}

/// Linux has no standard deep-link URL for an accessibility settings panel.
pub fn platform_settings_url() -> Option<&'static str> {
    None
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_always_granted() {
        assert_eq!(check_accessibility_permission(), PermissionStatus::Granted);
    }

    #[test]
    fn linux_request_succeeds() {
        assert!(request_accessibility_permission().is_ok());
    }
}
