//! Linux distro detection via `/etc/os-release`.
//!
//! Returns a hint string like `"ubuntu-24.04"` or `"fedora-40"` on Linux.
//! On Windows and macOS the function is a no-op that always returns `None`.

/// Detect the Linux distro, if running on Linux.
///
/// Reads `/etc/os-release` at call time (first invocation in `lib::run` so the
/// cost is paid once at startup). Returns `None` on non-Linux platforms.
#[cfg(target_os = "linux")]
pub fn detect_distro_hint() -> Option<String> {
    let content = match std::fs::read_to_string("/etc/os-release") {
        Ok(s) => s,
        Err(_) => return Some("linux-unknown".to_string()),
    };

    let mut id: Option<String> = None;
    let mut version_id: Option<String> = None;

    for line in content.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("ID=") {
            id = Some(strip_quotes(val).to_lowercase());
        } else if let Some(val) = line.strip_prefix("VERSION_ID=") {
            version_id = Some(strip_quotes(val).to_string());
        }
        if id.is_some() && version_id.is_some() {
            break;
        }
    }

    match (id, version_id) {
        (Some(i), Some(v)) if !i.is_empty() && !v.is_empty() => {
            Some(format!("{i}-{v}"))
        }
        (Some(i), _) if !i.is_empty() => Some(format!("{i}-unknown")),
        _ => Some("linux-unknown".to_string()),
    }
}

#[cfg(not(target_os = "linux"))]
pub fn detect_distro_hint() -> Option<String> {
    None
}

/// Strip surrounding single or double quotes from an os-release value.
#[cfg(target_os = "linux")]
fn strip_quotes(s: &str) -> &str {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"'))
        || (s.starts_with('\'') && s.ends_with('\''))
    {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn strip_double_quotes() {
        assert_eq!(strip_quotes("\"ubuntu\""), "ubuntu");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn strip_single_quotes() {
        assert_eq!(strip_quotes("'fedora'"), "fedora");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn no_quotes_unchanged() {
        assert_eq!(strip_quotes("debian"), "debian");
    }
}
