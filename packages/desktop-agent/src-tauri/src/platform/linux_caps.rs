//! Linux capability probing — desktop-environment detection and gsettings/kdeglobals checks.
//!
//! All functions are pure or use only subprocess / filesystem queries so they are
//! fully testable without a real D-Bus session.  The `detect_desktop_environment`
//! function parses `$XDG_CURRENT_DESKTOP` which may be colon-separated (e.g.
//! `ubuntu:GNOME`) and returns the first recognised token.

use std::path::PathBuf;
use std::process::Command;

use crate::platform::Capability;

// ---------------------------------------------------------------------------
// DesktopEnvironment enum
// ---------------------------------------------------------------------------

/// Known desktop environments.  `Unknown` carries the raw string for diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopEnvironment {
    Gnome,
    Kde,
    Xfce,
    Cinnamon,
    Mate,
    Budgie,
    Unknown(String),
}

impl std::fmt::Display for DesktopEnvironment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DesktopEnvironment::Gnome => write!(f, "GNOME"),
            DesktopEnvironment::Kde => write!(f, "KDE"),
            DesktopEnvironment::Xfce => write!(f, "XFCE"),
            DesktopEnvironment::Cinnamon => write!(f, "Cinnamon"),
            DesktopEnvironment::Mate => write!(f, "MATE"),
            DesktopEnvironment::Budgie => write!(f, "Budgie"),
            DesktopEnvironment::Unknown(s) => write!(f, "{s}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Parse `$XDG_CURRENT_DESKTOP` into a known `DesktopEnvironment`.
///
/// The env var may be colon-separated (e.g. `ubuntu:GNOME`); we check each
/// token in order and return the first match.  Matching is case-insensitive.
/// Returns `DesktopEnvironment::Unknown(raw)` for unrecognised values and
/// `DesktopEnvironment::Unknown(String::new())` if the variable is unset.
pub fn detect_desktop_environment() -> DesktopEnvironment {
    detect_from_env_value(std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().as_str())
}

/// Inner helper so tests can inject arbitrary env values without actually
/// setting environment variables (which are process-global and not thread-safe
/// under parallel test execution).
pub(crate) fn detect_from_env_value(raw: &str) -> DesktopEnvironment {
    if raw.is_empty() {
        return DesktopEnvironment::Unknown(String::new());
    }
    for token in raw.split(':') {
        match token.trim().to_ascii_uppercase().as_str() {
            "GNOME" | "UBUNTU" => return DesktopEnvironment::Gnome,
            "KDE" | "PLASMA" | "KDE5" | "KDE6" => return DesktopEnvironment::Kde,
            "XFCE" => return DesktopEnvironment::Xfce,
            "X-CINNAMON" | "CINNAMON" => return DesktopEnvironment::Cinnamon,
            "MATE" => return DesktopEnvironment::Mate,
            "BUDGIE:GNOME" | "BUDGIE" => return DesktopEnvironment::Budgie,
            _ => {}
        }
    }
    DesktopEnvironment::Unknown(raw.to_string())
}

/// Returns `true` if the DE is GNOME, Cinnamon, MATE, or Budgie — i.e. the
/// GTK family that uses `gsettings org.gnome.desktop.interface` for
/// accessibility settings.
pub fn is_gnome_family() -> bool {
    matches!(
        detect_desktop_environment(),
        DesktopEnvironment::Gnome
            | DesktopEnvironment::Cinnamon
            | DesktopEnvironment::Mate
            | DesktopEnvironment::Budgie
    )
}

/// Returns `true` if the DE is KDE Plasma.
pub fn is_kde() -> bool {
    matches!(detect_desktop_environment(), DesktopEnvironment::Kde)
}

/// Returns `true` if `gsettings` is available in PATH and operational.
///
/// This executes `gsettings --version` as a subprocess; result is not cached
/// because the adapter should reflect the live system state.
pub fn has_gsettings() -> bool {
    Command::new("gsettings")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Returns `true` if `~/.config/kdeglobals` exists on the filesystem.
///
/// Uses `dirs::config_dir()` as the base rather than `$HOME` to correctly
/// handle `$XDG_CONFIG_HOME` overrides.
pub fn has_kdeglobals() -> bool {
    kdeglobals_path().map(|p| p.exists()).unwrap_or(false)
}

/// Resolved path to `~/.config/kdeglobals` (or `$XDG_CONFIG_HOME/kdeglobals`).
/// Returns `None` if the config directory cannot be determined.
pub(crate) fn kdeglobals_path() -> Option<PathBuf> {
    // Use dirs crate if available; fall back to $HOME/.config.
    let config_dir = dirs::config_dir().or_else(|| {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))
    })?;
    Some(config_dir.join("kdeglobals"))
}

/// Probe the system and return the set of capabilities this adapter can
/// advertise on the current session.
///
/// Always includes `Ipc` and `UiaInspect`.
/// Adds `FontScale` if GNOME-family + gsettings OR KDE + kdeglobals.
/// Adds `CursorSize` if GNOME-family + gsettings.
pub fn probe_capabilities() -> Vec<Capability> {
    let mut caps = vec![Capability::Ipc, Capability::UiaInspect];
    let gnome_ok = is_gnome_family() && has_gsettings();
    let kde_ok = is_kde() && has_kdeglobals();
    if gnome_ok || kde_ok {
        caps.push(Capability::FontScale);
    }
    if gnome_ok {
        caps.push(Capability::CursorSize);
    }
    caps
}

// ---------------------------------------------------------------------------
// Testable variant of probe_capabilities (injectable DE + feature flags)
// ---------------------------------------------------------------------------

/// Test-friendly version: accepts pre-resolved DE + feature flags instead of
/// probing the live system.  Used by unit tests to avoid real subprocess calls.
#[cfg(test)]
pub(crate) fn probe_capabilities_with(
    de: &DesktopEnvironment,
    gsettings: bool,
    kdeglobals: bool,
) -> Vec<Capability> {
    let mut caps = vec![Capability::Ipc, Capability::UiaInspect];
    let gnome_ok = matches!(
        de,
        DesktopEnvironment::Gnome
            | DesktopEnvironment::Cinnamon
            | DesktopEnvironment::Mate
            | DesktopEnvironment::Budgie
    ) && gsettings;
    let kde_ok = matches!(de, DesktopEnvironment::Kde) && kdeglobals;
    if gnome_ok || kde_ok {
        caps.push(Capability::FontScale);
    }
    if gnome_ok {
        caps.push(Capability::CursorSize);
    }
    caps
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- detect_desktop_environment ---

    #[test]
    fn detects_plain_gnome() {
        assert_eq!(detect_from_env_value("GNOME"), DesktopEnvironment::Gnome);
    }

    #[test]
    fn detects_ubuntu_gnome_colon_separated() {
        // $XDG_CURRENT_DESKTOP="ubuntu:GNOME" on Ubuntu
        assert_eq!(detect_from_env_value("ubuntu:GNOME"), DesktopEnvironment::Gnome);
    }

    #[test]
    fn detects_kde() {
        assert_eq!(detect_from_env_value("KDE"), DesktopEnvironment::Kde);
    }

    #[test]
    fn detects_x_cinnamon() {
        // Linux Mint sets $XDG_CURRENT_DESKTOP="X-Cinnamon"
        assert_eq!(detect_from_env_value("X-Cinnamon"), DesktopEnvironment::Cinnamon);
    }

    #[test]
    fn detects_mate() {
        assert_eq!(detect_from_env_value("MATE"), DesktopEnvironment::Mate);
    }

    #[test]
    fn empty_env_is_unknown_empty() {
        assert_eq!(detect_from_env_value(""), DesktopEnvironment::Unknown(String::new()));
    }

    #[test]
    fn unknown_value_is_preserved() {
        assert_eq!(
            detect_from_env_value("LXQT"),
            DesktopEnvironment::Unknown("LXQT".to_string())
        );
    }

    // --- probe_capabilities (injectable) ---

    #[test]
    fn probe_always_includes_ipc() {
        let caps = probe_capabilities_with(
            &DesktopEnvironment::Unknown(String::new()),
            false,
            false,
        );
        assert!(caps.contains(&Capability::Ipc), "Ipc must always be present");
    }

    #[test]
    fn probe_gnome_with_gsettings_includes_font_scale_and_cursor_size() {
        let caps = probe_capabilities_with(&DesktopEnvironment::Gnome, true, false);
        assert!(caps.contains(&Capability::FontScale));
        assert!(caps.contains(&Capability::CursorSize));
    }

    #[test]
    fn probe_kde_with_kdeglobals_includes_font_scale_not_cursor_size() {
        let caps = probe_capabilities_with(&DesktopEnvironment::Kde, false, true);
        assert!(caps.contains(&Capability::FontScale));
        assert!(!caps.contains(&Capability::CursorSize));
    }

    #[test]
    fn probe_gnome_without_gsettings_skips_font_and_cursor() {
        let caps = probe_capabilities_with(&DesktopEnvironment::Gnome, false, false);
        assert!(!caps.contains(&Capability::FontScale));
        assert!(!caps.contains(&Capability::CursorSize));
    }

    #[test]
    fn probe_cinnamon_with_gsettings_includes_font_scale() {
        let caps = probe_capabilities_with(&DesktopEnvironment::Cinnamon, true, false);
        assert!(caps.contains(&Capability::FontScale));
        assert!(caps.contains(&Capability::CursorSize));
    }

    #[test]
    fn de_display_names_are_stable() {
        assert_eq!(DesktopEnvironment::Gnome.to_string(), "GNOME");
        assert_eq!(DesktopEnvironment::Kde.to_string(), "KDE");
        assert_eq!(DesktopEnvironment::Cinnamon.to_string(), "Cinnamon");
        assert_eq!(DesktopEnvironment::Mate.to_string(), "MATE");
        assert_eq!(DesktopEnvironment::Budgie.to_string(), "Budgie");
        assert_eq!(DesktopEnvironment::Xfce.to_string(), "XFCE");
        assert_eq!(DesktopEnvironment::Unknown("LXQT".into()).to_string(), "LXQT");
    }
}
