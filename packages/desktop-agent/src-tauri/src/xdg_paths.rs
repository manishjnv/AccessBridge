//! XDG Base Directory Specification path resolution (Linux) with
//! platform-appropriate fallbacks for Windows and macOS.
//!
//! ## Platform behaviour summary
//!
//! | Platform | Config / Data / State | Cache | Runtime |
//! |----------|----------------------|-------|---------|
//! | Windows  | `%LOCALAPPDATA%\AccessBridge\` | same | same |
//! | macOS    | `~/Library/Application Support/AccessBridge/` | `~/Library/Caches/AccessBridge/` | same as Data |
//! | Linux    | `$XDG_*_HOME/accessbridge/` (fallbacks per XDG spec) | `$XDG_CACHE_HOME/accessbridge/` | `$XDG_RUNTIME_DIR/accessbridge/` |
//!
//! The module ensures the resolved directory exists and, on Unix, is mode 0o700.

use std::path::PathBuf;

/// The kind of application path being resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XdgKind {
    /// `$XDG_CONFIG_HOME` or `~/.config` on Linux.
    Config,
    /// `$XDG_DATA_HOME` or `~/.local/share` on Linux — `profile.db` lives here.
    Data,
    /// `$XDG_CACHE_HOME` or `~/.cache` on Linux.
    Cache,
    /// `$XDG_STATE_HOME` or `~/.local/state` on Linux — logs here.
    State,
    /// `$XDG_RUNTIME_DIR` on Linux — ephemeral, cleared on logout, used for PSK.
    ///
    /// On Windows / macOS falls back to the `Data` path since those platforms
    /// have no equivalent ephemeral per-user runtime directory.
    Runtime,
}

/// Resolve the application directory for the given [`XdgKind`].
///
/// The returned path is the directory (not a file inside it). It is created
/// if absent. On Unix the directory's permissions are set to 0o700.
///
/// Returns the current directory (`.`) as a last-resort fallback only when
/// both the platform env vars and `dirs::home_dir()` are unavailable.
pub fn resolve_app_path(kind: XdgKind) -> PathBuf {
    let dir = platform_dir(kind);

    // Create the directory, ignoring "already exists" errors.
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!("xdg_paths: failed to create directory {}: {}", dir.display(), e);
    }

    // On Unix, enforce 0o700 on the application directory.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(&dir) {
            Ok(meta) => {
                // Warn if the path is a symlink — tolerate it per XDG convention but log.
                // Note: `meta` was obtained via `std::fs::metadata` which follows symlinks,
                // so `meta.file_type().is_symlink()` is always false.  The only meaningful
                // check is `symlink_metadata()`, which does NOT follow symlinks.
                if dir.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
                    if let Ok(target) = std::fs::read_link(&dir) {
                        tracing::warn!(
                            "xdg_paths: app directory {} is a symlink pointing to {}; \
                             continuing per XDG convention",
                            dir.display(),
                            target.display()
                        );
                    }
                }
                let mut perms = meta.permissions();
                perms.set_mode(0o700);
                if let Err(e) = std::fs::set_permissions(&dir, perms) {
                    tracing::warn!(
                        "xdg_paths: failed to set 0o700 on {}: {}",
                        dir.display(),
                        e
                    );
                }
            }
            Err(e) => {
                tracing::warn!("xdg_paths: metadata() failed for {}: {}", dir.display(), e);
            }
        }
    }

    dir
}

/// Convenience: the full path to the profile database file.
pub fn profile_db_path() -> PathBuf {
    let mut p = resolve_app_path(XdgKind::Data);
    p.push("profile.db");
    p
}

/// Convenience: the full path to the PSK pair-key file.
///
/// On Linux this resolves to `$XDG_RUNTIME_DIR/accessbridge/pair.key` when
/// `$XDG_RUNTIME_DIR` is set (ephemeral — cleared on logout). When
/// `$XDG_RUNTIME_DIR` is unset, it falls back to `~/.cache/accessbridge/pair.key`
/// with a `tracing::warn` explaining the security implication (the key will
/// persist across reboots in a cache directory instead of an ephemeral one).
pub fn psk_path() -> PathBuf {
    let mut p = resolve_app_path(XdgKind::Runtime);
    p.push("pair.key");
    p
}

// ---------------------------------------------------------------------------
// Internal: platform-specific directory resolution (no I/O, pure path math)
// ---------------------------------------------------------------------------

fn platform_dir(kind: XdgKind) -> PathBuf {
    #[cfg(windows)]
    {
        // Windows: all kinds live under %LOCALAPPDATA%\AccessBridge\
        // `kind` is unused on Windows because all kinds map to the same base.
        let _ = kind;
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| dirs::data_local_dir())
            .unwrap_or_else(|| PathBuf::from("."));
        let mut p = base;
        p.push("AccessBridge");
        return p;
    }

    #[cfg(target_os = "macos")]
    {
        // macOS: use Apple platform conventions.
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let p = match kind {
            XdgKind::Cache => {
                let mut h = home;
                h.push("Library/Caches/AccessBridge");
                h
            }
            // Config, Data, State, Runtime all go to Application Support on macOS.
            _ => {
                let mut h = home;
                h.push("Library/Application Support/AccessBridge");
                h
            }
        };
        return p;
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        // Linux / other Unix: full XDG spec.
        linux_dir(kind)
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn linux_dir(kind: XdgKind) -> PathBuf {
    match kind {
        XdgKind::Config => {
            xdg_or_home("XDG_CONFIG_HOME", ".config")
        }
        XdgKind::Data => {
            xdg_or_home("XDG_DATA_HOME", ".local/share")
        }
        XdgKind::Cache => {
            xdg_or_home("XDG_CACHE_HOME", ".cache")
        }
        XdgKind::State => {
            xdg_or_home("XDG_STATE_HOME", ".local/state")
        }
        XdgKind::Runtime => {
            if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
                let mut p = PathBuf::from(runtime);
                p.push("accessbridge");
                p
            } else {
                // XDG_RUNTIME_DIR unset — fall back to cache. The PSK will
                // persist across reboots rather than being ephemeral. This is
                // less secure than a tmpfs-backed runtime dir.
                tracing::warn!(
                    "xdg_paths: $XDG_RUNTIME_DIR is not set; falling back to \
                     ~/.cache/accessbridge for PSK storage. This is less secure \
                     because the PSK will persist across reboots instead of being \
                     cleared at logout. Set $XDG_RUNTIME_DIR (usually done by the \
                     login manager, e.g. systemd-logind) to restore ephemeral behaviour."
                );
                xdg_or_home("XDG_CACHE_HOME", ".cache")
            }
        }
    }
}

/// Build an XDG path: `$<env_var>/accessbridge` or `$HOME/<home_suffix>/accessbridge`.
#[cfg(all(not(windows), not(target_os = "macos")))]
fn xdg_or_home(env_var: &str, home_suffix: &str) -> PathBuf {
    if let Some(val) = std::env::var_os(env_var) {
        let mut p = PathBuf::from(val);
        p.push("accessbridge");
        return p;
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let mut p = home;
    p.push(home_suffix);
    p.push("accessbridge");
    p
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serialise env-mutating tests so they don't race each other.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    // Helper: return a fresh temp dir path (doesn't create it).
    fn tmp_path(suffix: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "ab_xdg_test_{}_{}_{}",
                suffix,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ))
    }

    // -----------------------------------------------------------------------
    // 1. profile_db_path() ends with "profile.db"
    // -----------------------------------------------------------------------
    #[test]
    fn profile_db_path_ends_with_profile_db() {
        let p = profile_db_path();
        assert_eq!(p.file_name().and_then(|n| n.to_str()), Some("profile.db"));
    }

    // -----------------------------------------------------------------------
    // 2. psk_path() ends with "pair.key"
    // -----------------------------------------------------------------------
    #[test]
    fn psk_path_ends_with_pair_key() {
        let p = psk_path();
        assert_eq!(p.file_name().and_then(|n| n.to_str()), Some("pair.key"));
    }

    // -----------------------------------------------------------------------
    // 3. Directory is created on first resolve_app_path call
    // -----------------------------------------------------------------------
    #[cfg(all(not(windows), not(target_os = "macos")))]
    #[test]
    fn directory_created_on_first_resolve() {
        let _guard = ENV_LOCK.lock().unwrap();
        let base = tmp_path("dir_create");
        std::env::set_var("XDG_DATA_HOME", &base);
        let dir = resolve_app_path(XdgKind::Data);
        let exists = dir.exists();
        std::env::remove_var("XDG_DATA_HOME");
        assert!(exists, "resolve_app_path must create the directory");
    }

    // -----------------------------------------------------------------------
    // 4. Subsequent resolve calls don't error if dir already exists
    // -----------------------------------------------------------------------
    #[cfg(all(not(windows), not(target_os = "macos")))]
    #[test]
    fn subsequent_resolve_is_idempotent() {
        let _guard = ENV_LOCK.lock().unwrap();
        let base = tmp_path("idempotent");
        std::env::set_var("XDG_DATA_HOME", &base);
        let _ = resolve_app_path(XdgKind::Data);
        // Second call must not panic / error.
        let dir = resolve_app_path(XdgKind::Data);
        let exists = dir.exists();
        std::env::remove_var("XDG_DATA_HOME");
        assert!(exists);
    }

    // -----------------------------------------------------------------------
    // 5. Linux: XDG_CONFIG_HOME used when set
    // -----------------------------------------------------------------------
    #[cfg(all(not(windows), not(target_os = "macos")))]
    #[test]
    fn linux_config_home_env_is_respected() {
        let _guard = ENV_LOCK.lock().unwrap();
        let base = tmp_path("cfg_home");
        std::env::set_var("XDG_CONFIG_HOME", &base);
        let dir = resolve_app_path(XdgKind::Config);
        std::env::remove_var("XDG_CONFIG_HOME");
        assert!(
            dir.starts_with(&base),
            "expected dir under {}, got {}",
            base.display(),
            dir.display()
        );
    }

    // -----------------------------------------------------------------------
    // 6. Linux: falls back to ~/.config/accessbridge when XDG_CONFIG_HOME unset
    // -----------------------------------------------------------------------
    #[cfg(all(not(windows), not(target_os = "macos")))]
    #[test]
    fn linux_config_fallback_when_xdg_unset() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("XDG_CONFIG_HOME");
        let dir = resolve_app_path(XdgKind::Config);
        // Must end with .config/accessbridge (relative to home).
        let s = dir.to_string_lossy();
        assert!(
            s.ends_with(".config/accessbridge"),
            "expected path ending in .config/accessbridge, got {}",
            s
        );
    }

    // -----------------------------------------------------------------------
    // 7. Linux: all five XdgKind values resolve to distinct paths
    // -----------------------------------------------------------------------
    #[cfg(all(not(windows), not(target_os = "macos")))]
    #[test]
    fn linux_all_kinds_distinct() {
        let _guard = ENV_LOCK.lock().unwrap();
        // Provide a runtime dir so Runtime doesn't fall through to Cache.
        let rt = tmp_path("rt_distinct");
        std::env::set_var("XDG_RUNTIME_DIR", &rt);
        // Unset the others so they use home fallbacks (which differ from rt).
        std::env::remove_var("XDG_CONFIG_HOME");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("XDG_CACHE_HOME");
        std::env::remove_var("XDG_STATE_HOME");

        let paths: Vec<PathBuf> = vec![
            resolve_app_path(XdgKind::Config),
            resolve_app_path(XdgKind::Data),
            resolve_app_path(XdgKind::Cache),
            resolve_app_path(XdgKind::State),
            resolve_app_path(XdgKind::Runtime),
        ];
        std::env::remove_var("XDG_RUNTIME_DIR");

        let unique: std::collections::HashSet<_> = paths.iter().collect();
        assert_eq!(
            unique.len(),
            paths.len(),
            "all five XdgKind paths must be distinct: {:?}",
            paths
        );
    }

    // -----------------------------------------------------------------------
    // 8. Linux: XDG_DATA_HOME used for Data kind
    // -----------------------------------------------------------------------
    #[cfg(all(not(windows), not(target_os = "macos")))]
    #[test]
    fn linux_data_home_env_is_respected() {
        let _guard = ENV_LOCK.lock().unwrap();
        let base = tmp_path("data_home");
        std::env::set_var("XDG_DATA_HOME", &base);
        let dir = resolve_app_path(XdgKind::Data);
        std::env::remove_var("XDG_DATA_HOME");
        assert!(
            dir.starts_with(&base),
            "expected dir under {}, got {}",
            base.display(),
            dir.display()
        );
    }

    // -----------------------------------------------------------------------
    // 9. Linux: XDG_RUNTIME_DIR unset → falls back to ~/.cache/accessbridge
    // -----------------------------------------------------------------------
    #[cfg(all(not(windows), not(target_os = "macos")))]
    #[test]
    fn linux_runtime_falls_back_to_cache_when_unset() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("XDG_RUNTIME_DIR");
        std::env::remove_var("XDG_CACHE_HOME");
        let dir = resolve_app_path(XdgKind::Runtime);
        let s = dir.to_string_lossy();
        assert!(
            s.ends_with(".cache/accessbridge"),
            "runtime fallback must be ~/.cache/accessbridge, got {}",
            s
        );
    }

    // -----------------------------------------------------------------------
    // 10. Linux: XDG_RUNTIME_DIR set → used for Runtime kind
    // -----------------------------------------------------------------------
    #[cfg(all(not(windows), not(target_os = "macos")))]
    #[test]
    fn linux_runtime_dir_env_is_respected() {
        let _guard = ENV_LOCK.lock().unwrap();
        let rt = tmp_path("xdg_rt");
        std::env::set_var("XDG_RUNTIME_DIR", &rt);
        let dir = resolve_app_path(XdgKind::Runtime);
        std::env::remove_var("XDG_RUNTIME_DIR");
        assert!(
            dir.starts_with(&rt),
            "expected dir under {}, got {}",
            rt.display(),
            dir.display()
        );
    }

    // -----------------------------------------------------------------------
    // 11. Windows: all kinds resolve under %LOCALAPPDATA%\AccessBridge\
    // -----------------------------------------------------------------------
    #[cfg(windows)]
    #[test]
    fn windows_all_kinds_under_localappdata() {
        let _guard = ENV_LOCK.lock().unwrap();
        let base = tmp_path("win_localappdata");
        std::env::set_var("LOCALAPPDATA", &base);

        for kind in [
            XdgKind::Config,
            XdgKind::Data,
            XdgKind::Cache,
            XdgKind::State,
            XdgKind::Runtime,
        ] {
            let dir = resolve_app_path(kind);
            assert!(
                dir.starts_with(base.join("AccessBridge")),
                "kind {:?}: expected under {}\\AccessBridge, got {}",
                kind,
                base.display(),
                dir.display()
            );
        }
        std::env::remove_var("LOCALAPPDATA");
    }

    // -----------------------------------------------------------------------
    // 12. macOS: Config/Data/State resolve under Application Support; Cache under Caches
    // -----------------------------------------------------------------------
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_data_under_application_support() {
        let p = resolve_app_path(XdgKind::Data);
        let s = p.to_string_lossy();
        assert!(
            s.contains("Library/Application Support/AccessBridge"),
            "macOS Data must be under Application Support, got {}",
            s
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_cache_under_caches() {
        let p = resolve_app_path(XdgKind::Cache);
        let s = p.to_string_lossy();
        assert!(
            s.contains("Library/Caches/AccessBridge"),
            "macOS Cache must be under Library/Caches, got {}",
            s
        );
    }
}
