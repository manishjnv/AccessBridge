//! Windows UIAutomation integration.
//!
//! The primary MVP adaptation path is per-process DPI scaling via the
//! HiDpi Win32 API (more reliable than UIA font manipulation which most
//! controls don't expose). A secondary WM_SETFONT path targets Notepad's
//! classic Edit control.

pub mod adapter;
pub mod discovery;
pub mod filters;

use crate::ipc_protocol::{Adaptation, NativeElementInfo, NativeTargetHint};
use crate::ipc_server::{UiaDispatch, UiaError};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct WindowsUiaDispatcher {
    state: Arc<Mutex<HashMap<String, adapter::RevertToken>>>,
}

impl WindowsUiaDispatcher {
    pub fn new() -> Self {
        WindowsUiaDispatcher {
            state: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for WindowsUiaDispatcher {
    fn default() -> Self {
        Self::new()
    }
}

impl UiaDispatch for WindowsUiaDispatcher {
    fn inspect(&self, target: Option<NativeTargetHint>) -> Vec<NativeElementInfo> {
        discovery::inspect(target).unwrap_or_default()
    }

    fn apply(
        &self,
        target: NativeTargetHint,
        adaptation: Adaptation,
    ) -> Result<String, UiaError> {
        let token = adapter::apply(&target, &adaptation)?;
        let id = adaptation.id.clone();
        if let Ok(mut s) = self.state.lock() {
            s.insert(id.clone(), token);
        }
        Ok(id)
    }

    fn revert(&self, adaptation_id: &str) -> Result<(), UiaError> {
        let token = {
            let mut s = self
                .state
                .lock()
                .map_err(|_| UiaError::Platform("lock poisoned".into()))?;
            s.remove(adaptation_id)
        };
        match token {
            Some(t) => adapter::revert(t),
            None => Err(UiaError::NotFound),
        }
    }
}
