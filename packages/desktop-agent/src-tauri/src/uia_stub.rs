//! Stub dispatcher for macOS/Linux — Phase 2 will replace this with
//! NSAccessibility and AT-SPI integrations respectively.

use crate::ipc_protocol::{Adaptation, NativeElementInfo, NativeTargetHint};
use crate::ipc_server::{UiaDispatch, UiaError};

pub struct StubDispatcher;

impl StubDispatcher {
    pub fn new() -> Self {
        StubDispatcher
    }
}

impl Default for StubDispatcher {
    fn default() -> Self {
        Self::new()
    }
}

impl UiaDispatch for StubDispatcher {
    fn inspect(&self, _target: Option<NativeTargetHint>) -> Vec<NativeElementInfo> {
        Vec::new()
    }

    fn apply(
        &self,
        _target: NativeTargetHint,
        _adaptation: Adaptation,
    ) -> Result<String, UiaError> {
        Err(UiaError::Platform(format!(
            "native adaptations not yet supported on {}",
            std::env::consts::OS
        )))
    }

    fn revert(&self, _id: &str) -> Result<(), UiaError> {
        Err(UiaError::NotFound)
    }
}
