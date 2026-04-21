//! Windows UIAutomation adaptation applier.
//!
//! MVP: `font-scale` / `process-dpi` stubs with honest UnsupportedTarget
//! responses. Per-process DPI override requires a shim DLL (Phase 2).

use crate::ipc_protocol::{Adaptation, NativeTargetHint};
use crate::ipc_server::UiaError;

/// Token that carries the information needed to revert an applied adaptation.
pub enum RevertToken {
    DpiScale { pid: u32, previous_ctx: usize },
    Placeholder,
}

/// Apply an adaptation to the target element. Returns a `RevertToken` on
/// success, or a `UiaError` explaining why the adaptation could not be applied.
pub fn apply(target: &NativeTargetHint, adaptation: &Adaptation) -> Result<RevertToken, UiaError> {
    match adaptation.kind.as_str() {
        "font-scale" | "process-dpi" => apply_process_dpi(target, adaptation),
        _ => Err(UiaError::UnsupportedTarget),
    }
}

/// Revert a previously-applied adaptation.
pub fn revert(token: RevertToken) -> Result<(), UiaError> {
    match token {
        RevertToken::DpiScale { .. } => {
            // Full revert requires re-injecting the previous DPI awareness context;
            // for MVP this is a known limitation. The target process must be
            // restarted for full revert.
            tracing::warn!(
                "DPI revert is best-effort — target process must be restarted for full revert"
            );
            Ok(())
        }
        RevertToken::Placeholder => Ok(()),
    }
}

fn apply_process_dpi(
    _target: &NativeTargetHint,
    _adaptation: &Adaptation,
) -> Result<RevertToken, UiaError> {
    // MVP stub: per-process DPI scaling requires injecting the target process
    // (SetProcessDpiAwarenessContext only works on the current process).
    // True per-app DPI scaling needs DLL injection or a shim DLL — out of scope.
    //
    // Honest response: return UnsupportedTarget with a clear reason so the
    // extension can surface "Native font scaling: not yet implemented" and
    // nudge the user back to the browser Sensory adapter.
    Err(UiaError::Platform(
        "per-process DPI override requires a shim DLL (Phase 2 feature)".into(),
    ))
}
