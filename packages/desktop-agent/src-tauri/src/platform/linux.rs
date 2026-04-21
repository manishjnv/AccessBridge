//! Linux AT-SPI accessibility adapter stub.
//!
//! Phase 2 will replace this with a real AT-SPI2 / atspi-rs integration.
//! For now, capabilities are limited to IPC-only and all inspection / adaptation
//! calls return appropriate Unsupported errors or empty results.

use crate::ipc_protocol::{NativeElementInfo, NativeTargetHint};
use crate::platform::{
    AccessibilityAdapter, AdaptationHandle, AdapterError, AdapterResult, Capability, Element,
    RevertState,
};

// ---------------------------------------------------------------------------
// LinuxAdapter
// ---------------------------------------------------------------------------

/// Stub adapter for Linux. Advertises only the IPC capability.
/// AT-SPI element discovery and font-scale adaptation are not yet implemented.
pub struct LinuxAdapter;

impl LinuxAdapter {
    pub fn new() -> Self {
        LinuxAdapter
    }
}

impl Default for LinuxAdapter {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// AccessibilityAdapter implementation
// ---------------------------------------------------------------------------

impl AccessibilityAdapter for LinuxAdapter {
    fn platform_name(&self) -> &'static str {
        "linux"
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
            "Linux AT-SPI adapter not yet implemented (Phase 2)".into(),
        ))
    }

    fn revert_adaptation(&self, handle: AdaptationHandle) -> AdapterResult<()> {
        match handle.revert {
            RevertState::None => Ok(()),
            _ => Err(AdapterError::Unsupported(
                "Linux AT-SPI adapter does not support revert (Phase 2)".into(),
            )),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — confirm stub behaviour
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc_protocol::NativeTargetHint;
    use crate::platform::{AdaptationHandle, RevertState};

    fn make_adapter() -> LinuxAdapter {
        LinuxAdapter::new()
    }

    #[test]
    fn linux_adapter_only_advertises_ipc() {
        let a = make_adapter();
        let caps = a.capabilities();
        assert_eq!(caps, vec![Capability::Ipc]);
    }

    #[test]
    fn linux_list_top_level_windows_returns_empty() {
        let a = make_adapter();
        let result = a.list_top_level_windows();
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn linux_find_element_returns_none() {
        let a = make_adapter();
        let hint = NativeTargetHint::default();
        let result = a.find_element(&hint);
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn linux_revert_none_is_ok() {
        let a = make_adapter();
        let handle = AdaptationHandle { id: "x".into(), revert: RevertState::None };
        assert!(a.revert_adaptation(handle).is_ok());
    }

    #[test]
    fn linux_revert_non_none_is_unsupported() {
        let a = make_adapter();
        let handle = AdaptationHandle {
            id: "x".into(),
            revert: RevertState::WindowsDpi { pid: 1234, previous_ctx: 0 },
        };
        let result = a.revert_adaptation(handle);
        assert!(matches!(result, Err(AdapterError::Unsupported(_))));
    }
}
