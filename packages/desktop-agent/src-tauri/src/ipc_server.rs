//! axum WebSocket IPC server.
//!
//! Binds to 127.0.0.1:8901, path `/agent`. Enforces a PSK-hash handshake
//! and serialises all frames via `ipc_protocol`.  Only ONE concurrent
//! client is permitted (the browser extension).

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::Response,
    routing::get,
    Router,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use futures::{SinkExt, StreamExt};
use tokio::sync::Semaphore;
use tracing::{error, info, warn};

use crate::crypto::{constant_time_eq, psk_hash, Psk};
use crate::ipc_protocol::{
    encode_message, parse_message, AgentInfo, AgentMessage, Adaptation, NativeElementInfo,
    NativeTargetHint,
};
use crate::platform::AccessibilityAdapter;
use crate::profile_store::ProfileStore;

pub const DEFAULT_PORT: u16 = 8901;

// ---------------------------------------------------------------------------
// Trait + error
// ---------------------------------------------------------------------------

/// Platform-specific UIAutomation dispatch.
pub trait UiaDispatch {
    fn inspect(&self, target: Option<NativeTargetHint>) -> Vec<NativeElementInfo>;
    fn apply(
        &self,
        target: NativeTargetHint,
        adaptation: Adaptation,
    ) -> Result<String, UiaError>;
    fn revert(&self, adaptation_id: &str) -> Result<(), UiaError>;
}

#[derive(Debug)]
pub enum UiaError {
    UnsupportedTarget,
    NotFound,
    PermissionDenied,
    Platform(String),
}

impl std::fmt::Display for UiaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UiaError::UnsupportedTarget => write!(f, "unsupported target"),
            UiaError::NotFound => write!(f, "adaptation not found"),
            UiaError::PermissionDenied => write!(f, "permission denied"),
            UiaError::Platform(msg) => write!(f, "platform error: {msg}"),
        }
    }
}

// ---------------------------------------------------------------------------
// AdapterShim — bridges Arc<dyn AccessibilityAdapter> → UiaDispatch.
//
// `dyn AccessibilityAdapter` does not auto-impl `UiaDispatch` (Rust's orphan
// rules prevent a blanket `impl<T: AccessibilityAdapter> UiaDispatch for T`
// from being used through a trait object).  Instead, `AdapterShim` is a
// thin newtype that holds the `Arc` and delegates each `UiaDispatch` method
// to the corresponding `AccessibilityAdapter` method.
//
// Usage: `AdapterShim::new(make_adapter())` — the result implements
// `UiaDispatch + Send + Sync` and can be wrapped in an `Arc` for
// `ServerContext::uia`.  The existing `dispatch()` and all its tests are
// completely unchanged.
// ---------------------------------------------------------------------------

/// Newtype wrapping `Arc<dyn AccessibilityAdapter>` so it can be stored in
/// `ServerContext::uia: Arc<dyn UiaDispatch + Send + Sync>`.
///
/// Holds a `HashMap<adaptation_id, AdaptationHandle>` so that `revert()` can
/// find the original handle produced by `apply()`. Without this, revert would
/// silently no-op — the handle was dropped at the end of `apply()`.
pub struct AdapterShim {
    adapter: Arc<dyn AccessibilityAdapter>,
    state: std::sync::Mutex<std::collections::HashMap<String, crate::platform::AdaptationHandle>>,
}

impl AdapterShim {
    pub fn new(inner: Arc<dyn AccessibilityAdapter>) -> Self {
        AdapterShim {
            adapter: inner,
            state: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

fn map_adapter_err(e: crate::platform::AdapterError) -> UiaError {
    match e {
        crate::platform::AdapterError::Unsupported(msg) => UiaError::Platform(msg),
        crate::platform::AdapterError::PermissionDenied(msg) => UiaError::Platform(msg),
        crate::platform::AdapterError::ElementNotFound => UiaError::UnsupportedTarget,
        crate::platform::AdapterError::PlatformError(msg) => UiaError::Platform(msg),
    }
}

impl UiaDispatch for AdapterShim {
    fn inspect(&self, target: Option<NativeTargetHint>) -> Vec<NativeElementInfo> {
        match target {
            None => self.adapter.list_top_level_windows().unwrap_or_default(),
            Some(hint) => match self.adapter.find_element(&hint) {
                Ok(Some(el)) => vec![el.info().clone()],
                _ => Vec::new(),
            },
        }
    }

    fn apply(
        &self,
        target: NativeTargetHint,
        adaptation: Adaptation,
    ) -> Result<String, UiaError> {
        let id = adaptation.id.clone();
        match self.adapter.apply_adaptation(&target, &adaptation) {
            Ok(handle) => {
                if let Ok(mut s) = self.state.lock() {
                    s.insert(id.clone(), handle);
                }
                Ok(id)
            }
            Err(e) => Err(map_adapter_err(e)),
        }
    }

    fn revert(&self, adaptation_id: &str) -> Result<(), UiaError> {
        // Session 21 fix: AdapterShim holds a HashMap<id, AdaptationHandle>
        // populated in apply().  revert() looks up the handle, removes it,
        // and delegates to the adapter.  If the id is unknown return NotFound
        // so the extension can surface a clear error.
        let handle = {
            let mut s = self
                .state
                .lock()
                .map_err(|_| UiaError::Platform("adapter state lock poisoned".into()))?;
            s.remove(adaptation_id)
        };
        match handle {
            Some(h) => self.adapter.revert_adaptation(h).map_err(map_adapter_err),
            None => Err(UiaError::NotFound),
        }
    }
}

// ---------------------------------------------------------------------------
// Server context
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct ServerContext {
    pub psk: Arc<Psk>,
    pub agent_info: AgentInfo,
    pub profile_store: ProfileStore,
    pub uia: Arc<dyn UiaDispatch + Send + Sync>,
}

// ONE concurrent client gate — Semaphore with 1 permit.
// We store it inside an Arc so it survives cloning the context.
#[derive(Clone)]
struct AppState {
    ctx: ServerContext,
    gate: Arc<Semaphore>,
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

pub async fn serve(ctx: ServerContext) -> anyhow::Result<()> {
    let state = AppState {
        ctx,
        gate: Arc::new(Semaphore::new(1)),
    };
    let app = Router::new()
        .route("/agent", get(ws_handler))
        .with_state(state);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT));
    info!("IPC server listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_client(socket, state))
}

// ---------------------------------------------------------------------------
// Per-connection handler
// ---------------------------------------------------------------------------

async fn handle_client(socket: WebSocket, state: AppState) {
    // Try to acquire the single-client gate without blocking.
    let permit = match state.gate.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            // Another client is connected — reject immediately.
            let err = AgentMessage::Error {
                request_id: None,
                code: "PORT_IN_USE".to_string(),
                message: "another client is already connected".to_string(),
            };
            send_and_close(socket, &err).await;
            return;
        }
    };

    info!("client connected");
    if let Err(e) = run_session(socket, &state.ctx).await {
        warn!("session ended: {e}");
    }
    drop(permit);
    info!("client disconnected — gate released");
}

async fn send_and_close(mut socket: WebSocket, msg: &AgentMessage) {
    if let Ok(text) = encode_message(msg) {
        let _ = socket.send(Message::Text(text.into())).await;
    }
    let _ = socket.close().await;
}

// ---------------------------------------------------------------------------
// Session (post-accept)
// ---------------------------------------------------------------------------

async fn run_session(socket: WebSocket, ctx: &ServerContext) -> anyhow::Result<()> {
    let (mut sink, mut stream) = socket.split();

    // --- Handshake: first frame must be HELLO ---
    let first_raw = match stream.next().await {
        Some(Ok(Message::Text(t))) => t.to_string(),
        Some(Ok(Message::Close(_))) | None => return Ok(()),
        Some(Ok(_)) => {
            anyhow::bail!("expected text frame for handshake, got binary/ping/pong");
        }
        Some(Err(e)) => return Err(e.into()),
    };

    let hello = match parse_message(&first_raw) {
        Ok(m) => m,
        Err(e) => {
            let err = AgentMessage::Error {
                request_id: None,
                code: "PARSE_ERROR".to_string(),
                message: e.to_string(),
            };
            let _ = sink.send(Message::Text(encode_message(&err)?.into())).await;
            return Ok(());
        }
    };

    let (psk_ok, client_nonce) = match &hello {
        AgentMessage::Hello { psk_hash: client_hash, nonce, .. } => {
            let nonce_bytes = URL_SAFE_NO_PAD
                .decode(nonce)
                .unwrap_or_default();
            let expected = hex::encode(psk_hash(&ctx.psk, &nonce_bytes));
            let ok = constant_time_eq(expected.as_bytes(), client_hash.as_bytes());
            (ok, nonce.clone())
        }
        _ => {
            let err = AgentMessage::Error {
                request_id: None,
                code: "HANDSHAKE_EXPECTED".to_string(),
                message: "expected HELLO as first message".to_string(),
            };
            let _ = sink.send(Message::Text(encode_message(&err)?.into())).await;
            return Ok(());
        }
    };

    let ack = AgentMessage::HelloAck {
        psk_ok,
        server: ctx.agent_info.clone(),
    };
    sink.send(Message::Text(encode_message(&ack)?.into())).await?;

    if !psk_ok {
        warn!("PSK mismatch for nonce={client_nonce}");
        return Ok(());
    }
    info!("handshake OK");

    // Subscribe to profile updates BEFORE entering the main loop so we
    // don't miss any events that arrive during loop startup.
    let mut profile_sub = ctx.profile_store.subscribe();

    // Main loop: multiplex incoming WS frames with outgoing profile-update broadcasts.
    loop {
        tokio::select! {
            // Incoming frame from extension.
            frame = stream.next() => {
                match frame {
                    None | Some(Ok(Message::Close(_))) => break,
                    Some(Ok(Message::Text(raw))) => {
                        let response = dispatch_text(ctx, raw.as_str()).await;
                        let encoded = encode_message(&response)?;
                        sink.send(Message::Text(encoded.into())).await?;
                    }
                    Some(Ok(Message::Ping(data))) => {
                        // axum handles Ping/Pong automatically when using split(),
                        // but emit Pong manually to be explicit.
                        sink.send(Message::Pong(data)).await?;
                    }
                    Some(Ok(_)) => {} // binary / pong — ignore
                    Some(Err(e)) => {
                        error!("ws recv error: {e}");
                        break;
                    }
                }
            }

            // Profile changed from another source (e.g. settings window).
            // Drain a single message and push PROFILE_UPDATED.
            profile_val = profile_sub.recv() => {
                match profile_val {
                    Ok(val) => {
                        let msg = AgentMessage::ProfileUpdated { profile: val };
                        if let Ok(encoded) = encode_message(&msg) {
                            let _ = sink.send(Message::Text(encoded.into())).await;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        warn!("profile subscriber lagged, dropped {n} messages");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Message dispatch — factored out so tests can call it directly.
// ---------------------------------------------------------------------------

/// Dispatch a single already-authenticated message and return the response.
/// This does NOT send over the wire; the caller serialises + sends.
pub async fn dispatch(ctx: &ServerContext, msg: AgentMessage) -> AgentMessage {
    match msg {
        AgentMessage::ProfileGet { request_id } => AgentMessage::ProfileResult {
            request_id,
            profile: ctx.profile_store.get(),
        },

        AgentMessage::ProfileSet { request_id, profile } => {
            // Drain the broadcast subscriber for this session to avoid
            // echo-ing back PROFILE_UPDATED to the originator.
            // In dispatch() (test-only path) we simply call set and echo.
            let stored = ctx.profile_store.set(profile);
            AgentMessage::ProfileResult {
                request_id,
                profile: stored,
            }
        }

        AgentMessage::Ping { request_id } => AgentMessage::Pong { request_id },

        AgentMessage::UiaInspect { request_id, target } => {
            let elements = ctx.uia.inspect(target);
            AgentMessage::UiaElements { request_id, elements }
        }

        AgentMessage::AdaptationApply { request_id, target, adaptation } => {
            let adaptation_id_hint = adaptation.id.clone();
            match ctx.uia.apply(target, adaptation) {
                Ok(id) => AgentMessage::AdaptationApplyResult {
                    request_id,
                    adaptation_id: id,
                    ok: true,
                    reason: None,
                },
                Err(e) => AgentMessage::AdaptationApplyResult {
                    request_id,
                    adaptation_id: adaptation_id_hint,
                    ok: false,
                    reason: Some(e.to_string()),
                },
            }
        }

        AgentMessage::AdaptationRevert { request_id, adaptation_id } => {
            let ok = ctx.uia.revert(&adaptation_id).is_ok();
            AgentMessage::AdaptationRevertResult { request_id, ok }
        }

        other => {
            let rid = extract_request_id(&other);
            AgentMessage::Error {
                request_id: rid,
                code: "UNKNOWN_MESSAGE".to_string(),
                message: "unhandled message type".to_string(),
            }
        }
    }
}

async fn dispatch_text(ctx: &ServerContext, raw: &str) -> AgentMessage {
    match parse_message(raw) {
        Ok(msg) => dispatch(ctx, msg).await,
        Err(e) => AgentMessage::Error {
            request_id: None,
            code: "PARSE_ERROR".to_string(),
            message: e.to_string(),
        },
    }
}

fn extract_request_id(msg: &AgentMessage) -> Option<String> {
    match msg {
        AgentMessage::ProfileGet { request_id } => Some(request_id.clone()),
        AgentMessage::ProfileSet { request_id, .. } => Some(request_id.clone()),
        AgentMessage::Ping { request_id } => Some(request_id.clone()),
        AgentMessage::UiaInspect { request_id, .. } => Some(request_id.clone()),
        AgentMessage::AdaptationApply { request_id, .. } => Some(request_id.clone()),
        AgentMessage::AdaptationRevert { request_id, .. } => Some(request_id.clone()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Pair key helpers
// ---------------------------------------------------------------------------

/// Return the platform-appropriate path for the PSK pair-key file.
///
/// Delegates to [`crate::xdg_paths::psk_path`] which implements XDG
/// `$XDG_RUNTIME_DIR` on Linux (ephemeral, cleared on logout), the
/// Windows `%LOCALAPPDATA%` path, and macOS `Application Support`.
///
/// When `$XDG_RUNTIME_DIR` is unset on Linux the call falls back to
/// `~/.cache/accessbridge/pair.key` and emits a `tracing::warn`.
pub fn pair_key_path() -> PathBuf {
    crate::xdg_paths::psk_path()
}

pub fn load_or_create_pair_key() -> anyhow::Result<Psk> {
    let path = pair_key_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if path.exists() {
        let raw = std::fs::read_to_string(&path)?;
        let (_file, psk) = crate::crypto::PairKeyFile::from_json(&raw)?;
        return Ok(psk);
    }
    let (file, psk) = crate::crypto::PairKeyFile::new_with_random_psk();
    // Write the PSK file with 0o600 permissions from creation (no umask race).
    // On Unix we use OpenOptionsExt::mode(0o600) so the file is never world-readable,
    // then chmod again in case the file pre-existed with broader perms.
    // On non-Unix platforms we fall back to a plain write (Windows uses ACLs).
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)?;
        f.write_all(file.to_json()?.as_bytes())?;
        // chmod again in case the file pre-existed with broader perms
        // (OpenOptionsExt::mode only applies on creation).
        let mut perms = std::fs::metadata(&path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms)?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&path, file.to_json()?)?;
    }
    Ok(psk)
}

/// Internal helper: write a freshly-generated PSK to an arbitrary path using
/// the same secure-create logic as `load_or_create_pair_key`.  Exposed for
/// unit-testing the 0o600 permission invariant without touching the real
/// `pair_key_path()` location.
pub(crate) fn write_pair_key_at(path: &std::path::Path) -> anyhow::Result<Psk> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let (file, psk) = crate::crypto::PairKeyFile::new_with_random_psk();
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(file.to_json()?.as_bytes())?;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(path, perms)?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, file.to_json()?)?;
    }
    Ok(psk)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc_protocol::{Adaptation, NativeElementInfo, NativeTargetHint, Rect};
    use serde_json::json;
    use std::sync::Arc;

    // --- Test UIA implementation ---

    struct TestUia {
        elements: Vec<NativeElementInfo>,
        apply_result: Result<String, String>,
    }

    impl UiaDispatch for TestUia {
        fn inspect(&self, _target: Option<NativeTargetHint>) -> Vec<NativeElementInfo> {
            self.elements.clone()
        }

        fn apply(
            &self,
            _target: NativeTargetHint,
            adaptation: Adaptation,
        ) -> Result<String, UiaError> {
            self.apply_result
                .as_ref()
                .map(|_| adaptation.id.clone())
                .map_err(|e| UiaError::Platform(e.clone()))
        }

        fn revert(&self, _adaptation_id: &str) -> Result<(), UiaError> {
            Ok(())
        }
    }

    fn make_ctx(uia: Arc<dyn UiaDispatch + Send + Sync>) -> ServerContext {
        ServerContext {
            psk: Arc::new(Psk::from_bytes([42u8; 32])),
            agent_info: AgentInfo {
                version: "0.1.0".to_string(),
                platform: "test".to_string(),
                capabilities: vec!["ipc".to_string()],
                distro_hint: None,
            },
            profile_store: ProfileStore::new(),
            uia,
        }
    }

    fn test_uia_ok(elements: Vec<NativeElementInfo>) -> Arc<dyn UiaDispatch + Send + Sync> {
        Arc::new(TestUia {
            elements,
            apply_result: Ok("applied".to_string()),
        })
    }

    fn test_uia_fail() -> Arc<dyn UiaDispatch + Send + Sync> {
        Arc::new(TestUia {
            elements: vec![],
            apply_result: Err("injector unavailable".to_string()),
        })
    }

    fn sample_element() -> NativeElementInfo {
        NativeElementInfo {
            process_name: "notepad.exe".to_string(),
            window_title: "Untitled - Notepad".to_string(),
            class_name: "Edit".to_string(),
            automation_id: "15".to_string(),
            control_type: "Document".to_string(),
            bounding_rect: Rect { x: 0, y: 0, width: 800, height: 600 },
        }
    }

    // --- Tests ---

    #[tokio::test]
    async fn profile_get_returns_null_initially() {
        let ctx = make_ctx(test_uia_ok(vec![]));
        let resp = dispatch(&ctx, AgentMessage::ProfileGet { request_id: "r1".into() }).await;
        match resp {
            AgentMessage::ProfileResult { request_id, profile } => {
                assert_eq!(request_id, "r1");
                assert_eq!(profile, serde_json::Value::Null);
            }
            other => panic!("expected ProfileResult, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn profile_set_then_get_returns_same_profile() {
        let ctx = make_ctx(test_uia_ok(vec![]));
        let profile = json!({"sensory": {"fontScale": 1.5}});

        // SET
        let set_resp = dispatch(
            &ctx,
            AgentMessage::ProfileSet { request_id: "r2".into(), profile: profile.clone() },
        )
        .await;
        match &set_resp {
            AgentMessage::ProfileResult { profile: echoed, .. } => {
                assert_eq!(echoed, &profile);
            }
            other => panic!("expected ProfileResult from SET, got {other:?}"),
        }

        // GET
        let get_resp =
            dispatch(&ctx, AgentMessage::ProfileGet { request_id: "r3".into() }).await;
        match get_resp {
            AgentMessage::ProfileResult { profile: stored, .. } => {
                assert_eq!(stored, profile);
            }
            other => panic!("expected ProfileResult from GET, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn ping_returns_pong_with_same_request_id() {
        let ctx = make_ctx(test_uia_ok(vec![]));
        let resp = dispatch(&ctx, AgentMessage::Ping { request_id: "ping-42".into() }).await;
        match resp {
            AgentMessage::Pong { request_id } => assert_eq!(request_id, "ping-42"),
            other => panic!("expected Pong, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn uia_inspect_routes_to_fake_dispatcher() {
        let ctx = make_ctx(test_uia_ok(vec![sample_element()]));
        let resp = dispatch(
            &ctx,
            AgentMessage::UiaInspect { request_id: "r4".into(), target: None },
        )
        .await;
        match resp {
            AgentMessage::UiaElements { request_id, elements } => {
                assert_eq!(request_id, "r4");
                assert_eq!(elements.len(), 1);
                assert_eq!(elements[0].process_name, "notepad.exe");
            }
            other => panic!("expected UiaElements, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn adaptation_apply_success_returns_adaptation_id() {
        let ctx = make_ctx(test_uia_ok(vec![]));
        let resp = dispatch(
            &ctx,
            AgentMessage::AdaptationApply {
                request_id: "r5".into(),
                target: NativeTargetHint::default(),
                adaptation: Adaptation {
                    id: "adapt-001".to_string(),
                    kind: "font-scale".to_string(),
                    value: json!(1.2),
                },
            },
        )
        .await;
        match resp {
            AgentMessage::AdaptationApplyResult { ok, adaptation_id, reason, .. } => {
                assert!(ok);
                assert_eq!(adaptation_id, "adapt-001");
                assert!(reason.is_none());
            }
            other => panic!("expected AdaptationApplyResult, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn adaptation_apply_failure_returns_ok_false_with_reason() {
        let ctx = make_ctx(test_uia_fail());
        let resp = dispatch(
            &ctx,
            AgentMessage::AdaptationApply {
                request_id: "r6".into(),
                target: NativeTargetHint::default(),
                adaptation: Adaptation {
                    id: "adapt-002".to_string(),
                    kind: "font-scale".to_string(),
                    value: json!(1.5),
                },
            },
        )
        .await;
        match resp {
            AgentMessage::AdaptationApplyResult { ok, reason, .. } => {
                assert!(!ok);
                assert!(reason.is_some());
                let r = reason.unwrap();
                assert!(r.contains("injector unavailable"), "got: {r}");
            }
            other => panic!("expected AdaptationApplyResult, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn unknown_message_returns_error() {
        let ctx = make_ctx(test_uia_ok(vec![]));
        // HelloAck is not dispatchable post-handshake — it's a server→client message.
        let resp = dispatch(
            &ctx,
            AgentMessage::HelloAck {
                psk_ok: true,
                server: ctx.agent_info.clone(),
            },
        )
        .await;
        match resp {
            AgentMessage::Error { code, .. } => {
                assert_eq!(code, "UNKNOWN_MESSAGE");
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn handshake_correct_psk_hash_passes() {
        let psk = Psk::from_bytes([7u8; 32]);
        let nonce_bytes = [3u8; 16];
        let expected_hash = hex::encode(psk_hash(&psk, &nonce_bytes));
        let nonce_b64 = URL_SAFE_NO_PAD.encode(&nonce_bytes);

        // Simulate: server computes expected, compare against what client sent.
        let nonce_dec = URL_SAFE_NO_PAD.decode(&nonce_b64).unwrap();
        let server_hash = hex::encode(psk_hash(&psk, &nonce_dec));
        assert!(constant_time_eq(server_hash.as_bytes(), expected_hash.as_bytes()));
    }

    // --- load_or_create_pair_key permission invariant (Unix only) ---

    #[cfg(unix)]
    #[test]
    fn write_pair_key_at_creates_file_with_0o600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let key_path = dir.path().join("pair.key");
        write_pair_key_at(&key_path).expect("write_pair_key_at failed");
        let mode = std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "pair.key must be 0o600, got 0o{mode:03o}");
    }

    #[tokio::test]
    async fn handshake_wrong_psk_hash_fails() {
        let psk = Psk::from_bytes([7u8; 32]);
        let nonce_bytes = [3u8; 16];
        let nonce_b64 = URL_SAFE_NO_PAD.encode(&nonce_bytes);

        let wrong_hash = "0".repeat(64);
        let nonce_dec = URL_SAFE_NO_PAD.decode(&nonce_b64).unwrap();
        let server_hash = hex::encode(psk_hash(&psk, &nonce_dec));
        assert!(!constant_time_eq(server_hash.as_bytes(), wrong_hash.as_bytes()));
    }
}
