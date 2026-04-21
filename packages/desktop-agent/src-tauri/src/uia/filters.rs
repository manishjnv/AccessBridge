//! Filter heuristics for UIAutomation element enumeration.
//!
//! Drops Shell chrome, invisible work-area windows, and zero-area rectangles.

use crate::ipc_protocol::NativeElementInfo;

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
