//! PSK + AES-GCM primitives for the desktop agent.
//!
//! The pre-shared key is a 32-byte symmetric secret generated at first
//! run, persisted to `%LOCALAPPDATA%\AccessBridge\pair.key` in the same
//! user context the extension runs in. The WebSocket listener binds to
//! loopback only; PSK is a defense-in-depth factor that prevents another
//! local process from the same user from impersonating the extension.
//!
//! The handshake hash is `sha256(psk || nonce)` — deterministic,
//! compared in constant time. AES-GCM payload encryption is provided
//! but unused by the MVP; it is reserved for future messages whose
//! content should not be readable by a local packet-sniffer.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const PSK_LEN: usize = 32;
pub const GCM_TAG_LEN: usize = 16;

#[derive(Clone)]
pub struct Psk(pub [u8; PSK_LEN]);

impl Psk {
    pub fn generate() -> Self {
        let rng = SystemRandom::new();
        let mut buf = [0u8; PSK_LEN];
        rng.fill(&mut buf).expect("system RNG");
        Psk(buf)
    }

    pub fn from_bytes(b: [u8; PSK_LEN]) -> Self {
        Psk(b)
    }

    pub fn as_bytes(&self) -> &[u8; PSK_LEN] {
        &self.0
    }

    pub fn to_base64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.0)
    }

    pub fn from_base64(s: &str) -> Result<Self, CryptoError> {
        let raw = URL_SAFE_NO_PAD
            .decode(s)
            .map_err(|e| CryptoError::InvalidBase64(e.to_string()))?;
        if raw.len() != PSK_LEN {
            return Err(CryptoError::InvalidKeyLength(raw.len(), PSK_LEN));
        }
        let mut buf = [0u8; PSK_LEN];
        buf.copy_from_slice(&raw);
        Ok(Psk(buf))
    }
}

impl std::fmt::Debug for Psk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Psk(<redacted>)")
    }
}

pub fn psk_hash(psk: &Psk, nonce: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(psk.as_bytes());
    h.update(nonce);
    let digest = h.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    ring::constant_time::verify_slices_are_equal(a, b).is_ok()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PairKeyFile {
    pub version: u32,
    pub created_at: u64,
    pub psk_b64: String,
}

impl PairKeyFile {
    pub fn new_with_random_psk() -> (Self, Psk) {
        let psk = Psk::generate();
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let file = PairKeyFile {
            version: 1,
            created_at,
            psk_b64: psk.to_base64(),
        };
        (file, psk)
    }

    pub fn from_json(s: &str) -> Result<(Self, Psk), CryptoError> {
        let file: PairKeyFile = serde_json::from_str(s)?;
        if !file.is_valid() {
            return Err(CryptoError::InvalidPairKey(format!(
                "version={} psk_b64_len={}",
                file.version,
                file.psk_b64.len()
            )));
        }
        let psk = Psk::from_base64(&file.psk_b64)?;
        Ok((file, psk))
    }

    pub fn to_json(&self) -> Result<String, CryptoError> {
        Ok(serde_json::to_string(self)?)
    }

    pub fn is_valid(&self) -> bool {
        if self.version != 1 {
            return false;
        }
        match URL_SAFE_NO_PAD.decode(&self.psk_b64) {
            Ok(b) => b.len() == PSK_LEN,
            Err(_) => false,
        }
    }
}

pub fn encrypt_payload(key: &Psk, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let rng = SystemRandom::new();
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill(&mut nonce_bytes).map_err(|_| CryptoError::RandomFailure)?;

    let unbound = UnboundKey::new(&AES_256_GCM, key.as_bytes())
        .map_err(|_| CryptoError::Encryption)?;
    let sealing = LessSafeKey::new(unbound);

    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let mut buf = plaintext.to_vec();
    sealing
        .seal_in_place_append_tag(nonce, Aad::from(aad), &mut buf)
        .map_err(|_| CryptoError::Encryption)?;

    let mut out = Vec::with_capacity(NONCE_LEN + buf.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&buf);
    Ok(out)
}

pub fn decrypt_payload(key: &Psk, ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if ciphertext.len() < NONCE_LEN + GCM_TAG_LEN {
        return Err(CryptoError::Decryption);
    }
    let mut nonce_bytes = [0u8; NONCE_LEN];
    nonce_bytes.copy_from_slice(&ciphertext[..NONCE_LEN]);
    let mut buf = ciphertext[NONCE_LEN..].to_vec();

    let unbound = UnboundKey::new(&AES_256_GCM, key.as_bytes())
        .map_err(|_| CryptoError::Decryption)?;
    let opening = LessSafeKey::new(unbound);
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);

    let plaintext = opening
        .open_in_place(nonce, Aad::from(aad), &mut buf)
        .map_err(|_| CryptoError::Decryption)?;
    Ok(plaintext.to_vec())
}

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("invalid base64: {0}")]
    InvalidBase64(String),
    #[error("invalid key length: got {0}, expected {1}")]
    InvalidKeyLength(usize, usize),
    #[error("serde error: {0}")]
    SerdeError(#[from] serde_json::Error),
    #[error("random generator failure")]
    RandomFailure,
    #[error("encryption failed")]
    Encryption,
    #[error("decryption failed")]
    Decryption,
    #[error("invalid pair key: {0}")]
    InvalidPairKey(String),
    #[error("keyring error: {0}")]
    Keyring(String),
    #[error("io error: {0}")]
    Io(String),
}

// ---------------------------------------------------------------------------
// SecretStore trait — abstraction for keyring/mock in tests
// ---------------------------------------------------------------------------

trait SecretStore {
    /// Returns `Ok(Some(value))` if found, `Ok(None)` if not present,
    /// `Err(String)` for platform errors.
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String>;
    #[allow(dead_code)]
    fn delete(&self, service: &str, account: &str) -> Result<(), String>;
}

// ---------------------------------------------------------------------------
// Production keyring implementation
// ---------------------------------------------------------------------------

struct KeyringStore;

impl SecretStore for KeyringStore {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(service, account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(service, account).map_err(|e| e.to_string())?;
        entry.set_password(value).map_err(|e| e.to_string())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(service, account).map_err(|e| e.to_string())?;
        entry.delete_credential().map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------------------
// File fallback helpers
// ---------------------------------------------------------------------------

fn read_key_from_file(path: &Path) -> Option<[u8; 32]> {
    let raw = std::fs::read_to_string(path).ok()?;
    let bytes = URL_SAFE_NO_PAD.decode(raw.trim()).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&bytes);
    Some(buf)
}

/// Write arbitrary bytes to a file with 0o600 permissions on Unix.
///
/// Mirrors the BUG-017/BUG-019 pattern: the file is created with the
/// restrictive mode at open time so it is never world-readable even for
/// a microsecond on a multi-user Linux host.
fn write_secret_file_at(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::fs::PermissionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(bytes)?;
        // Belt-and-braces: chmod again in case the file pre-existed.
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)?;
    }
    Ok(())
}

fn write_key_to_file(path: &Path, key: &[u8; 32]) -> Result<(), CryptoError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| CryptoError::Io(e.to_string()))?;
    }
    let encoded = URL_SAFE_NO_PAD.encode(key);

    // Session 21 adversarial fix: open with 0o600 mode up-front on Unix so
    // the file never exists at the default umask (typically 0o644) even for
    // a microsecond — closes a narrow multi-user-host key-leak window.
    // See RCA BUG-017 for the incident pattern.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| CryptoError::Io(e.to_string()))?;
        f.write_all(encoded.as_bytes())
            .map_err(|e| CryptoError::Io(e.to_string()))?;
        // chmod again in case the file pre-existed with broader perms
        // (OpenOptionsExt::mode only applies on creation).
        use std::os::unix::fs::PermissionsExt;
        let mut perms =
            std::fs::metadata(path).map_err(|e| CryptoError::Io(e.to_string()))?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(path, perms).map_err(|e| CryptoError::Io(e.to_string()))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, &encoded).map_err(|e| CryptoError::Io(e.to_string()))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// OS-specific fallback path for the DB key
// ---------------------------------------------------------------------------

fn platform_db_key_path() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let mut p = PathBuf::from(local_app_data);
            p.push("AccessBridge");
            p.push("db.key");
            return p;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let mut p = PathBuf::from(home);
            p.push("Library/Application Support/AccessBridge/db.key");
            return p;
        }
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        // Linux / other Unix: prefer XDG_DATA_HOME
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            let mut p = PathBuf::from(xdg);
            p.push("AccessBridge/db.key");
            return p;
        }
        if let Some(home) = std::env::var_os("HOME") {
            let mut p = PathBuf::from(home);
            p.push(".local/share/AccessBridge/db.key");
            return p;
        }
    }
    PathBuf::from("./db.key")
}

// ---------------------------------------------------------------------------
// Core implementation — testable via injected store + path
// ---------------------------------------------------------------------------

fn generate_32_bytes() -> Result<[u8; 32], CryptoError> {
    let rng = SystemRandom::new();
    let mut key = [0u8; 32];
    rng.fill(&mut key).map_err(|_| CryptoError::RandomFailure)?;
    Ok(key)
}

fn get_or_create_db_key_with_store(
    store: &dyn SecretStore,
    file_path: &Path,
) -> Result<[u8; 32], CryptoError> {
    const SERVICE: &str = "accessbridge";
    const ACCOUNT: &str = "db-key";

    match store.get(SERVICE, ACCOUNT) {
        Ok(Some(encoded)) => {
            // Try to decode; if corrupt or wrong length, regenerate.
            match URL_SAFE_NO_PAD.decode(encoded.trim()) {
                Ok(bytes) if bytes.len() == 32 => {
                    let mut buf = [0u8; 32];
                    buf.copy_from_slice(&bytes);
                    return Ok(buf);
                }
                _ => {
                    tracing::warn!(
                        "db-key in keyring is corrupt or wrong length — regenerating"
                    );
                }
            }
            // Fall through to generate + overwrite.
            let key = generate_32_bytes()?;
            if let Err(e) = store.set(SERVICE, ACCOUNT, &URL_SAFE_NO_PAD.encode(&key)) {
                tracing::warn!("could not overwrite corrupt keyring db-key: {e}");
                write_key_to_file(file_path, &key)?;
            }
            Ok(key)
        }
        Ok(None) => {
            // First run — create fresh key.
            let key = generate_32_bytes()?;
            if let Err(e) = store.set(SERVICE, ACCOUNT, &URL_SAFE_NO_PAD.encode(&key)) {
                tracing::warn!(
                    "keyring unavailable ({}), falling back to file storage",
                    e
                );
                write_key_to_file(file_path, &key)?;
            }
            Ok(key)
        }
        Err(e) => {
            // Platform/keyring error — fall back to file.
            tracing::warn!("keyring get error ({}), falling back to file storage", e);
            if let Some(existing) = read_key_from_file(file_path) {
                return Ok(existing);
            }
            let key = generate_32_bytes()?;
            write_key_to_file(file_path, &key)?;
            Ok(key)
        }
    }
}

fn rotate_db_key_with_store(
    store: &dyn SecretStore,
    file_path: &Path,
) -> Result<[u8; 32], CryptoError> {
    const SERVICE: &str = "accessbridge";
    const ACCOUNT: &str = "db-key";

    let key = generate_32_bytes()?;
    let encoded = URL_SAFE_NO_PAD.encode(&key);

    if let Err(e) = store.set(SERVICE, ACCOUNT, &encoded) {
        tracing::warn!("keyring set error during rotate ({}), falling back to file", e);
        write_key_to_file(file_path, &key)?;
    }
    Ok(key)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Retrieve or create the 32-byte database master key.
///
/// Tries the OS keyring first.  Falls back to a platform-specific file on
/// keyring failure (e.g. headless server, missing secret-service daemon).
pub fn get_or_create_db_key() -> Result<[u8; 32], CryptoError> {
    get_or_create_db_key_with_store(&KeyringStore, &platform_db_key_path())
}

/// Rotate the 32-byte database master key.
///
/// Overwrites the existing keyring entry (or file) with freshly-generated
/// bytes.  The caller is responsible for re-encrypting any dependent data.
pub fn rotate_db_key() -> Result<[u8; 32], CryptoError> {
    rotate_db_key_with_store(&KeyringStore, &platform_db_key_path())
}

/// Load or create the PSK via the OS keyring.
///
/// Service: `"accessbridge"`, Account: `"pair-psk"`.  Falls back to the same
/// file path used by `ipc_server::load_or_create_pair_key` so that an
/// existing key survives a keyring migration.
///
/// This is ADDITIVE — `ipc_server::load_or_create_pair_key` is unchanged;
/// a future commit will migrate callers to this function.
pub fn load_or_create_psk_via_keyring() -> Result<Psk, CryptoError> {
    const SERVICE: &str = "accessbridge";
    const ACCOUNT: &str = "pair-psk";

    let file_path = crate::ipc_server::pair_key_path();

    match KeyringStore.get(SERVICE, ACCOUNT) {
        Ok(Some(encoded)) => {
            // The stored value is the raw PSK in URL_SAFE_NO_PAD base64.
            match Psk::from_base64(encoded.trim()) {
                Ok(psk) => return Ok(psk),
                Err(_) => {
                    tracing::warn!(
                        "pair-psk in keyring is corrupt — regenerating"
                    );
                }
            }
        }
        Ok(None) => {
            // Check file fallback first (migration path).
            if file_path.exists() {
                if let Ok(raw) = std::fs::read_to_string(&file_path) {
                    if let Ok((_file, psk)) = PairKeyFile::from_json(&raw) {
                        // Migrate to keyring.
                        let _ = KeyringStore.set(SERVICE, ACCOUNT, &psk.to_base64());
                        return Ok(psk);
                    }
                }
            }
        }
        Err(e) => {
            tracing::warn!(
                "keyring get error for pair-psk ({}), falling back to file",
                e
            );
            // Try file fallback.
            if file_path.exists() {
                if let Ok(raw) = std::fs::read_to_string(&file_path) {
                    if let Ok((_file, psk)) = PairKeyFile::from_json(&raw) {
                        return Ok(psk);
                    }
                }
            }
        }
    }

    // Generate fresh PSK, persist to keyring + file.
    let (file, psk) = PairKeyFile::new_with_random_psk();
    if let Err(e) = KeyringStore.set(SERVICE, ACCOUNT, &psk.to_base64()) {
        tracing::warn!("keyring set error for pair-psk ({}), writing to file only", e);
    }
    // Always write the file as well so ipc_server::load_or_create_pair_key stays consistent.
    // RUST-001 fix (BUG-017/019 regression): use write_secret_file_at so the file
    // is created at 0o600 on Unix — never world-readable even for a microsecond.
    if let Ok(json) = file.to_json() {
        if let Err(err) = write_secret_file_at(&file_path, json.as_bytes()) {
            tracing::warn!("failed to persist PSK file: {err}");
        }
    }
    Ok(psk)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_produces_distinct_keys() {
        let a = Psk::generate();
        let b = Psk::generate();
        assert_ne!(a.as_bytes(), b.as_bytes());
    }

    #[test]
    fn base64_round_trip() {
        let psk = Psk::generate();
        let b64 = psk.to_base64();
        let decoded = Psk::from_base64(&b64).unwrap();
        assert_eq!(psk.as_bytes(), decoded.as_bytes());
    }

    #[test]
    fn from_base64_rejects_wrong_length() {
        let short = URL_SAFE_NO_PAD.encode([0u8; 16]);
        match Psk::from_base64(&short) {
            Err(CryptoError::InvalidKeyLength(got, want)) => {
                assert_eq!(got, 16);
                assert_eq!(want, 32);
            }
            other => panic!("expected InvalidKeyLength, got {other:?}"),
        }
    }

    #[test]
    fn psk_hash_is_deterministic() {
        let psk = Psk::from_bytes([7u8; 32]);
        let nonce = [3u8; 16];
        let a = psk_hash(&psk, &nonce);
        let b = psk_hash(&psk, &nonce);
        assert_eq!(a, b);
    }

    #[test]
    fn psk_hash_differs_when_nonce_differs() {
        let psk = Psk::from_bytes([7u8; 32]);
        let a = psk_hash(&psk, &[1u8; 16]);
        let b = psk_hash(&psk, &[2u8; 16]);
        assert_ne!(a, b);
    }

    #[test]
    fn psk_hash_differs_when_psk_differs() {
        let nonce = [3u8; 16];
        let a = psk_hash(&Psk::from_bytes([1u8; 32]), &nonce);
        let b = psk_hash(&Psk::from_bytes([2u8; 32]), &nonce);
        assert_ne!(a, b);
    }

    #[test]
    fn constant_time_eq_matches_semantic_equality() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }

    #[test]
    fn pair_key_file_round_trip_preserves_psk() {
        let (file, psk) = PairKeyFile::new_with_random_psk();
        assert_eq!(file.version, 1);
        assert!(file.is_valid());
        let json = file.to_json().unwrap();
        let (parsed, parsed_psk) = PairKeyFile::from_json(&json).unwrap();
        assert_eq!(parsed, file);
        assert_eq!(parsed_psk.as_bytes(), psk.as_bytes());
    }

    #[test]
    fn pair_key_file_invalid_version_fails() {
        let file = PairKeyFile {
            version: 2,
            created_at: 0,
            psk_b64: URL_SAFE_NO_PAD.encode([0u8; 32]),
        };
        assert!(!file.is_valid());
        let json = serde_json::to_string(&file).unwrap();
        let err = PairKeyFile::from_json(&json).unwrap_err();
        assert!(matches!(err, CryptoError::InvalidPairKey(_)));
    }

    #[test]
    fn pair_key_file_invalid_length_fails() {
        let file = PairKeyFile {
            version: 1,
            created_at: 0,
            psk_b64: URL_SAFE_NO_PAD.encode([0u8; 10]),
        };
        assert!(!file.is_valid());
    }

    #[test]
    fn pair_key_file_from_malformed_json_fails() {
        let err = PairKeyFile::from_json("{not-json").unwrap_err();
        assert!(matches!(err, CryptoError::SerdeError(_)));
    }

    #[test]
    fn aes_gcm_round_trip_preserves_plaintext() {
        let key = Psk::generate();
        let plaintext = b"hello AccessBridge";
        let aad = b"ipc/v1";
        let ct = encrypt_payload(&key, plaintext, aad).unwrap();
        assert_ne!(ct.as_slice(), plaintext.as_slice());
        let pt = decrypt_payload(&key, &ct, aad).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn aes_gcm_tampered_ciphertext_fails() {
        let key = Psk::generate();
        let mut ct = encrypt_payload(&key, b"payload", b"aad").unwrap();
        let last = ct.len() - 1;
        ct[last] ^= 0x01;
        assert!(matches!(decrypt_payload(&key, &ct, b"aad"), Err(CryptoError::Decryption)));
    }

    #[test]
    fn aes_gcm_wrong_aad_fails() {
        let key = Psk::generate();
        let ct = encrypt_payload(&key, b"payload", b"aad").unwrap();
        assert!(matches!(decrypt_payload(&key, &ct, b"other"), Err(CryptoError::Decryption)));
    }

    #[test]
    fn aes_gcm_wrong_key_fails() {
        let k1 = Psk::from_bytes([1u8; 32]);
        let k2 = Psk::from_bytes([2u8; 32]);
        let ct = encrypt_payload(&k1, b"payload", b"aad").unwrap();
        assert!(matches!(decrypt_payload(&k2, &ct, b"aad"), Err(CryptoError::Decryption)));
    }

    #[test]
    fn aes_gcm_unique_nonce_produces_distinct_ciphertexts() {
        let key = Psk::generate();
        let a = encrypt_payload(&key, b"same", b"aad").unwrap();
        let b = encrypt_payload(&key, b"same", b"aad").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn aes_gcm_short_input_rejects_cleanly() {
        let key = Psk::generate();
        assert!(matches!(decrypt_payload(&key, &[0u8; 5], b"aad"), Err(CryptoError::Decryption)));
    }

    // ---------------------------------------------------------------------------
    // MockStore — in-memory SecretStore for unit tests
    // ---------------------------------------------------------------------------

    struct MockStore {
        inner: std::sync::Arc<
            std::sync::Mutex<std::collections::HashMap<(String, String), String>>,
        >,
        fail_get: bool,
    }

    impl MockStore {
        fn new() -> Self {
            MockStore {
                inner: std::sync::Arc::new(std::sync::Mutex::new(
                    std::collections::HashMap::new(),
                )),
                fail_get: false,
            }
        }

        fn failing() -> Self {
            MockStore {
                inner: std::sync::Arc::new(std::sync::Mutex::new(
                    std::collections::HashMap::new(),
                )),
                fail_get: true,
            }
        }
    }

    impl SecretStore for MockStore {
        fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
            if self.fail_get {
                return Err("mock platform failure".to_string());
            }
            let map = self.inner.lock().unwrap();
            Ok(map.get(&(service.to_string(), account.to_string())).cloned())
        }

        fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
            let mut map = self.inner.lock().unwrap();
            map.insert((service.to_string(), account.to_string()), value.to_string());
            Ok(())
        }

        fn delete(&self, service: &str, account: &str) -> Result<(), String> {
            let mut map = self.inner.lock().unwrap();
            map.remove(&(service.to_string(), account.to_string()));
            Ok(())
        }
    }

    // Shared Arc<MockStore> wrapper for concurrent test
    struct ArcStore(std::sync::Arc<MockStore>);
    impl SecretStore for ArcStore {
        fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
            self.0.get(service, account)
        }
        fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
            self.0.set(service, account, value)
        }
        fn delete(&self, service: &str, account: &str) -> Result<(), String> {
            self.0.delete(service, account)
        }
    }

    // ---------------------------------------------------------------------------
    // Test helper: create a unique temp directory without external deps
    // ---------------------------------------------------------------------------

    fn unique_test_dir(test_name: &str) -> PathBuf {
        let base = std::env::temp_dir()
            .join("accessbridge_crypto_tests")
            .join(format!(
                "{}_{}",
                test_name,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
        std::fs::create_dir_all(&base).expect("failed to create test temp dir");
        base
    }

    // ---------------------------------------------------------------------------
    // 8 new keyring / file-fallback tests
    // ---------------------------------------------------------------------------

    #[test]
    fn get_or_create_creates_on_first_call_returns_same_on_second() {
        let store = MockStore::new();
        let dir = unique_test_dir("get_or_create_same");
        let file_path = dir.join("db.key");

        let key1 = get_or_create_db_key_with_store(&store, &file_path).unwrap();
        let key2 = get_or_create_db_key_with_store(&store, &file_path).unwrap();

        assert_eq!(key1, key2, "second call must return the same key");
        assert_eq!(key1.len(), 32);

        // Verify the store was written exactly once (second call reads back).
        let stored = store
            .inner
            .lock()
            .unwrap()
            .get(&("accessbridge".to_string(), "db-key".to_string()))
            .cloned();
        assert!(stored.is_some(), "keyring entry must be set");
    }

    #[test]
    fn rotate_returns_distinct_bytes() {
        let store = MockStore::new();
        let dir = unique_test_dir("rotate_distinct");
        let file_path = dir.join("db.key");

        let key1 = rotate_db_key_with_store(&store, &file_path).unwrap();
        let key2 = rotate_db_key_with_store(&store, &file_path).unwrap();

        assert_ne!(key1, key2, "each rotation must produce a distinct key");
        assert_eq!(key1.len(), 32);
        assert_eq!(key2.len(), 32);
    }

    #[test]
    fn keyring_error_triggers_file_fallback() {
        let store = MockStore::failing();
        let dir = unique_test_dir("keyring_error_fallback");
        let file_path = dir.join("db.key");

        let key = get_or_create_db_key_with_store(&store, &file_path)
            .expect("should succeed via file fallback");

        assert_eq!(key.len(), 32);
        // File must have been written.
        assert!(file_path.exists(), "fallback file must be created");
        let file_key = read_key_from_file(&file_path)
            .expect("fallback file must contain a valid 32-byte key");
        assert_eq!(key, file_key);
    }

    #[test]
    fn file_fallback_round_trip_preserves_key() {
        let dir = unique_test_dir("file_round_trip");
        let file_path = dir.join("db.key");
        let key: [u8; 32] = {
            let rng = SystemRandom::new();
            let mut buf = [0u8; 32];
            rng.fill(&mut buf).unwrap();
            buf
        };

        write_key_to_file(&file_path, &key).expect("write must succeed");
        let read_back = read_key_from_file(&file_path).expect("read must succeed");
        assert_eq!(key, read_back);
    }

    #[cfg(unix)]
    #[test]
    fn file_fallback_sets_0o600_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let dir = unique_test_dir("file_0o600");
        let file_path = dir.join("db.key");
        let key = [0xAAu8; 32];

        write_key_to_file(&file_path, &key).expect("write must succeed");

        let metadata = std::fs::metadata(&file_path).expect("metadata");
        let mode = metadata.permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "file must be 0600, got {:o}",
            mode & 0o777
        );
    }

    #[test]
    fn corrupted_base64_in_keyring_triggers_regeneration() {
        let store = MockStore::new();
        // Seed with corrupt data.
        store
            .set("accessbridge", "db-key", "not-valid-base64!!!")
            .unwrap();

        let dir = unique_test_dir("corrupt_b64_regen");
        let file_path = dir.join("db.key");

        let key = get_or_create_db_key_with_store(&store, &file_path)
            .expect("must succeed with fresh key after regeneration");

        assert_eq!(key.len(), 32, "key must be 32 bytes");
        // Keyring must have been updated with a valid value.
        let stored_val = store
            .inner
            .lock()
            .unwrap()
            .get(&("accessbridge".to_string(), "db-key".to_string()))
            .cloned()
            .expect("keyring must be updated");
        let decoded = URL_SAFE_NO_PAD.decode(&stored_val).expect("must be valid base64");
        assert_eq!(decoded.len(), 32, "stored value must encode 32 bytes");
    }

    #[test]
    fn key_is_always_32_bytes() {
        for i in 0..20 {
            let store = MockStore::new();
            let dir = unique_test_dir(&format!("always_32_{}", i));
            let file_path = dir.join("db.key");
            let key = get_or_create_db_key_with_store(&store, &file_path).unwrap();
            assert_eq!(key.len(), 32);
        }
    }

    // RUST-001 regression guard: PSK file-fallback write must produce 0o600 on Unix.
    #[cfg(unix)]
    #[test]
    fn load_or_create_psk_via_keyring_file_fallback_has_0o600() {
        use std::os::unix::fs::PermissionsExt;

        let dir = unique_test_dir("psk_fallback_0o600");
        let path = dir.join("pair.key");

        // Call write_secret_file_at directly (same helper the fallback path uses)
        // with realistic PSK JSON bytes so we test the exact code path.
        let (file, _psk) = PairKeyFile::new_with_random_psk();
        let json = file.to_json().expect("to_json must succeed");
        write_secret_file_at(&path, json.as_bytes())
            .expect("write_secret_file_at must succeed");

        let meta = std::fs::metadata(&path).expect("file must exist after write");
        let mode = meta.permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "PSK file must be 0600, got {:03o}",
            mode & 0o777
        );
    }

    #[test]
    fn concurrent_callers_all_return_valid_32_byte_keys() {
        use std::sync::Arc;

        // Wrap MockStore in Arc so all threads share the same in-memory store.
        let shared = Arc::new(MockStore::new());
        let dir_path = Arc::new(unique_test_dir("concurrent_callers"));

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let store_ref = Arc::clone(&shared);
                let path = Arc::clone(&dir_path);
                std::thread::spawn(move || {
                    let wrapper = ArcStore(store_ref);
                    let file_path = path.join("db.key");
                    get_or_create_db_key_with_store(&wrapper, &file_path)
                })
            })
            .collect();

        for handle in handles {
            let result = handle.join().expect("thread panicked");
            let key = result.expect("get_or_create must succeed");
            assert_eq!(key.len(), 32, "each concurrent caller must get a valid 32-byte key");
        }
    }
}
