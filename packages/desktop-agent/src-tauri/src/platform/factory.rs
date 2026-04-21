//! Platform adapter factory.
//!
//! `make_adapter()` returns the correct `AccessibilityAdapter` implementation
//! for the current compile target at compile time via `#[cfg(target_os = ...)]`.
//!
//! Tests that need a no-op adapter (e.g. ipc_server unit tests) should call
//! `make_mock_adapter()` instead of `make_adapter()` to avoid platform FFI.

use std::sync::Arc;

use crate::platform::{
    AccessibilityAdapter, AdaptationHandle, AdapterError, AdapterResult, Capability, Element,
};
use crate::ipc_protocol::{NativeElementInfo, NativeTargetHint};

// ---------------------------------------------------------------------------
// Production factory
// ---------------------------------------------------------------------------

/// Return the platform-native adapter as an `Arc<dyn AccessibilityAdapter>`.
///
/// Selecting happens at compile time; only one branch is compiled per target.
pub fn make_adapter() -> Arc<dyn AccessibilityAdapter> {
    #[cfg(target_os = "windows")]
    return Arc::new(crate::platform::windows::WindowsAdapter::new());

    #[cfg(target_os = "macos")]
    return Arc::new(crate::platform::macos::MacOsAdapter::new());

    #[cfg(target_os = "linux")]
    return Arc::new(crate::platform::linux::LinuxAdapter::new());

    // Fallback for any other target (should not be reachable in practice).
    #[allow(unreachable_code)]
    Arc::new(FallbackAdapter)
}

// ---------------------------------------------------------------------------
// Mock adapter (tests)
// ---------------------------------------------------------------------------

/// A no-op adapter for tests that don't need real UIA / AT-SPI.
///
/// `list_top_level_windows` returns empty; `find_element` always returns None;
/// `apply_font_scale` returns a dummy `AdaptationHandle`.
pub struct MockAdapter;

impl AccessibilityAdapter for MockAdapter {
    fn platform_name(&self) -> &'static str {
        "mock"
    }

    fn capabilities(&self) -> Vec<Capability> {
        vec![Capability::Ipc]
    }

    fn list_top_level_windows(&self) -> AdapterResult<Vec<NativeElementInfo>> {
        Ok(Vec::new())
    }

    fn find_element(&self, _hint: &NativeTargetHint) -> AdapterResult<Option<Element>> {
        Ok(None)
    }

    fn apply_font_scale(
        &self,
        _element: &Element,
        _scale: f32,
    ) -> AdapterResult<AdaptationHandle> {
        Ok(AdaptationHandle {
            id: "mock-handle".into(),
            revert: crate::platform::RevertState::None,
        })
    }

    fn revert_adaptation(&self, _handle: AdaptationHandle) -> AdapterResult<()> {
        Ok(())
    }
}

/// Convenience constructor used by unit tests.
pub fn make_mock_adapter() -> Arc<dyn AccessibilityAdapter> {
    Arc::new(MockAdapter)
}

// ---------------------------------------------------------------------------
// Fallback adapter (unknown OS — compile guard only, never intended to run)
// ---------------------------------------------------------------------------

struct FallbackAdapter;

impl AccessibilityAdapter for FallbackAdapter {
    fn platform_name(&self) -> &'static str {
        "unknown"
    }

    fn capabilities(&self) -> Vec<Capability> {
        vec![Capability::Ipc]
    }

    fn list_top_level_windows(&self) -> AdapterResult<Vec<NativeElementInfo>> {
        Ok(Vec::new())
    }

    fn find_element(&self, _hint: &NativeTargetHint) -> AdapterResult<Option<Element>> {
        Ok(None)
    }

    fn apply_font_scale(
        &self,
        _element: &Element,
        _scale: f32,
    ) -> AdapterResult<AdaptationHandle> {
        Err(AdapterError::Unsupported(
            "no adapter available for this platform".into(),
        ))
    }

    fn revert_adaptation(&self, _handle: AdaptationHandle) -> AdapterResult<()> {
        Err(AdapterError::Unsupported(
            "no adapter available for this platform".into(),
        ))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_adapter_platform_name() {
        let a = MockAdapter;
        assert_eq!(a.platform_name(), "mock");
    }

    #[test]
    fn mock_adapter_capabilities_include_ipc() {
        let a = MockAdapter;
        assert!(a.capabilities().contains(&Capability::Ipc));
    }

    #[test]
    fn make_mock_adapter_returns_arc() {
        let a = make_mock_adapter();
        assert_eq!(a.platform_name(), "mock");
    }
}
