//! System tray icon and context menu for the Desktop Agent.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};

pub fn install_tray(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let open_settings =
        MenuItem::with_id(app, "open_settings", "Open Settings", true, None::<&str>)?;
    let pause =
        MenuItem::with_id(app, "pause", "Pause Adaptations", true, None::<&str>)?;
    let show_log =
        MenuItem::with_id(app, "show_log", "Show Log", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open_settings, &pause, &show_log, &quit])?;

    let _tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("AccessBridge Desktop Agent")
        .icon(app.default_window_icon().cloned().unwrap())
        .on_menu_event(move |app_handle, event| match event.id().as_ref() {
            "open_settings" => {
                let _ = toggle_settings_window(app_handle);
            }
            "pause" => {
                // TODO(session20): toggle adaptation suspension state
            }
            "show_log" => {
                let _ = toggle_settings_window(app_handle);
            }
            "quit" => {
                app_handle.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = toggle_settings_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn toggle_settings_window(app: &AppHandle<Wry>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("settings") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    Ok(())
}
