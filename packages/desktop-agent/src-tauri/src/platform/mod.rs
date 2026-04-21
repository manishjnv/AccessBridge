//! Cross-platform accessibility adapter layer (Session 21).
//!
//! Unifies Windows UIA (`platform::windows`), macOS NSAccessibility
//! (`platform::macos`), and Linux AT-SPI (`platform::linux`, stub) behind
//! a single trait so the IPC server doesn't know which OS it's running on.
//!
//! Design notes
//! ------------
//!
//! - `Element` and `AdaptationHandle` are opaque wrappers around
//!   platform-specific handles. They are marked `Send + Sync` via the
//!   variant types; the adapter contract assumes that the *caller* holds
//!   the lock (the IPC session is single-client by design, see
//!   `ipc_server.rs`).
//!
//! - `AdapterError::Unsupported` is the non-exceptional "this platform or
//!   control can't do that" result. It is not an error in the crash sense;
//!   the extension receives `ADAPTATION_APPLY_RESULT { ok: false, reason }`
//!   and surfaces a helpful message to the user. Reserve `PlatformError`
//!   for actual crashes (FFI returned garbage, system call failed).
//!
//! - `Capability` is the typed enum mirroring the `capabilities: string[]`
//!   field of the wire-level `AgentInfo` struct. Conversion via `as_str()`
//!   keeps the string form stable across refactors.

use crate::ipc_protocol::{Adaptation, NativeElementInfo, NativeTargetHint};

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/// Typed enumeration of accessibility capabilities the adapter might expose.
/// Serialised to lowercase-hyphenated strings over the wire (e.g. `"font-scale"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Capability {
    /// Per-element or per-process font scaling.
    FontScale,
    /// Contrast filter (light-on-dark / dark-on-light / invert).
    ContrastFilter,
    /// Larger system cursor.
    CursorSize,
    /// Spoken announcement via platform TTS.
    Announce,
    /// Bridge to an already-running screen reader (Narrator / VoiceOver / Orca).
    ScreenReaderBridge,
    /// System-wide colour inversion.
    ColorInvert,
    /// Read-only inspection of the accessibility element tree.
    UiaInspect,
    /// Loopback IPC endpoint presence (always true for an active adapter).
    Ipc,
}

impl Capability {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Capability::FontScale => "font-scale",
            Capability::ContrastFilter => "contrast-filter",
            Capability::CursorSize => "cursor-size",
            Capability::Announce => "announce",
            Capability::ScreenReaderBridge => "screen-reader-bridge",
            Capability::ColorInvert => "color-invert",
            Capability::UiaInspect => "uia-inspect",
            Capability::Ipc => "ipc",
        }
    }
}

// ---------------------------------------------------------------------------
// Element + AdaptationHandle (opaque wrappers)
// ---------------------------------------------------------------------------

/// An opaque reference to a platform-specific accessibility element.
/// Wraps a `PlatformElement` variant so callers never depend on a specific
/// OS handle type.
///
/// On Windows this holds a UIA element handle wrapped for thread-safety;
/// on macOS it holds a `CFRetain`'d `AXUIElementRef` inside a `Send` guard;
/// on Linux it's currently never constructed (stub returns `None`).
pub struct Element {
    #[allow(dead_code)]
    info: NativeElementInfo,
    handle: PlatformElement,
}

impl Element {
    pub fn new(info: NativeElementInfo, handle: PlatformElement) -> Self {
        Element { info, handle }
    }

    pub fn info(&self) -> &NativeElementInfo {
        &self.info
    }

    pub fn handle(&self) -> &PlatformElement {
        &self.handle
    }

    pub fn into_handle(self) -> PlatformElement {
        self.handle
    }
}

/// Platform-specific element handle variants. Non-public constructors —
/// each platform module provides the right variant for its adapter.
pub enum PlatformElement {
    /// Windows UIA element, serialised as an automation ID for revert lookup.
    Windows { automation_id: String, process_id: u32 },
    /// macOS AXUIElement, held by `AxElementRef` which manages `CFRetain`/`CFRelease`.
    #[cfg(target_os = "macos")]
    MacOs(crate::platform::macos::AxElementRef),
    /// Linux placeholder — never constructed in the stub.
    Linux,
    /// No-op variant for mocks and tests that don't care about the handle.
    None,
}

/// An opaque token the caller uses to revert a previously-applied adaptation.
///
/// Each variant is self-contained — it holds the *previous* state the adapter
/// needs to restore. The adapter itself does NOT maintain revert state
/// internally (the caller's IPC server does, via its `state: HashMap<String,
/// AdaptationHandle>`).
pub struct AdaptationHandle {
    pub id: String,
    pub revert: RevertState,
}

pub enum RevertState {
    WindowsDpi { pid: u32, previous_ctx: usize },
    WindowsWmSetFont { hwnd: usize, previous_font: usize },
    #[cfg(target_os = "macos")]
    MacOsAxFontSize {
        element: crate::platform::macos::AxElementRef,
        previous_size: f64,
    },
    #[cfg(target_os = "macos")]
    MacOsAppleScriptReader,
    /// Revert is a no-op (for mocks and tests).
    None,
}

// ---------------------------------------------------------------------------
// AdapterError
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    /// This platform or control does not support the requested operation.
    /// This is an expected outcome, NOT a crash. The reason string is shown
    /// to the user verbatim, so it should be actionable.
    #[error("unsupported: {0}")]
    Unsupported(String),

    /// OS accessibility permission has not been granted (macOS).
    #[error("permission denied: {0}")]
    PermissionDenied(String),

    /// A matching element was not found for the given hint.
    #[error("element not found")]
    ElementNotFound,

    /// A platform-level call failed (FFI, system call, unexpected state).
    #[error("platform error: {0}")]
    PlatformError(String),
}

pub type AdapterResult<T> = Result<T, AdapterError>;

// ---------------------------------------------------------------------------
// AccessibilityAdapter trait
// ---------------------------------------------------------------------------

/// The cross-platform accessibility adapter contract.
///
/// Implementations live in `platform::windows`, `platform::macos`,
/// `platform::linux`. The factory `platform::factory::make_adapter()`
/// returns the right one at compile time via `#[cfg(target_os = ...)]`.
pub trait AccessibilityAdapter: Send + Sync {
    /// Stable machine name for this platform: `"windows"`, `"macos"`, `"linux"`.
    fn platform_name(&self) -> &'static str;

    /// Capabilities this adapter advertises. The IPC server propagates these
    /// to the extension via the HELLO handshake's `capabilities` field.
    fn capabilities(&self) -> Vec<Capability>;

    /// Enumerate top-level accessible windows on the system.
    /// Returns a bounded list (platform-specific cap, typically 256).
    fn list_top_level_windows(&self) -> AdapterResult<Vec<NativeElementInfo>>;

    /// Find a single accessible element matching the hint. Returns `None` if
    /// no match; returns `Err` only on platform-level failure.
    fn find_element(&self, hint: &NativeTargetHint) -> AdapterResult<Option<Element>>;

    /// Apply a font scale factor to an element. The element MUST have been
    /// obtained via `find_element` on this adapter.
    fn apply_font_scale(
        &self,
        element: &Element,
        scale: f32,
    ) -> AdapterResult<AdaptationHandle>;

    /// Revert a previously-applied adaptation using its handle.
    fn revert_adaptation(&self, handle: AdaptationHandle) -> AdapterResult<()>;

    /// Apply a generic adaptation (font-scale, contrast, etc.). Default impl
    /// routes to `apply_font_scale` for the `"font-scale"` kind; override for
    /// richer adapters.
    fn apply_adaptation(
        &self,
        hint: &NativeTargetHint,
        adaptation: &Adaptation,
    ) -> AdapterResult<AdaptationHandle> {
        let element = self
            .find_element(hint)?
            .ok_or(AdapterError::ElementNotFound)?;
        match adaptation.kind.as_str() {
            "font-scale" | "process-dpi" => {
                let scale = adaptation
                    .value
                    .as_f64()
                    .unwrap_or(1.0) as f32;
                let mut handle = self.apply_font_scale(&element, scale)?;
                handle.id = adaptation.id.clone();
                Ok(handle)
            }
            other => Err(AdapterError::Unsupported(format!(
                "adaptation kind {other:?} not supported by {}",
                self.platform_name()
            ))),
        }
    }
}

// ---------------------------------------------------------------------------
// Module declarations — each platform module is cfg-gated so non-matching
// OSes don't try to compile the wrong crate deps.
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "linux")]
pub mod linux;

pub mod factory;

// ---------------------------------------------------------------------------
// Tests — trait contract (platform-independent)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_strings_are_stable() {
        // Locking down the wire-level strings so protocol consumers
        // (extension popup badge, sidepanel filter) don't break silently
        // if we rename variants.
        assert_eq!(Capability::FontScale.as_str(), "font-scale");
        assert_eq!(Capability::ContrastFilter.as_str(), "contrast-filter");
        assert_eq!(Capability::CursorSize.as_str(), "cursor-size");
        assert_eq!(Capability::Announce.as_str(), "announce");
        assert_eq!(Capability::ScreenReaderBridge.as_str(), "screen-reader-bridge");
        assert_eq!(Capability::ColorInvert.as_str(), "color-invert");
        assert_eq!(Capability::UiaInspect.as_str(), "uia-inspect");
        assert_eq!(Capability::Ipc.as_str(), "ipc");
    }

    #[test]
    fn adapter_error_unsupported_displays_reason() {
        let e = AdapterError::Unsupported("safari reader mode unavailable".into());
        assert_eq!(format!("{e}"), "unsupported: safari reader mode unavailable");
    }

    #[test]
    fn adapter_error_permission_denied_displays_reason() {
        let e = AdapterError::PermissionDenied("accessibility not granted".into());
        assert_eq!(format!("{e}"), "permission denied: accessibility not granted");
    }
}
