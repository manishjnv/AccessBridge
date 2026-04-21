//! AccessBridge Desktop Agent — library entry.
//!
//! Wires the Tauri UI, the IPC WebSocket server, and the UIA dispatcher
//! together. Phase 2: swap in-memory profile store for SQLCipher; replace
//! Windows-only dispatcher with cross-platform equivalents.

pub mod bridge;
pub mod crypto;
pub mod ipc_protocol;
pub mod ipc_server;
pub mod profile_store;
pub mod tray;

#[cfg(windows)]
pub mod uia;

#[cfg(not(windows))]
pub mod uia_stub;

use std::sync::Arc;

use ipc_server::{ServerContext, UiaDispatch};
use profile_store::ProfileStore;

fn default_agent_info() -> ipc_protocol::AgentInfo {
    ipc_protocol::AgentInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        capabilities: agent_capabilities(),
    }
}

fn agent_capabilities() -> Vec<String> {
    let mut caps = vec!["ipc".to_string(), "uia-inspect".to_string()];
    #[cfg(windows)]
    caps.push("process-dpi".to_string());
    caps
}

fn build_uia() -> Arc<dyn UiaDispatch + Send + Sync> {
    #[cfg(windows)]
    {
        Arc::new(uia::WindowsUiaDispatcher::new())
    }
    #[cfg(not(windows))]
    {
        Arc::new(uia_stub::StubDispatcher::new())
    }
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let store = ProfileStore::new();
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
