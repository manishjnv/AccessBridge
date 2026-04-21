//! Windows UIAutomation element discovery.
//!
//! Walks the top-level control-view tree, applies user-relevance filters,
//! and returns a capped list of `NativeElementInfo`.

use crate::ipc_protocol::{NativeElementInfo, NativeTargetHint, Rect};
use crate::ipc_server::UiaError;
use super::filters;

/// Inspect the accessible element tree, optionally scoped to `target`.
/// Returns up to 256 user-relevant elements.
pub fn inspect(target: Option<NativeTargetHint>) -> Result<Vec<NativeElementInfo>, UiaError> {
    // TODO(session19-verify): verify uiautomation 0.15 API surface.
    let automation =
        uiautomation::UIAutomation::new().map_err(|e| UiaError::Platform(e.to_string()))?;
    let root = automation
        .get_root_element()
        .map_err(|e| UiaError::Platform(e.to_string()))?;
    let walker = automation
        .get_control_view_walker()
        .map_err(|e| UiaError::Platform(e.to_string()))?;

    let mut out = Vec::new();
    let mut node = walker.get_first_child(&root).ok();
    while let Some(child) = node {
        if let Ok(info) = element_info(&child) {
            if filters::is_user_relevant(&info) && matches_hint(&info, &target) {
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

fn element_info(
    el: &uiautomation::UIElement, // TODO(session19-verify): confirm type path
) -> Result<NativeElementInfo, UiaError> {
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

fn matches_hint(info: &NativeElementInfo, hint: &Option<NativeTargetHint>) -> bool {
    let Some(h) = hint else { return true };
    let process_ok = h
        .process_name
        .as_ref()
        .map(|p| info.process_name.eq_ignore_ascii_case(p))
        .unwrap_or(true);
    let title_ok = h
        .window_title
        .as_ref()
        .map(|t| info.window_title.contains(t.as_str()))
        .unwrap_or(true);
    let class_ok = h
        .class_name
        .as_ref()
        .map(|c| info.class_name.eq_ignore_ascii_case(c))
        .unwrap_or(true);
    let elem_ok = h
        .element_name
        .as_ref()
        .map(|n| info.window_title.contains(n.as_str()))
        .unwrap_or(true);
    let aid_ok = h
        .automation_id
        .as_ref()
        .map(|a| info.automation_id.eq_ignore_ascii_case(a))
        .unwrap_or(true);
    process_ok && title_ok && class_ok && elem_ok && aid_ok
}
