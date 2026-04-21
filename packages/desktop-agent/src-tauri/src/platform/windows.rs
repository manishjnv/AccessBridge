//! Windows UIAutomation accessibility adapter.
//!
//! Implements `AccessibilityAdapter` for the Windows platform.
//! Uses the `uiautomation` crate for element discovery and the Win32
//! `windows` crate for process-level introspection.
//!
//! The primary MVP adaptation path is per-process DPI scaling.  Per-process
//! DPI override requires injecting the target process (SetProcessDpiAwarenessContext
//! only works on the current process), so the honest MVP response is
//! `AdapterError::Unsupported` with a clear user-facing reason.
//!
//! Phase 2 will add a shim DLL injection path for true per-app font scaling.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tracing::warn;

use crate::ipc_protocol::{NativeElementInfo, NativeTargetHint, Rect};
use crate::platform::{
    AccessibilityAdapter, AdaptationHandle, AdapterError, AdapterResult, Capability, Element,
    PlatformElement, RevertState,
};

// ---------------------------------------------------------------------------
// WindowsAdapter
// ---------------------------------------------------------------------------

/// Windows UIA-backed accessibility adapter.
///
/// Thread-safe: the inner state map is protected by a Mutex so callers can
/// hold an `Arc<WindowsAdapter>` without external locking.
pub struct WindowsAdapter {
    /// Tracks pending revert tokens keyed by adaptation ID.
    _state: Arc<Mutex<HashMap<String, ()>>>,
}

impl WindowsAdapter {
    pub fn new() -> Self {
        WindowsAdapter {
            _state: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for WindowsAdapter {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// AccessibilityAdapter implementation
// ---------------------------------------------------------------------------

impl AccessibilityAdapter for WindowsAdapter {
    fn platform_name(&self) -> &'static str {
        "windows"
    }

    fn capabilities(&self) -> Vec<Capability> {
        vec![Capability::Ipc, Capability::UiaInspect, Capability::FontScale]
    }

    fn list_top_level_windows(&self) -> AdapterResult<Vec<NativeElementInfo>> {
        list_top_level_windows_impl()
    }

    fn find_element(&self, hint: &NativeTargetHint) -> AdapterResult<Option<Element>> {
        find_element_impl(hint)
    }

    fn apply_font_scale(
        &self,
        _element: &Element,
        _scale: f32,
    ) -> AdapterResult<AdaptationHandle> {
        // MVP stub: per-process DPI scaling requires injecting the target process.
        // True per-app DPI scaling needs DLL injection or a shim DLL — out of scope.
        //
        // Honest response: return Unsupported with a clear reason so the extension
        // can surface "Native font scaling: not yet implemented" and nudge the user
        // back to the browser Sensory adapter.
        Err(AdapterError::Unsupported(
            "per-process DPI override requires a shim DLL (Phase 2 feature)".into(),
        ))
    }

    fn revert_adaptation(&self, handle: AdaptationHandle) -> AdapterResult<()> {
        match handle.revert {
            RevertState::WindowsDpi { .. } => {
                // Full revert requires re-injecting the previous DPI awareness context.
                // For MVP this is a known limitation. The target process must be
                // restarted for full revert.
                warn!(
                    "DPI revert is best-effort — target process must be restarted for full revert"
                );
                Ok(())
            }
            RevertState::WindowsWmSetFont { .. } => {
                // WM_SETFONT revert would re-send the previous font handle.
                // Not yet implemented in MVP.
                warn!("WM_SETFONT revert not yet implemented — target may need restart");
                Ok(())
            }
            RevertState::None => Ok(()),
            #[cfg(target_os = "macos")]
            RevertState::MacOsAxFontSize { .. } | RevertState::MacOsAppleScriptReader => {
                Err(AdapterError::Unsupported(
                    "macOS revert state cannot be reverted by Windows adapter".into(),
                ))
            }
        }
    }

    // apply_adaptation uses the default impl from AccessibilityAdapter, which
    // routes "font-scale"/"process-dpi" → apply_font_scale() (returns Unsupported
    // with a clear reason until Phase 2 shim DLL is ready).
}

// ---------------------------------------------------------------------------
// Discovery — list top-level windows
// ---------------------------------------------------------------------------

fn list_top_level_windows_impl() -> AdapterResult<Vec<NativeElementInfo>> {
    // TODO(session19-verify): verify uiautomation 0.15 API surface.
    let automation = uiautomation::UIAutomation::new()
        .map_err(|e| AdapterError::PlatformError(e.to_string()))?;
    let root = automation
        .get_root_element()
        .map_err(|e| AdapterError::PlatformError(e.to_string()))?;
    let walker = automation
        .get_control_view_walker()
        .map_err(|e| AdapterError::PlatformError(e.to_string()))?;

    let mut out = Vec::new();
    let mut node = walker.get_first_child(&root).ok();
    while let Some(child) = node {
        if let Ok(info) = element_info(&child) {
            if is_user_relevant(&info) {
                out.push(info);
            }
        }
        node = walker.get_next_sibling(&child).ok();
        if out.len() >= 256 {
            break;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Discovery — find a single element matching a hint
// ---------------------------------------------------------------------------

fn find_element_impl(hint: &NativeTargetHint) -> AdapterResult<Option<Element>> {
    // TODO(session19-verify): verify uiautomation 0.15 API surface.
    let automation = uiautomation::UIAutomation::new()
        .map_err(|e| AdapterError::PlatformError(e.to_string()))?;
    let root = automation
        .get_root_element()
        .map_err(|e| AdapterError::PlatformError(e.to_string()))?;
    let walker = automation
        .get_control_view_walker()
        .map_err(|e| AdapterError::PlatformError(e.to_string()))?;

    let mut node = walker.get_first_child(&root).ok();
    while let Some(child) = node {
        if let Ok(info) = element_info(&child) {
            if is_user_relevant(&info) && matches_hint(&info, hint) {
                // Extract the automation_id and process_id for the PlatformElement handle.
                let automation_id = info.automation_id.clone();
                // TODO(session19-verify): confirm get_process_id() return type.
                let process_id = child.get_process_id().unwrap_or(0) as u32;
                let handle = PlatformElement::Windows { automation_id, process_id };
                let element = Element::new(info, handle);
                return Ok(Some(element));
            }
        }
        node = walker.get_next_sibling(&child).ok();
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// Element info helper
// ---------------------------------------------------------------------------

fn element_info(
    el: &uiautomation::UIElement, // TODO(session19-verify): confirm type path
) -> Result<NativeElementInfo, AdapterError> {
    let name = el.get_name().unwrap_or_default();
    let class_name = el.get_classname().unwrap_or_default();
    let automation_id = el.get_automation_id().unwrap_or_default();
    let control_type = el
        .get_control_type()
        .map(|ct| format!("{:?}", ct))
        .unwrap_or_else(|_| "Unknown".to_string());
    let process_name = process_name_for_element(el).unwrap_or_default();

    // TODO(session19-verify): confirm bounding rectangle API on uiautomation 0.15.
    let rect = el
        .get_bounding_rectangle()
        .ok()
        .map(|r| Rect {
            x: r.get_left(),
            y: r.get_top(),
            width: r.get_right() - r.get_left(),
            height: r.get_bottom() - r.get_top(),
        })
        .unwrap_or(Rect { x: 0, y: 0, width: 0, height: 0 });

    Ok(NativeElementInfo {
        process_name,
        window_title: name,
        class_name,
        automation_id,
        control_type,
        bounding_rect: rect,
    })
}

fn process_name_for_element(
    el: &uiautomation::UIElement, // TODO(session19-verify): confirm type path
) -> Option<String> {
    // TODO(session19-verify): confirm get_process_id() return type.
    let pid = el.get_process_id().ok()? as u32;
    process_name_by_pid(pid)
}

fn process_name_by_pid(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::GetModuleBaseNameW;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
            false,
            pid,
        )
        .ok()?;
        let mut buf = [0u16; 260];
        let n = GetModuleBaseNameW(handle, None, &mut buf);
        let _ = CloseHandle(handle);
        if n == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..n as usize]))
    }
}

// ---------------------------------------------------------------------------
// Hint matcher
// ---------------------------------------------------------------------------

fn matches_hint(info: &NativeElementInfo, hint: &NativeTargetHint) -> bool {
    let process_ok = hint
        .process_name
        .as_ref()
        .map(|p| info.process_name.eq_ignore_ascii_case(p))
        .unwrap_or(true);
    let title_ok = hint
        .window_title
        .as_ref()
        .map(|t| info.window_title.contains(t.as_str()))
        .unwrap_or(true);
    let class_ok = hint
        .class_name
        .as_ref()
        .map(|c| info.class_name.eq_ignore_ascii_case(c))
        .unwrap_or(true);
    let elem_ok = hint
        .element_name
        .as_ref()
        .map(|n| info.window_title.contains(n.as_str()))
        .unwrap_or(true);
    let aid_ok = hint
        .automation_id
        .as_ref()
        .map(|a| info.automation_id.eq_ignore_ascii_case(a))
        .unwrap_or(true);
    process_ok && title_ok && class_ok && elem_ok && aid_ok
}

// ---------------------------------------------------------------------------
// Filter heuristics (ported from uia/filters.rs)
// ---------------------------------------------------------------------------

/// Returns `true` if the element is likely user-relevant (not Shell chrome /
/// invisible / zero-size).
pub fn is_user_relevant(info: &NativeElementInfo) -> bool {
    const SYSTEM_CLASSES: &[&str] = &[
        "Shell_TrayWnd",
        "Progman",
        "WorkerW",
        "DummyDWMListenerWindow",
        "ApplicationFrameWindow",
        "Windows.UI.Core.CoreWindow",
    ];

    if SYSTEM_CLASSES
        .iter()
        .any(|c| info.class_name.eq_ignore_ascii_case(c))
    {
        return false;
    }

    if info.window_title.is_empty() && info.class_name.is_empty() {
        return false;
    }

    info.bounding_rect.width > 0 && info.bounding_rect.height > 0
}

// ---------------------------------------------------------------------------
// Compat shim — lets the old UiaDispatch callers use this adapter
//
// `WindowsAdapter` also implements `UiaDispatch` (via the blanket impl in
// ipc_server.rs), so `ServerContext::uia` can hold an `Arc<WindowsAdapter>`
// with zero changes to the dispatch() function or its test suite.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests (6 filter tests ported from uia/filters.rs)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc_protocol::Rect;

    fn elem(class: &str, title: &str) -> NativeElementInfo {
        NativeElementInfo {
            process_name: "x.exe".into(),
            window_title: title.into(),
            class_name: class.into(),
            automation_id: String::new(),
            control_type: "Window".into(),
            bounding_rect: Rect { x: 0, y: 0, width: 800, height: 600 },
        }
    }

    #[test]
    fn filters_system_shell_classes() {
        assert!(!is_user_relevant(&elem("Shell_TrayWnd", "")));
        assert!(!is_user_relevant(&elem("Progman", "Program Manager")));
    }

    #[test]
    fn filters_worker_w() {
        assert!(!is_user_relevant(&elem("WorkerW", "")));
    }

    #[test]
    fn keeps_regular_windows() {
        assert!(is_user_relevant(&elem("Notepad", "Untitled - Notepad")));
    }

    #[test]
    fn drops_zero_width_windows() {
        let mut e = elem("SomeApp", "Title");
        e.bounding_rect.width = 0;
        assert!(!is_user_relevant(&e));
    }

    #[test]
    fn drops_zero_height_windows() {
        let mut e = elem("SomeApp", "Title");
        e.bounding_rect.height = 0;
        assert!(!is_user_relevant(&e));
    }

    #[test]
    fn drops_empty_title_and_class() {
        assert!(!is_user_relevant(&elem("", "")));
    }
}
