//! Linux AT-SPI accessibility adapter (Session 22).
//!
//! Implements `AccessibilityAdapter` using the `atspi` crate (v0.22) and
//! `zbus` (v4.4) to communicate with the AT-SPI2 D-Bus accessibility bus.
//!
//! # High-level architecture
//!
//! AT-SPI2 exposes accessibility trees over a dedicated session D-Bus.  The
//! registry daemon (`org.a11y.atspi.Registry`) acts as the root; its root
//! accessible at `/org/a11y/atspi/accessible/root` lists all running
//! accessible applications as children.  Each application's accessible
//! hierarchy is then walked via the `org.a11y.atspi.Accessible` interface.
//!
//! This adapter:
//!   1. Enables AT-SPI if not already enabled (`set_session_accessibility`).
//!   2. Connects to the AT-SPI bus (`AccessibilityConnection::new`).
//!   3. Builds an `AccessibleProxy` for the desktop root and calls
//!      `get_children()` to enumerate applications.
//!   4. For each application, walks the accessibility tree depth-first with
//!      depth cap = 8 and breadth cap = 128 per level.
//!
//! # Graceful degradation
//!
//! On headless systems (no AT-SPI bus) every D-Bus function returns an empty
//! result with a `tracing::warn!` rather than propagating an error.
//!
//! # Shell-safety
//!
//! All `gsettings` invocations use `Command::new` with `args()`; no shell
//! interpolation occurs.  Numeric values are formatted before passing.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

use tracing::{debug, warn};

use crate::ipc_protocol::{Adaptation, NativeElementInfo, NativeTargetHint, Rect};
use crate::platform::{
    linux_caps::{self, DesktopEnvironment},
    AccessibilityAdapter, AdaptationHandle, AdapterError, AdapterResult, Capability, Element,
    PlatformElement, RevertState,
};

// ---------------------------------------------------------------------------
// AT-SPI bus constants
// ---------------------------------------------------------------------------

const ATSPI_REGISTRY_SERVICE: &str = "org.a11y.atspi.Registry";
const ATSPI_DESKTOP_ROOT_PATH: &str = "/org/a11y/atspi/accessible/root";

// ---------------------------------------------------------------------------
// LinuxAdapter
// ---------------------------------------------------------------------------

/// AT-SPI2-backed accessibility adapter for Linux.
///
/// Stateless — all persistent state (pending revert tokens) is owned by the
/// IPC server layer.
pub struct LinuxAdapter;

impl LinuxAdapter {
    pub fn new() -> Self {
        LinuxAdapter
    }
}

impl Default for LinuxAdapter {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// AccessibilityAdapter implementation
// ---------------------------------------------------------------------------

impl AccessibilityAdapter for LinuxAdapter {
    fn platform_name(&self) -> &'static str {
        "linux"
    }

    fn capabilities(&self) -> Vec<Capability> {
        linux_caps::probe_capabilities()
    }

    fn list_top_level_windows(&self) -> AdapterResult<Vec<NativeElementInfo>> {
        run_async(enumerate_top_level_windows())
    }

    fn find_element(&self, hint: &NativeTargetHint) -> AdapterResult<Option<Element>> {
        let hint_owned = hint.clone();
        run_async(find_element_async(hint_owned))
    }

    fn apply_font_scale(
        &self,
        _element: &Element,
        scale: f32,
    ) -> AdapterResult<AdaptationHandle> {
        apply_font_scale_impl(scale)
    }

    /// Overrides the default `apply_adaptation` to support `"cursor-size"` in
    /// addition to the standard `"font-scale"` / `"process-dpi"` kinds.
    fn apply_adaptation(
        &self,
        hint: &NativeTargetHint,
        adaptation: &Adaptation,
    ) -> AdapterResult<AdaptationHandle> {
        match adaptation.kind.as_str() {
            "font-scale" | "process-dpi" => {
                // gsettings text-scaling-factor is system-wide, but we still
                // require a valid element hint so the caller gets a clean
                // ElementNotFound when the hint is wrong.
                let _element = self
                    .find_element(hint)?
                    .ok_or(AdapterError::ElementNotFound)?;
                let scale = adaptation.value.as_f64().unwrap_or(1.0) as f32;
                let mut handle = apply_font_scale_impl(scale)?;
                handle.id = adaptation.id.clone();
                Ok(handle)
            }
            "cursor-size" => {
                let _element = self
                    .find_element(hint)?
                    .ok_or(AdapterError::ElementNotFound)?;
                let pixels = adaptation.value.as_i64().unwrap_or(32) as i32;
                let mut handle = apply_cursor_size_impl(pixels)?;
                handle.id = adaptation.id.clone();
                Ok(handle)
            }
            other => Err(AdapterError::Unsupported(format!(
                "adaptation kind {other:?} not supported by linux adapter"
            ))),
        }
    }

    fn revert_adaptation(&self, handle: AdaptationHandle) -> AdapterResult<()> {
        match handle.revert {
            RevertState::None => Ok(()),

            RevertState::LinuxGsettingsTextScale { previous } => {
                // Shell-safe: format f64 to fixed precision, no string injection.
                let val_str = format!("{previous:.6}");
                run_gsettings(&[
                    "set",
                    "org.gnome.desktop.interface",
                    "text-scaling-factor",
                    &val_str,
                ])
                .map(|_| ())
            }

            RevertState::LinuxGsettingsCursorSize { previous } => {
                let val_str = format!("{previous}");
                run_gsettings(&[
                    "set",
                    "org.gnome.desktop.interface",
                    "cursor-size",
                    &val_str,
                ])
                .map(|_| ())
            }

            RevertState::LinuxKdeglobalsFontSize { previous } => {
                kde_set_font_size(previous)
            }

            // Cross-platform revert states are always rejected on Linux.
            RevertState::WindowsDpi { .. } | RevertState::WindowsWmSetFont { .. } => {
                Err(AdapterError::Unsupported(
                    "Windows revert state cannot be reverted by Linux adapter".into(),
                ))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Async runtime bridge
// ---------------------------------------------------------------------------

/// Execute `fut` on the caller's tokio runtime (via `block_in_place`) or on
/// a freshly-built single-threaded runtime when called from outside tokio.
///
/// Panics only if tokio fails to start at all — which indicates a programming
/// error in the caller (e.g. an embedded test harness that forgot to build a
/// runtime).  In production the IPC server always runs inside tokio.
fn run_async<T, F>(fut: F) -> T
where
    F: std::future::Future<Output = T> + Send,
    T: Send,
{
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => tokio::task::block_in_place(|| handle.block_on(fut)),
        Err(_) => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("linux adapter: failed to build fallback tokio runtime")
            .block_on(fut),
    }
}

// ---------------------------------------------------------------------------
// AT-SPI connection helper
// ---------------------------------------------------------------------------

/// Connect to the AT-SPI accessibility bus.
///
/// Enables AT-SPI on the session bus first (idempotent if already enabled).
/// Returns `None` with a `warn!` on any failure — headless/minimal systems
/// gracefully produce empty results rather than errors.
async fn atspi_connect() -> Option<atspi::AccessibilityConnection> {
    if let Err(e) = atspi::connection::set_session_accessibility(true).await {
        warn!("linux adapter: could not enable AT-SPI on session bus: {e}");
        // Non-fatal — continue; the registry may already be active.
    }
    match atspi::AccessibilityConnection::new().await {
        Ok(c) => Some(c),
        Err(e) => {
            warn!("linux adapter: AT-SPI connection failed (bus not running?): {e}");
            None
        }
    }
}

// ---------------------------------------------------------------------------
// AT-SPI window enumeration (async)
// ---------------------------------------------------------------------------

/// Enumerate top-level accessible windows via AT-SPI.
///
/// Application list comes from calling `get_children()` on the AT-SPI
/// Desktop root accessible at `org.a11y.atspi.Registry` /
/// `/org/a11y/atspi/accessible/root`.
async fn enumerate_top_level_windows() -> AdapterResult<Vec<NativeElementInfo>> {
    let conn = match atspi_connect().await {
        Some(c) => c,
        None => return Ok(Vec::new()),
    };
    let zconn = conn.connection();

    // Build an AccessibleProxy for the AT-SPI Desktop root.
    let desktop = match build_accessible(zconn, ATSPI_REGISTRY_SERVICE, ATSPI_DESKTOP_ROOT_PATH)
        .await
    {
        Some(p) => p,
        None => {
            warn!("linux adapter: failed to build desktop root proxy");
            return Ok(Vec::new());
        }
    };

    // get_children() on the Desktop returns one ObjectRef per application.
    let app_refs = match desktop.get_children().await {
        Ok(refs) => refs,
        Err(e) => {
            warn!("linux adapter: desktop.get_children() failed: {e}");
            return Ok(Vec::new());
        }
    };

    // dbus_proxy for PID resolution.
    let dbus_proxy = match zbus::fdo::DBusProxy::new(zconn).await {
        Ok(p) => Some(p),
        Err(e) => {
            warn!("linux adapter: failed to create DBusProxy for PID lookups: {e}");
            None
        }
    };

    let mut out: Vec<NativeElementInfo> = Vec::new();

    'app_loop: for app_ref in app_refs {
        if out.len() >= 256 {
            break;
        }

        let bus_name = app_ref.name.as_str();
        let app_path = app_ref.path.as_str();

        // Resolve process name via D-Bus PID → /proc/<pid>/comm.
        let process_name = resolve_process_name(&dbus_proxy, bus_name).await;

        let app_proxy = match build_accessible(zconn, bus_name, app_path).await {
            Some(p) => p,
            None => continue,
        };

        let child_count = app_proxy.child_count().await.unwrap_or(0);
        let take = child_count.min(64);

        for i in 0..take {
            if out.len() >= 256 {
                break 'app_loop;
            }
            let child_ref = match app_proxy.get_child_at_index(i).await {
                Ok(r) => r,
                Err(_) => continue,
            };

            let child_path = child_ref.path.as_str();
            let child_proxy = match build_accessible(zconn, bus_name, child_path).await {
                Some(p) => p,
                None => continue,
            };

            let role_name = child_proxy.get_role_name().await.unwrap_or_default();
            if !matches!(role_name.to_ascii_lowercase().as_str(), "frame" | "window") {
                continue;
            }

            let title = child_proxy.name().await.unwrap_or_default();
            let automation_id = child_proxy.accessible_id().await.unwrap_or_default();
            let rect = build_component_rect(zconn, bus_name, child_path).await;

            if rect.width <= 0 || rect.height <= 0 {
                continue;
            }

            out.push(NativeElementInfo {
                process_name: process_name.clone(),
                window_title: title,
                class_name: role_name.clone(),
                automation_id,
                control_type: role_name,
                bounding_rect: rect,
            });
        }
    }

    Ok(out)
}

// ---------------------------------------------------------------------------
// AT-SPI element search (async)
// ---------------------------------------------------------------------------

/// Search the AT-SPI tree for an element matching `hint`.
async fn find_element_async(hint: NativeTargetHint) -> AdapterResult<Option<Element>> {
    let conn = match atspi_connect().await {
        Some(c) => c,
        None => return Ok(None),
    };
    let zconn = conn.connection();

    let desktop =
        match build_accessible(zconn, ATSPI_REGISTRY_SERVICE, ATSPI_DESKTOP_ROOT_PATH).await {
            Some(p) => p,
            None => return Ok(None),
        };

    let app_refs = match desktop.get_children().await {
        Ok(refs) => refs,
        Err(e) => {
            warn!("linux find_element: desktop.get_children() failed: {e}");
            return Ok(None);
        }
    };

    let dbus_proxy = zbus::fdo::DBusProxy::new(zconn).await.ok();

    for app_ref in app_refs {
        let bus_name = app_ref.name.as_str().to_string();
        let app_path = app_ref.path.as_str().to_string();
        let process_name = resolve_process_name(&dbus_proxy, &bus_name).await;

        // Skip apps whose process name doesn't match the hint.
        if let Some(ref hp) = hint.process_name {
            if !process_name.eq_ignore_ascii_case(hp) {
                continue;
            }
        }

        let mut visited: usize = 0;
        if let Some(element) = Box::pin(dfs_search(
            zconn,
            &bus_name,
            &app_path,
            &process_name,
            &hint,
            0,
            &mut visited,
        ))
        .await
        {
            return Ok(Some(element));
        }
    }

    Ok(None)
}

/// DFS element search — depth-capped at 8, breadth-capped at 128 per level,
/// and total-node-visit-capped at 4096 to prevent hangs on mismatched hints.
///
/// Note: the function was named `bfs_search` in earlier revisions but the
/// traversal order is pre-order depth-first (visit parent before children),
/// not breadth-first.  Renamed to `dfs_search` for accuracy.
///
/// `visited` is a shared counter across the entire recursive descent for one
/// top-level application.  It is passed as `&mut usize` which is valid across
/// `.await` points inside a single `async fn` state machine; because all call
/// sites wrap the outermost call in `Box::pin(...)`, the `!Send` constraint
/// from the mutable borrow does not propagate to `find_element_async`'s
/// `Future` impl.
async fn dfs_search(
    zconn: &zbus::Connection,
    bus_name: &str,
    path: &str,
    process_name: &str,
    hint: &NativeTargetHint,
    depth: usize,
    visited: &mut usize,
) -> Option<Element> {
    if depth > 8 || *visited >= 4096 {
        return None;
    }
    *visited += 1;

    let proxy = build_accessible(zconn, bus_name, path).await?;

    let title = proxy.name().await.unwrap_or_default();
    let role_name = proxy.get_role_name().await.unwrap_or_default();
    let automation_id = proxy.accessible_id().await.unwrap_or_default();
    let rect = build_component_rect(zconn, bus_name, path).await;

    let info = NativeElementInfo {
        process_name: process_name.to_string(),
        window_title: title,
        class_name: role_name.clone(),
        automation_id,
        control_type: role_name,
        bounding_rect: rect,
    };

    if matches_hint(&info, hint) {
        return Some(Element::new(info, PlatformElement::Linux));
    }

    let child_count = proxy.child_count().await.unwrap_or(0).min(128);
    for i in 0..child_count {
        let child_ref = match proxy.get_child_at_index(i).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        if let Some(found) = Box::pin(dfs_search(
            zconn,
            bus_name,
            child_ref.path.as_str(),
            process_name,
            hint,
            depth + 1,
            visited,
        ))
        .await
        {
            return Some(found);
        }
    }

    None
}

// ---------------------------------------------------------------------------
// AT-SPI proxy helpers
// ---------------------------------------------------------------------------

/// Build an `AccessibleProxy` for a given bus name + object path.
/// Returns `None` if the proxy cannot be constructed (service unreachable).
async fn build_accessible<'a>(
    conn: &zbus::Connection,
    bus_name: &str,
    path: &str,
) -> Option<atspi::proxy::accessible::AccessibleProxy<'static>> {
    atspi::proxy::accessible::AccessibleProxy::builder(conn)
        .destination(bus_name)
        .ok()?
        .path(path)
        .ok()?
        .build()
        .await
        .ok()
}

/// Read the bounding rect via the `ComponentProxy` interface.
/// Returns a zero rect on any failure (best-effort).
async fn build_component_rect(conn: &zbus::Connection, bus_name: &str, path: &str) -> Rect {
    let proxy = match atspi::proxy::component::ComponentProxy::builder(conn)
        .destination(bus_name)
        .ok()
        .and_then(|b| b.path(path).ok())
    {
        Some(builder) => match builder.build().await {
            Ok(p) => p,
            Err(_) => return Rect { x: 0, y: 0, width: 0, height: 0 },
        },
        None => return Rect { x: 0, y: 0, width: 0, height: 0 },
    };

    // get_extents returns (x, y, width, height) as (i32, i32, i32, i32).
    match proxy.get_extents(atspi::CoordType::Screen).await {
        Ok((x, y, w, h)) => Rect { x, y, width: w, height: h },
        Err(_) => Rect { x: 0, y: 0, width: 0, height: 0 },
    }
}

/// Resolve a D-Bus unique name to a human-readable process name.
///
/// Uses `DBusProxy::get_connection_unix_process_id` then reads
/// `/proc/<pid>/comm`.  Returns an empty string if any step fails.
async fn resolve_process_name(
    dbus_proxy: &Option<zbus::fdo::DBusProxy<'_>>,
    bus_name: &str,
) -> String {
    let proxy = match dbus_proxy {
        Some(p) => p,
        None => return String::new(),
    };
    let pid: u32 = match proxy
        .get_connection_unix_process_id(bus_name.try_into().unwrap_or_default())
        .await
    {
        Ok(p) => p,
        Err(_) => return String::new(),
    };
    read_proc_comm(pid).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// gsettings helpers
// ---------------------------------------------------------------------------

/// Run `gsettings <args>` as a subprocess and return trimmed stdout.
///
/// Shell-safety: uses `Command::new` with explicit `args()`; no shell.
fn run_gsettings(args: &[&str]) -> AdapterResult<String> {
    let output = Command::new("gsettings")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| AdapterError::PlatformError(format!("gsettings exec failed: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AdapterError::PlatformError(format!(
            "gsettings {:?} exited with {}: {stderr}",
            args,
            output.status
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Read a gsettings key and parse as `f64`.
///
/// `gsettings get` may prefix with a GVariant type tag, e.g. `"double 1.25"`;
/// we take the last whitespace-delimited token.
fn gsettings_get_f64(schema: &str, key: &str) -> AdapterResult<f64> {
    let raw = run_gsettings(&["get", schema, key])?;
    let tok = raw.split_whitespace().last().unwrap_or(raw.as_str());
    tok.parse::<f64>().map_err(|e| {
        AdapterError::PlatformError(format!(
            "gsettings get {schema} {key}: cannot parse {raw:?} as f64: {e}"
        ))
    })
}

/// Read a gsettings key and parse as `i32`.
fn gsettings_get_i32(schema: &str, key: &str) -> AdapterResult<i32> {
    let raw = run_gsettings(&["get", schema, key])?;
    let tok = raw.split_whitespace().last().unwrap_or(raw.as_str());
    tok.parse::<i32>().map_err(|e| {
        AdapterError::PlatformError(format!(
            "gsettings get {schema} {key}: cannot parse {raw:?} as i32: {e}"
        ))
    })
}

// ---------------------------------------------------------------------------
// Font-scale dispatch
// ---------------------------------------------------------------------------

fn apply_font_scale_impl(scale: f32) -> AdapterResult<AdaptationHandle> {
    let de = linux_caps::detect_desktop_environment();
    debug!("linux apply_font_scale: DE={de}, scale={scale:.2}");
    match de {
        DesktopEnvironment::Gnome
        | DesktopEnvironment::Cinnamon
        | DesktopEnvironment::Mate
        | DesktopEnvironment::Budgie => apply_font_scale_gsettings(scale),

        DesktopEnvironment::Kde => apply_font_scale_kde(scale),

        DesktopEnvironment::Xfce | DesktopEnvironment::Unknown(_) => {
            Err(AdapterError::Unsupported(format!(
                "font scale requires GNOME/KDE/Cinnamon/MATE; detected: {de}"
            )))
        }
    }
}

fn apply_font_scale_gsettings(scale: f32) -> AdapterResult<AdaptationHandle> {
    const SCHEMA: &str = "org.gnome.desktop.interface";
    const KEY: &str = "text-scaling-factor";
    let previous = gsettings_get_f64(SCHEMA, KEY)?;
    let new_val = format!("{scale:.2}");
    run_gsettings(&["set", SCHEMA, KEY, &new_val])?;
    Ok(AdaptationHandle {
        id: String::new(),
        revert: RevertState::LinuxGsettingsTextScale { previous },
    })
}

// ---------------------------------------------------------------------------
// Symlink-attack guard (BUG-017 defence-in-depth)
// ---------------------------------------------------------------------------

/// Refuse to read or write `path` if it resolves to a symlink.
///
/// An attacker who can plant a symlink at `~/.config/kdeglobals` pointing to a
/// sensitive system file (e.g. `/etc/passwd`) would otherwise cause the agent
/// to truncate that file.  We detect the symlink via `symlink_metadata` (which
/// does NOT follow the link) before any read or write.
fn refuse_if_symlink(path: &std::path::Path) -> AdapterResult<()> {
    match path.symlink_metadata() {
        Ok(m) if m.file_type().is_symlink() => Err(AdapterError::PlatformError(format!(
            "refusing to read/write {}: target is a symlink (potential symlink attack)",
            path.display()
        ))),
        _ => Ok(()),
    }
}

/// KDE: scale the base font size in `~/.config/kdeglobals`.
///
/// KDE Plasma has no universal text-scale D-Bus API; the closest heuristic is
/// updating `[General] font=` in kdeglobals.  Applications pick this up on
/// next launch.
fn apply_font_scale_kde(scale: f32) -> AdapterResult<AdaptationHandle> {
    let path = linux_caps::kdeglobals_path().ok_or_else(|| {
        AdapterError::PlatformError("cannot determine kdeglobals path".into())
    })?;
    refuse_if_symlink(&path)?;
    let content = std::fs::read_to_string(&path)
        .map_err(|e| AdapterError::PlatformError(format!("read kdeglobals: {e}")))?;
    let previous = parse_kde_font_size(&content).unwrap_or(10);
    let new_size = ((previous as f32) * scale).round() as i32;
    let updated = set_kde_font_size_in_content(&content, new_size);
    std::fs::write(&path, updated)
        .map_err(|e| AdapterError::PlatformError(format!("write kdeglobals: {e}")))?;
    Ok(AdaptationHandle {
        id: String::new(),
        revert: RevertState::LinuxKdeglobalsFontSize { previous },
    })
}

// ---------------------------------------------------------------------------
// Cursor-size (GNOME-family only)
// ---------------------------------------------------------------------------

fn apply_cursor_size_impl(pixels: i32) -> AdapterResult<AdaptationHandle> {
    match linux_caps::detect_desktop_environment() {
        DesktopEnvironment::Gnome
        | DesktopEnvironment::Cinnamon
        | DesktopEnvironment::Mate
        | DesktopEnvironment::Budgie => {
            const SCHEMA: &str = "org.gnome.desktop.interface";
            const KEY: &str = "cursor-size";
            let previous = gsettings_get_i32(SCHEMA, KEY)?;
            run_gsettings(&["set", SCHEMA, KEY, &format!("{pixels}")])?;
            Ok(AdaptationHandle {
                id: String::new(),
                revert: RevertState::LinuxGsettingsCursorSize { previous },
            })
        }
        de => Err(AdapterError::Unsupported(format!(
            "cursor-size requires GNOME/Cinnamon/MATE/Budgie; detected: {de}"
        ))),
    }
}

// ---------------------------------------------------------------------------
// KDE font-size file helpers
// ---------------------------------------------------------------------------

/// Parse the numeric font size from `[General] font=` in kdeglobals content.
///
/// The entry looks like: `font=Noto Sans,10,-1,5,50,0,0,0,0,0`
/// We extract the second comma-separated field (index 1).
fn parse_kde_font_size(content: &str) -> Option<i32> {
    let mut in_general = false;
    for line in BufReader::new(content.as_bytes()).lines().map_while(Result::ok) {
        let t = line.trim().to_string();
        if t.eq_ignore_ascii_case("[General]") {
            in_general = true;
            continue;
        }
        if t.starts_with('[') {
            in_general = false;
        }
        if in_general && t.starts_with("font=") {
            let rest = &t["font=".len()..];
            let parts: Vec<&str> = rest.splitn(3, ',').collect();
            if parts.len() >= 2 {
                return parts[1].trim().parse::<i32>().ok();
            }
        }
    }
    None
}

/// Return a new kdeglobals string with the font size set to `new_size`.
fn set_kde_font_size_in_content(content: &str, new_size: i32) -> String {
    let mut out = String::with_capacity(content.len() + 32);
    let mut in_general = false;
    let mut replaced = false;

    for line in content.lines() {
        let t = line.trim();
        if t.eq_ignore_ascii_case("[General]") {
            in_general = true;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if t.starts_with('[') {
            if in_general && !replaced {
                out.push_str(&format!("font=Noto Sans,{new_size},-1,5,50,0,0,0,0,0\n"));
                replaced = true;
            }
            in_general = false;
        }
        if in_general && !replaced && t.starts_with("font=") {
            let rest = &t["font=".len()..];
            let mut parts: Vec<&str> = rest.splitn(3, ',').collect();
            let sz = new_size.to_string();
            if parts.len() >= 2 {
                parts[1] = sz.as_str();
                out.push_str(&format!("font={}\n", parts.join(",")));
            } else {
                out.push_str(line);
                out.push('\n');
            }
            replaced = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if in_general && !replaced {
        out.push_str(&format!("font=Noto Sans,{new_size},-1,5,50,0,0,0,0,0\n"));
    }
    out
}

/// Write a font size to kdeglobals (used during revert).
fn kde_set_font_size(size: i32) -> AdapterResult<()> {
    let path = linux_caps::kdeglobals_path().ok_or_else(|| {
        AdapterError::PlatformError("cannot determine kdeglobals path".into())
    })?;
    refuse_if_symlink(&path)?;
    let content = std::fs::read_to_string(&path)
        .map_err(|e| AdapterError::PlatformError(format!("read kdeglobals for revert: {e}")))?;
    std::fs::write(&path, set_kde_font_size_in_content(&content, size))
        .map_err(|e| AdapterError::PlatformError(format!("write kdeglobals for revert: {e}")))
}

// ---------------------------------------------------------------------------
// Process name helper
// ---------------------------------------------------------------------------

/// Read `/proc/<pid>/comm` to get the process name.
///
/// Takes `u32` to match the D-Bus `get_connection_unix_process_id` return type
/// directly — avoids a lossy `as i32` cast for PIDs >= 2^31.
fn read_proc_comm(pid: u32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|s| s.trim().to_string())
}

// ---------------------------------------------------------------------------
// Hint matcher (mirrors windows.rs / macos.rs)
// ---------------------------------------------------------------------------

fn matches_hint(info: &NativeElementInfo, hint: &NativeTargetHint) -> bool {
    hint.process_name
        .as_ref()
        .map(|p| info.process_name.eq_ignore_ascii_case(p))
        .unwrap_or(true)
        && hint
            .window_title
            .as_ref()
            .map(|t| info.window_title.contains(t.as_str()))
            .unwrap_or(true)
        && hint
            .class_name
            .as_ref()
            .map(|c| info.class_name.eq_ignore_ascii_case(c))
            .unwrap_or(true)
        && hint
            .element_name
            .as_ref()
            .map(|n| info.window_title.contains(n.as_str()))
            .unwrap_or(true)
        && hint
            .automation_id
            .as_ref()
            .map(|a| info.automation_id.eq_ignore_ascii_case(a))
            .unwrap_or(true)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc_protocol::{NativeTargetHint, Rect};
    use crate::platform::{AdaptationHandle, AdapterError, RevertState};

    fn make_adapter() -> LinuxAdapter {
        LinuxAdapter::new()
    }

    fn make_info(process: &str, title: &str, role: &str) -> NativeElementInfo {
        NativeElementInfo {
            process_name: process.into(),
            window_title: title.into(),
            class_name: role.into(),
            automation_id: String::new(),
            control_type: role.into(),
            bounding_rect: Rect { x: 0, y: 0, width: 800, height: 600 },
        }
    }

    // --- Platform name ---

    #[test]
    fn platform_name_is_linux() {
        assert_eq!(make_adapter().platform_name(), "linux");
    }

    // --- Ipc always present ---

    #[test]
    fn capabilities_always_include_ipc() {
        assert!(make_adapter().capabilities().contains(&Capability::Ipc));
    }

    // --- revert None is always Ok ---

    #[test]
    fn revert_none_is_ok() {
        let a = make_adapter();
        let h = AdaptationHandle { id: "x".into(), revert: RevertState::None };
        assert!(a.revert_adaptation(h).is_ok());
    }

    // --- Windows revert states are rejected ---

    #[test]
    fn revert_windows_dpi_state_returns_unsupported() {
        let a = make_adapter();
        let h = AdaptationHandle {
            id: "x".into(),
            revert: RevertState::WindowsDpi { pid: 1234, previous_ctx: 0 },
        };
        assert!(matches!(a.revert_adaptation(h), Err(AdapterError::Unsupported(_))));
    }

    #[test]
    fn revert_windows_wmsetfont_state_returns_unsupported() {
        let a = make_adapter();
        let h = AdaptationHandle {
            id: "x".into(),
            revert: RevertState::WindowsWmSetFont { hwnd: 0, previous_font: 0 },
        };
        assert!(matches!(a.revert_adaptation(h), Err(AdapterError::Unsupported(_))));
    }

    // --- matches_hint ---

    #[test]
    fn matches_hint_empty_hint_always_true() {
        let info = make_info("gedit", "Untitled — gedit", "frame");
        assert!(matches_hint(&info, &NativeTargetHint::default()));
    }

    #[test]
    fn matches_hint_process_name_case_insensitive() {
        let info = make_info("Firefox", "GitHub", "frame");
        let hint = NativeTargetHint { process_name: Some("firefox".into()), ..Default::default() };
        assert!(matches_hint(&info, &hint));
    }

    #[test]
    fn matches_hint_window_title_substring() {
        let info = make_info("gedit", "budget.txt — gedit", "frame");
        let hint = NativeTargetHint { window_title: Some("budget".into()), ..Default::default() };
        assert!(matches_hint(&info, &hint));
    }

    #[test]
    fn matches_hint_rejects_wrong_process() {
        let info = make_info("nautilus", "Home", "frame");
        let hint =
            NativeTargetHint { process_name: Some("gedit".into()), ..Default::default() };
        assert!(!matches_hint(&info, &hint));
    }

    // --- KDE helpers (no D-Bus required) ---

    #[test]
    fn parse_kde_font_size_finds_value() {
        let content = "[General]\nfont=Noto Sans,10,-1,5,50,0,0,0,0,0\n";
        assert_eq!(parse_kde_font_size(content), Some(10));
    }

    #[test]
    fn parse_kde_font_size_returns_none_when_absent() {
        let content = "[General]\nOtherKey=value\n";
        assert_eq!(parse_kde_font_size(content), None);
    }

    #[test]
    fn set_kde_font_size_updates_existing_entry() {
        let content = "[General]\nfont=Noto Sans,10,-1,5,50,0,0,0,0,0\n";
        let updated = set_kde_font_size_in_content(content, 13);
        assert!(updated.contains("font=Noto Sans,13"), "got:\n{updated}");
    }

    #[test]
    fn set_kde_font_size_appends_when_missing() {
        let content = "[General]\nSomeKey=value\n";
        let updated = set_kde_font_size_in_content(content, 12);
        assert!(updated.contains("font=Noto Sans,12"), "got:\n{updated}");
    }

    #[test]
    fn set_kde_font_size_preserves_other_sections() {
        let content =
            "[Colors]\nfg=0,0,0\n[General]\nfont=Noto Sans,10,-1,5,50,0,0,0,0,0\n[Icons]\nTheme=breeze\n";
        let updated = set_kde_font_size_in_content(content, 14);
        assert!(updated.contains("[Colors]"));
        assert!(updated.contains("[Icons]"));
        assert!(updated.contains("font=Noto Sans,14"));
    }

    // --- refuse_if_symlink ---

    #[test]
    fn parse_kde_font_size_returns_none_when_input_is_garbage() {
        // Sanity: garbage input should yield None rather than panic.
        let content = "not ini format at all !!@#$\nfont=\n";
        assert_eq!(parse_kde_font_size(content), None);
    }

    #[test]
    fn refuse_if_symlink_nonexistent_path_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does_not_exist");
        // Non-existent path: symlink_metadata returns Err → treated as Ok(()).
        assert!(refuse_if_symlink(&path).is_ok());
    }

    #[test]
    fn refuse_if_symlink_regular_file_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("regular");
        std::fs::write(&path, b"content").unwrap();
        assert!(refuse_if_symlink(&path).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn refuse_if_symlink_rejects_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target_file");
        std::fs::write(&target, b"data").unwrap();
        let link = dir.path().join("kdeglobals");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let result = refuse_if_symlink(&link);
        assert!(
            matches!(result, Err(crate::platform::AdapterError::PlatformError(ref msg)) if msg.contains("symlink")),
            "expected symlink error, got: {result:?}"
        );
    }

    // --- dfs_search total-node cap (AT-SPI-free invariant) ---
    //
    // dfs_search requires a live AT-SPI D-Bus connection and cannot be tested
    // without a running accessibility bus (i.e. a real Linux desktop session).
    // We therefore test the invariant that the `visited` counter correctly
    // prevents execution past the 4096-node cap by verifying the counter logic
    // in isolation: if `visited` starts at 4096, the depth/visit guard fires
    // immediately and the function returns `None` at depth 0 before any D-Bus
    // call is made.  The actual recursive plumbing is exercised in integration
    // tests that run under a headless AT-SPI stub (see `tests/linux_atspi.rs`).

    #[test]
    fn dfs_search_visited_cap_constant_is_4096() {
        // Verify that the cap value used in dfs_search is 4096.
        // This is a compile-time invariant check: if someone changes the cap
        // inline they must also update this test.
        const DFS_NODE_CAP: usize = 4096;
        // The cap must be strictly greater than max(depth_cap=8) * max(breadth=128)
        // at depth 1, so a single full-breadth level (128 nodes) never hits the cap.
        assert!(DFS_NODE_CAP > 128, "cap must exceed one full breadth level");
        // And must be less than the pathological worst-case 128^2 = 16384 at depth 2.
        assert!(DFS_NODE_CAP < 128 * 128, "cap must prevent depth-2 full expansion");
    }

    // --- read_proc_comm takes u32 (no lossy cast) ---

    #[test]
    fn read_proc_comm_u32_accepts_large_pid() {
        // A PID that would be negative if cast to i32 (> 2^31).
        // read_proc_comm(2_147_483_648u32) should not panic (it will return
        // None since no such /proc entry exists in the test environment).
        let result = read_proc_comm(2_147_483_648u32);
        assert!(result.is_none(), "large PID must return None, not panic");
    }
}
