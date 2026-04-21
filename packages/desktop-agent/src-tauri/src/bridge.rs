//! Tauri commands exposed to the React settings window.

use crate::permissions;
use crate::profile_store::ProfileStore;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub fn bridge_get_profile(store: State<'_, ProfileStore>) -> Value {
    store.get()
}

#[tauri::command]
pub fn bridge_agent_info() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "capabilities": agent_capabilities(),
    })
}

fn agent_capabilities() -> Vec<&'static str> {
    let mut caps = vec!["ipc", "uia-inspect"];
    #[cfg(windows)]
    {
        caps.push("process-dpi");
        caps.push("wm-setfont-notepad");
    }
    caps
}

#[tauri::command]
pub fn bridge_get_pair_key_path() -> String {
    crate::ipc_server::pair_key_path()
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
pub fn bridge_read_pair_key_b64() -> Result<String, String> {
    let path = crate::ipc_server::pair_key_path();
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let (_file, psk) =
        crate::crypto::PairKeyFile::from_json(&raw).map_err(|e| format!("parse: {e}"))?;
    Ok(psk.to_base64())
}

/// Return the current accessibility permission status for this process.
///
/// Always `"granted"` on Windows and Linux. On macOS reflects real TCC state.
#[tauri::command]
pub fn bridge_check_accessibility_permission() -> permissions::PermissionStatus {
    permissions::check_accessibility_permission()
}

/// Prompt the user to grant accessibility access (macOS only; no-op elsewhere).
///
/// Returns `Ok(())` on success or an error string if the helper process fails
/// to spawn (macOS only).
#[tauri::command]
pub fn bridge_request_accessibility_permission() -> Result<(), String> {
    permissions::request_accessibility_permission().map_err(|e| e.to_string())
}
