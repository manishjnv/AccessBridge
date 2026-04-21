# Security Audit — Rust (Desktop Agent)

**Methodology:** Manual adversarial review, Grep + Read. semgrep unavailable; Codex quota-exhausted.
**Scope:** `packages/desktop-agent/src-tauri/src/` + `packages/core/src/ipc/`
**Date:** 2026-04-22
**Auditor:** Sonnet (AccessBridge Session 26)
**Files read:** 20 Rust files + 3 TS IPC files

---

## CRITICAL

_No critical findings._

---

## HIGH

### FINDING-RUST-001 [HIGH]
- **File:** `packages/desktop-agent/src-tauri/src/crypto.rs:493`
- **Rule:** Pattern 5 — `fs::write` on secret material (BUG-017/019 regression class)
- **Description:** Inside `load_or_create_psk_via_keyring()`, the final fallback path that writes a freshly-generated `PairKeyFile` to disk uses the raw `std::fs::write` call: `let _ = std::fs::write(&file_path, json);`. This is the exact umask-chmod race fixed by BUG-017 (`crypto::write_key_to_file`) and BUG-019 (`ipc_server::load_or_create_pair_key`). Both of those fixes replaced `fs::write` with `OpenOptions::new().mode(0o600).open(...)`. This third write-site was introduced in the same session and was not migrated to the secure pattern.
- **Exploit scenario:** On a multi-user Linux host where `$XDG_RUNTIME_DIR` is unset (minimal distros, headless configs, some containers), the PSK falls back to `~/.cache/accessbridge/pair.key`. The `fs::write` call creates the file at `0o666 & !umask` (typically `0o644`), world-readable for a microsecond before the caller could `chmod` it — except here there is NO follow-up `set_permissions` call at all, because the error is silently discarded (`let _ = ...`). A co-resident user can `cat` the file during or after that window and obtain the PSK, allowing them to impersonate the extension to the agent over the loopback socket.
- **Remediation:** Replace the `fs::write` call with the same `#[cfg(unix)]` / `#[cfg(not(unix))]` pattern used by `write_key_to_file` and `load_or_create_pair_key`: on Unix, open with `OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&file_path)` then `write_all`. On non-Unix, the existing `fs::write` is acceptable.
- **Status:** Open
- **Prior-art:** BUG-017, BUG-019 — exact same pattern; this is the third occurrence of the same class.
- **Code location:**
  ```rust
  // crypto.rs line 489-494
  if let Some(parent) = file_path.parent() {
      let _ = std::fs::create_dir_all(parent);
  }
  if let Ok(json) = file.to_json() {
      let _ = std::fs::write(&file_path, json);  // ← BUG-017/019 regression
  }
  ```

---

## MEDIUM

### FINDING-RUST-002 [MEDIUM]
- **File:** `packages/desktop-agent/src-tauri/src/platform/linux.rs:651` and `platform/linux.rs:766`
- **Rule:** Pattern 6 — `fs::write` on `~/.config/*` path without symlink guard on the write itself (partial BUG-018 regression)
- **Description:** `apply_font_scale_kde` calls `refuse_if_symlink(&path)` before the read and then calls `std::fs::write(&path, updated)`. The symlink check is correctly placed before the read. However, on Linux a TOCTOU window exists: between `refuse_if_symlink` returning `Ok` and `std::fs::write` executing, an attacker with the same UID can `unlink(path); symlink(target, path)`. The window is extremely narrow (microseconds, same process context required) and requires the attacker already have write access to `~/.config/`. Same issue in `kde_set_font_size` at line 766.
- **Exploit scenario:** Same-UID attacker with write access to `~/.config/` could substitute a symlink during the narrow TOCTOU window to redirect the write to an arbitrary file owned by the user. Severity is low-to-medium because: (a) the attacker already has `~/.config/` write access (stronger than what the code is defending against), (b) the window is microsecond-range. Nonetheless it is worth noting as defense-in-depth is incomplete.
- **Remediation:** Open the file with `O_NOFOLLOW` (via `std::os::unix::fs::OpenOptionsExt::custom_flags(libc::O_NOFOLLOW)`) to atomically refuse symlinks at open time, eliminating the TOCTOU. Alternatively, re-check `symlink_metadata` _after_ opening (race is then much narrower). At minimum, document the known residual gap in code comments.
- **Status:** Open (defense-in-depth gap, not a primary attack vector)
- **Prior-art:** BUG-018 — `refuse_if_symlink` was the fix; this identifies its TOCTOU residual.

### FINDING-RUST-003 [MEDIUM]
- **File:** `packages/desktop-agent/src-tauri/src/ipc_server.rs:271-276`
- **Rule:** Pattern 9 — nonce decode `unwrap_or_default` silently accepts empty nonce
- **Description:** The handshake handler decodes the client nonce with `URL_SAFE_NO_PAD.decode(nonce).unwrap_or_default()`. If the client sends a non-base64 nonce string, the decode silently falls back to an empty byte slice `[]`. The PSK hash is then computed over `sha256(psk || [])` — a deterministic and predictable value. The comparison with `constant_time_eq` still happens correctly, but an attacker who can precompute `sha256(psk || [])` (which requires knowing the PSK) can send any non-base64 `nonce` field and still pass. This doesn't help an attacker _without_ the PSK, but it means the nonce contributes zero entropy when malformed, defeating its purpose as a replay-prevention mechanism.
- **Exploit scenario:** Attacker who has obtained the PSK (e.g. from reading the PSK file before BUG-019 fix) can replay a HELLO with a garbage nonce like `"!!!"`, computing `sha256(psk || [])` as the `pskHash`. Without nonce validation the server accepts this despite the malformed nonce field — no replay protection applies because there is no nonce uniqueness check on the server side either.
- **Remediation:** Reject the handshake if `URL_SAFE_NO_PAD.decode(nonce)` fails (return `PARSE_ERROR`) rather than silently using an empty nonce. Also enforce a minimum nonce length (≥ 8 bytes) before computing the hash. Note: adding server-side nonce replay detection (e.g. a seen-nonces `HashSet` with TTL) would complete the replay-prevention chain.
- **Status:** Open

### FINDING-RUST-004 [MEDIUM]
- **File:** `packages/desktop-agent/src-tauri/src/profile_store.rs:130`
- **Rule:** Pattern 11 — SQLCipher key formatted into a pragma string (log-adjacent risk)
- **Description:** `open_and_init` builds the PRAGMA string as:
  ```rust
  let pragma = format!("PRAGMA key = \"x'{}'\";\nPRAGMA cipher_compatibility = 4;", hex::encode(key));
  ```
  The key hex is embedded directly in the `pragma` string. If this string is ever logged (e.g. by rusqlite's internal tracing, or if a future developer adds `tracing::debug!("{pragma}")` for diagnostics), the master key leaks. The string is not a `SecretString` type; it is plain `String` on the heap with no zeroization on drop.
- **Exploit scenario:** A developer adding `tracing::debug!` around `execute_batch` for troubleshooting would trivially expose the 256-bit master key in log output or crash reports (Sentry, Tauri log file).
- **Remediation:** (a) Never pass the key as a formatted string. Use the SQLCipher `sqlite3_key` C API directly via rusqlite's `pragma_update` with the raw key blob — this avoids producing a hex string on the heap at all. Alternatively, (b) zero the `pragma` string immediately after `execute_batch` using a zeroizing wrapper (e.g. `zeroize::Zeroizing<String>`). At minimum, add a `// SECURITY: never log this string` comment and a `grep` CI check.
- **Status:** Open

### FINDING-RUST-005 [MEDIUM]
- **File:** `packages/desktop-agent/src-tauri/src/profile_store.rs:210` and `open_in_memory_for_tests` (same function)
- **Rule:** Pattern 11 (continued) — fixed test key in `open_in_memory_for_tests`
- **Description:** `open_in_memory_for_tests` and `ProfileStore::new()` (the backwards-compat alias) use a hardcoded all-`0x42` key. This constructor is called from `ipc_server.rs` tests via `ProfileStore::new()`. The docstring says "Not for production callers" but `lib.rs` previously called `ProfileStore::new()` (now uses `open_default`). If `new()` is accidentally used in production (possible since it's `pub`), the database is encrypted with a known key offering no protection.
- **Exploit scenario:** If `ProfileStore::new()` is accidentally wired into a non-test code path (easy mistake since it is `pub`), all profile data is encrypted with the well-known key `[0x42; 32]`, trivially breakable.
- **Remediation:** Mark `new()` and `open_in_memory_for_tests()` with `#[cfg(test)]` so they are unavailable outside test compilation. Add a compile-time guard: `#[cfg(not(test))] fn new() -> ! { panic!("ProfileStore::new() is test-only") }` as a last resort.
- **Status:** Open

---

## LOW

### FINDING-RUST-006 [LOW]
- **File:** `packages/desktop-agent/src-tauri/src/platform/macos.rs:245-246`
- **Rule:** Pattern 1 — `unsafe impl Send` / `unsafe impl Sync` on `AxElementRef`
- **Description:** `AxElementRef` (wrapping `AXUIElementRef`, a `*mut c_void`) is declared `unsafe impl Send` and `unsafe impl Sync`. The safety justification in comments cites "AXUIElementRef is documented as thread-safe for access (Apple Accessibility framework). CFRetain/CFRelease are atomic operations." However, `AXUIElementSetAttributeValue` is documented by Apple as NOT thread-safe for the same element from multiple threads. The current codebase is single-client so concurrent mutation cannot occur _today_, but if a future session adds concurrent adaptation (e.g. applying font-scale while inspecting), a data race could result.
- **Exploit scenario:** Low severity now because the IPC server holds a `Semaphore(1)` gate enforcing single-client. If that gate is relaxed in a future session without auditing the `Send+Sync` impl, concurrent AX API calls could race, producing corrupted element state or crashing the agent.
- **Remediation:** Add a prominent warning comment on the `unsafe impl` lines: "SAFETY BOUNDARY: AxElementRef may only be mutated (SetAttributeValue) while the single-client semaphore gate is held. If multi-client or concurrent adaptation is added, audit all AX mutation paths for thread-safety."
- **Status:** Open (documentation gap)
- **Prior-art:** None — new finding.

### FINDING-RUST-007 [LOW]
- **File:** `packages/desktop-agent/src-tauri/src/platform/linux.rs:127`
- **Rule:** Pattern 8 — integer narrowing cast on caller-influenced value
- **Description:** `adaptation.value.as_i64().unwrap_or(32) as i32` — the cursor-size value comes directly from the IPC-deserialized `serde_json::Value` supplied by the extension. If the extension sends a negative value (e.g. `-1`), `as_i64()` returns `-1_i64` and `as i32` produces `-1_i32`. This is passed to `gsettings set org.gnome.desktop.interface cursor-size -1`. gsettings will reject it as out-of-range for the GVariant `i` type and log an error, so there's no security impact — but it is an unvalidated caller-controlled integer that could trigger unexpected process behavior if gsettings handling changes.
- **Exploit scenario:** An extension with a compromised PSK (or any future message-replay) could send `{"kind":"cursor-size","value":-2147483648}` to trigger a gsettings error. Current impact: harmless gsettings error and `AdapterError::PlatformError` returned to the extension.
- **Remediation:** Clamp the cursor-size value to a sane range (e.g. 8–256 pixels) before calling gsettings: `let pixels = pixels.clamp(8, 256);`. Similarly clamp `scale` in the font-scale path.
- **Status:** Open (hardening)
- **Prior-art:** None — new finding.

### FINDING-RUST-008 [LOW]
- **File:** `packages/desktop-agent/src-tauri/src/bridge.rs:39-46`
- **Rule:** Pattern 14 — `#[tauri::command]` reading sensitive file without symlink guard
- **Description:** `bridge_read_pair_key_b64` reads the PSK file with `std::fs::read_to_string(&path)` and returns the base64 PSK to the Tauri webview. The read is not guarded by `refuse_if_symlink`. If an attacker plants a symlink at the PSK path pointing to another sensitive file, the Tauri settings window would silently read and return the contents of that file to the webview.
- **Exploit scenario:** Attacker with same-UID access replaces `pair.key` with a symlink to `db.key`. The next call to `bridge_read_pair_key_b64` from the settings window reads the DB key, which then fails the `PairKeyFile::from_json` parse — so no key material leaks to the JS layer. However, if a future refactor changes the return type to raw bytes, this could leak. Current severity is low.
- **Remediation:** Add `refuse_if_symlink` check in `bridge_read_pair_key_b64` before `read_to_string`, consistent with the pattern established for kdeglobals (BUG-018). Alternatively, enforce symlink rejection in the generic file-read path.
- **Status:** Open (defense-in-depth)
- **Prior-art:** BUG-018 — same pattern class.

### FINDING-RUST-009 [LOW]
- **File:** `packages/desktop-agent/src-tauri/src/xdg_paths.rs:56-65`
- **Rule:** Pattern 6 / BUG-018 class — app directory symlink is logged but NOT refused
- **Description:** `resolve_app_path` checks if the resolved app directory is a symlink and emits `tracing::warn!` but then proceeds to use it. The comment says "continuing per XDG convention". This means if an attacker replaces `~/.local/share/accessbridge/` with a symlink to `/etc/`, the agent will create/access files inside `/etc/` (e.g. `profile.db`). The XDG spec does NOT endorse following directory symlinks for security-sensitive applications.
- **Exploit scenario:** Same-UID attacker replaces the app data directory with a symlink to a world-writable directory. The agent then creates/opens `profile.db` there, potentially exposing the encrypted database to other users. The SQLCipher encryption provides some protection, but the file itself (with its metadata) would be readable by others.
- **Remediation:** Change the behavior from warn-and-continue to refuse-and-error when the app directory is a symlink: return an error from `resolve_app_path` rather than continuing. The `"per XDG convention"` justification is not valid for symlinks to the application directory itself.
- **Status:** Open (defense-in-depth)
- **Prior-art:** BUG-018.

---

## INFO

### FINDING-RUST-010 [INFO]
- **File:** `packages/desktop-agent/src-tauri/src/ipc_server.rs:293`
- **Rule:** Pattern 16 — confirm bind address
- **Description:** The server binds to `std::net::SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT))` — correctly loopback-only. Verified: `DEFAULT_PORT = 8901`.
- **Status:** Confirmed secure. No finding.

### FINDING-RUST-011 [INFO]
- **File:** `packages/desktop-agent/src-tauri/src/crypto.rs:78-80`
- **Rule:** Pattern 9 — PSK compare constant-time
- **Description:** `constant_time_eq` delegates to `ring::constant_time::verify_slices_are_equal(a, b).is_ok()`. Correctly used in `ipc_server.rs:276` for the handshake comparison. No `==` on PSK material found.
- **Status:** Confirmed secure. No finding.

### FINDING-RUST-012 [INFO]
- **File:** `packages/desktop-agent/src-tauri/src/crypto.rs:133-150`
- **Rule:** Pattern 10 — AES-GCM nonce reuse
- **Description:** `encrypt_payload` generates a fresh 12-byte nonce from `SystemRandom` per call via `rng.fill(&mut nonce_bytes)`. The nonce is prepended to the ciphertext. No static/counter nonce used. Test `aes_gcm_unique_nonce_produces_distinct_ciphertexts` validates this.
- **Status:** Confirmed secure. No finding.

### FINDING-RUST-013 [INFO]
- **File:** `packages/desktop-agent/src-tauri/src/platform/linux.rs:537-553`
- **Rule:** Pattern 7 — gsettings Command injection
- **Description:** `run_gsettings(args)` uses `Command::new("gsettings").args(args)` where all args are constant strings or pre-formatted numeric values (`format!("{scale:.2}")`, `format!("{pixels}")`). No user-controlled string is interpolated into the args array. Shell-safe.
- **Status:** Confirmed secure. No finding.

### FINDING-RUST-014 [INFO]
- **File:** `packages/desktop-agent/src-tauri/src/platform/windows.rs:237-251`
- **Rule:** Pattern 2 — raw pointer deref in Windows adapter
- **Description:** `process_name_by_pid` uses `unsafe` to call `OpenProcess`, `GetModuleBaseNameW`, `CloseHandle`. All three are standard Win32 FFI calls. `CloseHandle(handle)` is called unconditionally after `GetModuleBaseNameW`. No handle leak. Buffer is a fixed `[0u16; 260]` (MAX_PATH). `n as usize` cast is safe since `n <= 260`.
- **Status:** Confirmed secure. No finding.

### FINDING-RUST-015 [INFO]
- **File:** `packages/desktop-agent/src-tauri/src/platform/macos.rs`
- **Rule:** Pattern 17 — CFRelease/CFRetain balance
- **Description:** Audited manually.
  - `copy_attribute` returns `+1` pointer; callers always `CFRelease` the returned value (e.g. lines 519, 687-688, 712-713).
  - `bounding_rect_from_element` correctly `CFRelease`s `pos_val` and `size_val` after `AXValueGetValue`.
  - `cfnumber_from_f64` creates `+1` CFNumber; callers `CFRelease` it after `SetAttributeValue` (lines 713, 751).
  - `list_windows_with_refs`: `CFRetain(win_raw_get)` to get ownership, then wrapped in `AxElementRef`. `windows_arr_raw` (CFArray) released at line 546. The `AxElementRef` `Drop` releases the window refs.
  - One subtlety: `copy_attribute_with_err` (line 295) returns a raw `*mut c_void` without wrapping it. Callers in `apply_font_scale` at line 663-688 release it correctly. But if `ax_err != AX_SUCCESS` AND `font_size_raw` is non-null (theoretically possible per AX API), the pointer is never released (line 678 early-returns on error without CFRelease). This is a very narrow edge case in the AX error path.
- **Status:** Minor potential leak on AX error edge case (line 678 region). Low risk in practice. Recommend adding `if !font_size_raw.is_null() { CFRelease(font_size_raw); }` before the error-path early returns.

### FINDING-RUST-016 [INFO]
- **File:** `packages/desktop-agent/src-tauri/src/profile_store.rs:310-311`
- **Rule:** Unbounded query result bound check
- **Description:** `list_versions(limit)` caps at `limit.min(500)`. The 500 cap prevents unbounded result sets. Caller can request `usize::MAX` and gets at most 500 rows.
- **Status:** Confirmed bounded. No finding.

### FINDING-RUST-017 [INFO]
- **File:** `packages/desktop-agent/src-tauri/src/ipc_protocol.rs`
- **Rule:** Pattern 15 — IPC message variants size-bounded
- **Description:** All message variants use `serde_json::Value` for `profile` (unbounded JSON blob) and `Vec<NativeElementInfo>` for `elements`. The JSON deserialization itself is bounded by the axum WebSocket frame limit (axum default: 64 MiB). `elements` is never size-checked in the deserialized Rust message; a client could send `UIA_ELEMENTS` with a very large elements array. However, `UIA_ELEMENTS` is only sent server→client, never accepted from the client in `dispatch()` — clients send `UIA_INSPECT`. `profile` in `PROFILE_SET` is the only truly unbounded field accepted from clients. The broadcast channel is `broadcast::channel(16)` (bounded).
- **Status:** Low risk. `PROFILE_SET` accepts unbounded JSON `profile` value. Recommend enforcing a max byte-length check on incoming raw text frames (e.g. reject if `raw.len() > 1_048_576`).

### FINDING-RUST-018 [INFO]
- **File:** `packages/desktop-agent/src-tauri/src/platform/linux.rs` + `platform/linux_caps.rs`
- **Rule:** Pattern 13 — zbus/atspi payload deserialization bounds
- **Description:** AT-SPI D-Bus enumeration in `enumerate_top_level_windows` is bounded: 256 total elements cap, 64 per-process cap. `dfs_search` has depth cap 8 and total-visit cap 4096. `child_count.min(128)` enforced. These caps prevent unbounded memory allocation from a malicious AT-SPI daemon.
- **Status:** Confirmed bounded. No finding.

### FINDING-RUST-019 [INFO]
- **File:** `packages/desktop-agent/src-tauri/src/platform/linux.rs:183-202`
- **Rule:** Pattern 12 — blocking ops in async context
- **Description:** `run_async` uses `tokio::task::block_in_place` when a tokio runtime is available, which is correct usage (allows blocking on a multi-thread runtime without starving other tasks). The fallback (no runtime) builds a single-thread runtime. The synchronous `gsettings` subprocess calls in `apply_font_scale_impl`, `apply_cursor_size_impl`, and `kde_set_font_size` are called from the synchronous `AccessibilityAdapter` trait methods, not from `async fn`s.
- **Status:** Confirmed acceptable. No finding.

### FINDING-RUST-020 [INFO]
- **File:** `packages/core/src/ipc/handshake.ts` and `client.ts`
- **Rule:** TS client PSK handling
- **Description:** The TS client correctly uses `SubtleCrypto.digest('SHA-256', ...)` for the handshake hash (no `==` comparison — the result is sent to the server which does the constant-time comparison). `generateNonce(16)` uses `crypto.getRandomValues` (CSPRNG). The client does not hold a second PSK comparison; it relies on `pskOk` from the server's `HELLO_ACK`, which is fine since a MITM would need to be on loopback. PSK bytes are stored as `Uint8Array` in the `opts` object — no zeroization on disconnect/dispose.
- **Status:** Minor: PSK bytes not zeroized on `dispose()`. Low risk in extension service-worker context (memory is process-scoped and short-lived).

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 1 (FINDING-RUST-001) |
| Medium   | 4 (002–005) |
| Low      | 4 (006–009) |
| Info     | 11 (010–020) |

**Files scanned:** 20 Rust source files + 3 TypeScript IPC files (23 total)

**Patterns swept:** All 20 from the audit spec.

**Known-good (no findings):**
- Listener bind: `127.0.0.1:8901` confirmed (Pattern 16)
- Constant-time PSK compare: `ring::constant_time::verify_slices_are_equal` confirmed (Pattern 9)
- AES-GCM nonce: fresh `SystemRandom` per encrypt, never reused (Pattern 10)
- SQLCipher key logging: key not present in any `tracing::` call at time of audit (Pattern 11 partial)
- gsettings Command injection: `Command::new().args([...])` with formatted scalars only (Pattern 7)
- AT-SPI payload bounds: caps of 256/64/128/4096 in place (Pattern 13)
- Tokio blocking ops: `block_in_place` used correctly, no `std::fs::` in `async fn`s (Pattern 12)
- BUG-017 fix: `write_key_to_file` confirmed correct (OpenOptions::mode(0o600))
- BUG-019 fix: `load_or_create_pair_key` and `write_pair_key_at` confirmed correct
- BUG-018 fix: `refuse_if_symlink` confirmed present in both `apply_font_scale_kde` and `kde_set_font_size`
- Windows UIA COM handle: `CloseHandle` balanced after `OpenProcess` (Pattern 17)

**Key regression:** FINDING-RUST-001 is a direct regression of BUG-017/019 in a third write-site (`load_or_create_psk_via_keyring`) introduced in the same session as BUG-019's fix. The BUG-019 Prevention rule explicitly states "grep the ENTIRE codebase for the same anti-pattern at the time of the fix" — this site was missed.

**Hardest pattern to assess:** Pattern 17 (CFRelease/CFRetain balance in `platform/macos.rs`) — the `copy_attribute_with_err` return of a raw pointer with multiple error-path early returns required careful manual tracing of every code path.

**No patterns were skipped.** All 20 patterns from the spec were evaluated. Patterns 3 (path traversal) and 6 (symlink on config paths) required most cross-file correlation.
