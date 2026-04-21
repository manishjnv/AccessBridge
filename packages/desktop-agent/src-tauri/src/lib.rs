//! AccessBridge Desktop Agent — library entry.
//!
//! Wires the Tauri UI, the IPC WebSocket server, and the cross-platform
//! accessibility adapter together.
//! Phase 2: swap in-memory profile store for SQLCipher.

pub mod bridge;
pub mod crypto;
pub mod ipc_protocol;
pub mod ipc_server;
pub mod permissions;
pub mod platform;
pub mod profile_store;
pub mod tray;

use std::sync::Arc;

use ipc_server::{AdapterShim, ServerContext, UiaDispatch};
use platform::factory::make_adapter;
use platform::AccessibilityAdapter;
use profile_store::ProfileStore;

fn default_agent_info() -> ipc_protocol::AgentInfo {
    ipc_protocol::AgentInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        capabilities: agent_capabilities(),
    }
}

fn agent_capabilities() -> Vec<String> {
    // Derive capabilities from the adapter so wire-level strings stay in sync
    // with what the adapter actually supports.
    let adapter = make_adapter();
    adapter
        .capabilities()
        .iter()
        .map(|c| c.as_str().to_string())
        .collect()
}

/// Build the platform adapter and wrap it in `AdapterShim` so it can be
/// stored in `ServerContext::uia: Arc<dyn UiaDispatch + Send + Sync>`.
fn build_uia() -> Arc<dyn UiaDispatch + Send + Sync> {
    Arc::new(AdapterShim::new(make_adapter()))
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // Session 21: SQLCipher persistent store, master key via OS keyring.
    let db_key = match crypto::get_or_create_db_key() {
        Ok(k) => k,
        Err(err) => {
            tracing::error!("failed to get or create db master key: {err}");
            return;
        }
    };
    let store = match ProfileStore::open_default(&db_key) {
        Ok(s) => s,
        Err(err) => {
            tracing::error!("failed to open profile store: {err}");
            return;
        }
    };
    let store_for_server = store.clone();
    let psk = match ipc_server::load_or_create_pair_key() {
        Ok(k) => Arc::new(k),
        Err(err) => {
            tracing::error!("failed to load or create pair key: {err}");
            return;
        }
    };
    let uia = build_uia();

    let ctx = ServerContext {
        psk: psk.clone(),
        agent_info: default_agent_info(),
        profile_store: store_for_server,
        uia: uia.clone(),
    };

    // Run the WS server on a dedicated tokio runtime.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let server_handle = runtime.spawn(async move {
        if let Err(err) = ipc_server::serve(ctx).await {
            tracing::error!("ipc server exited: {err}");
        }
    });

    tauri::Builder::default()
        .manage(store)
        .manage(psk)
        .invoke_handler(tauri::generate_handler![
            bridge::bridge_get_profile,
            bridge::bridge_agent_info,
            bridge::bridge_get_pair_key_path,
            bridge::bridge_read_pair_key_b64,
            bridge::bridge_check_accessibility_permission,
            bridge::bridge_request_accessibility_permission,
        ])
        .setup(|app| {
            tray::install_tray(&app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    runtime.block_on(async {
        let _ = server_handle.await;
    });
}
