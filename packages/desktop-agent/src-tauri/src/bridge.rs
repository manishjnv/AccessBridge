//! Tauri commands exposed to the React settings window.

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
