//! SQLCipher-backed AccessibilityProfile store.
//!
//! The database lives under `%LOCALAPPDATA%\AccessBridge\profile.db` on Windows
//! and `~/.local/share/AccessBridge/profile.db` on other platforms.  The master
//! key is supplied by the caller (see `crypto::get_or_create_db_key`).
//!
//! Public API surface is intentionally compatible with the previous in-memory
//! implementation so that `ipc_server.rs` callers need no changes.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::broadcast;

use crate::crypto::CryptoError;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("rusqlite error: {0}")]
    Rusqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("history entry not found: {0}")]
    NotFound(i64),
    #[error("wrong db key: {0}")]
    WrongKey(String),
    #[error("db key error: {0}")]
    DbKey(String),
}

impl From<CryptoError> for StoreError {
    fn from(e: CryptoError) -> Self {
        StoreError::DbKey(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// History entry DTO
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileHistoryEntry {
    pub id: i64,
    pub version: i64,
    pub json: String,
    pub saved_at: i64,
}

// ---------------------------------------------------------------------------
// Public type aliases
// ---------------------------------------------------------------------------

pub type ProfileSubscriber = broadcast::Receiver<Value>;

// ---------------------------------------------------------------------------
// ProfileStore
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct ProfileStore {
    inner: Arc<Mutex<Connection>>,
    tx: broadcast::Sender<Value>,
}

impl std::fmt::Debug for ProfileStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ProfileStore {{ .. }}")
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Current UNIX timestamp in seconds.
fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Platform-specific path to the profile database file.
pub fn platform_profile_db_path() -> PathBuf {
    let mut base: PathBuf = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    } else if let Some(home) = std::env::var_os("HOME") {
        let mut p = PathBuf::from(home);
        p.push(".local/share");
        p
    } else {
        PathBuf::from(".")
    };
    base.push("AccessBridge");
    base.push("profile.db");
    base
}

/// Open a `Connection`, apply the SQLCipher PRAGMA key, check it is valid,
/// and run the schema DDL.  Returns `StoreError::WrongKey` when the key does
/// not match the existing database.
fn open_and_init(path: &Path, key: &[u8; 32]) -> Result<Connection, StoreError> {
    // Create parent directories if needed.
    if let Some(parent) = path.parent() {
        // Only call create_dir_all if the path is not the in-memory sentinel.
        // In practice we never pass ":memory:" through here, but guard anyway.
        if parent != Path::new("") {
            std::fs::create_dir_all(parent)?;
        }
    }

    let conn = Connection::open(path)?;

    // Apply the SQLCipher key.  The pragma must be issued BEFORE any other
    // SQL.  Raw-hex form: PRAGMA key = "x'HHHH...'";
    let pragma = format!("PRAGMA key = \"x'{}'\";\nPRAGMA cipher_compatibility = 4;", hex::encode(key));
    conn.execute_batch(&pragma)?;

    // Force SQLCipher to validate the key immediately.  If the key is wrong,
    // sqlite3_step() on any real query returns SQLITE_NOTADB (error code 26).
    let check_result = conn.query_row(
        "SELECT count(*) FROM sqlite_master",
        [],
        |row| row.get::<_, i64>(0),
    );

    if let Err(rusqlite::Error::SqliteFailure(ref ffi_err, _)) = check_result {
        // SQLITE_NOTADB == 26.  SQLCipher surfaces this when the key is wrong.
        if ffi_err.extended_code == 26 {
            return Err(StoreError::WrongKey(
                "incorrect SQLCipher master key".to_string(),
            ));
        }
        return Err(StoreError::Rusqlite(check_result.unwrap_err()));
    }
    // Any other rusqlite error propagates normally.
    check_result.map_err(StoreError::Rusqlite)?;

    // Run schema migrations (idempotent).
    conn.execute_batch(SCHEMA_SQL)?;

    Ok(conn)
}

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL,
    json TEXT NOT NULL,
    saved_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
"#;

// ---------------------------------------------------------------------------
// impl ProfileStore
// ---------------------------------------------------------------------------

impl ProfileStore {
    // -----------------------------------------------------------------------
    // Constructors
    // -----------------------------------------------------------------------

    /// Open (or create) a SQLCipher database at `path` using `key`.
    pub fn open_at<P: AsRef<Path>>(path: P, key: &[u8; 32]) -> Result<Self, StoreError> {
        let conn = open_and_init(path.as_ref(), key)?;
        let (tx, _) = broadcast::channel(16);
        Ok(ProfileStore {
            inner: Arc::new(Mutex::new(conn)),
            tx,
        })
    }

    /// Open the default platform database path, deriving the key via
    /// `crypto::get_or_create_db_key()`.
    pub fn open_default(key: &[u8; 32]) -> Result<Self, StoreError> {
        let path = platform_profile_db_path();
        Self::open_at(path, key)
    }

    /// Open an in-memory database with a fixed test key.  Useful in unit
    /// tests that do not want temporary files.
    pub fn open_in_memory_for_tests() -> Result<Self, StoreError> {
        let key = [0x42u8; 32];
        // For in-memory DBs we skip parent-dir creation logic.
        let conn = Connection::open_in_memory()?;
        let pragma = format!("PRAGMA key = \"x'{}'\";\nPRAGMA cipher_compatibility = 4;", hex::encode(key));
        conn.execute_batch(&pragma)?;
        conn.execute_batch(SCHEMA_SQL)?;
        let (tx, _) = broadcast::channel(16);
        Ok(ProfileStore {
            inner: Arc::new(Mutex::new(conn)),
            tx,
        })
    }

    /// Backwards-compatible alias used by existing tests in `ipc_server.rs`.
    /// Internally identical to `open_in_memory_for_tests()`.
    ///
    /// Note: this constructor exists only to avoid breaking `ipc_server.rs`
    /// tests.  Production callers in `lib.rs` should be updated to use
    /// `open_default` once the keyring worker is available.
    pub fn new() -> Self {
        Self::open_in_memory_for_tests()
            .expect("in-memory ProfileStore init must never fail")
    }

    // -----------------------------------------------------------------------
    // Core API — kept API-compatible with the old in-memory implementation.
    // -----------------------------------------------------------------------

    /// Return the current profile.  Returns `Value::Null` if no profile row
    /// exists.  Never panics.
    pub fn get(&self) -> Value {
        let conn = match self.inner.lock() {
            Ok(c) => c,
            Err(_) => return Value::Null,
        };
        let result = conn.query_row(
            "SELECT json FROM profile WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(json_str) => serde_json::from_str(&json_str).unwrap_or(Value::Null),
            Err(rusqlite::Error::QueryReturnedNoRows) => Value::Null,
            Err(_) => Value::Null,
        }
    }

    /// Persist `profile`, advancing the version counter and archiving the
    /// previous profile into `profile_history`.  Broadcasts the new value to
    /// all subscribers.  Returns the echoed profile.
    pub fn set(&self, profile: Value) -> Value {
        let conn = match self.inner.lock() {
            Ok(c) => c,
            Err(_) => return profile,
        };

        let ts = now_secs();

        // Read the current row (if any) so we can archive it and derive the
        // next version number.
        let existing: Option<(i64, String)> = conn
            .query_row(
                "SELECT version, json FROM profile WHERE id = 1",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .unwrap_or(None);

        let next_version = existing.as_ref().map(|(v, _)| v + 1).unwrap_or(1);

        // Archive the current profile into history.
        if let Some((prev_version, prev_json)) = &existing {
            let _ = conn.execute(
                "INSERT INTO profile_history (version, json, saved_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![prev_version, prev_json, ts],
            );
        }

        // Serialise and UPSERT the new profile.
        let json_str = serde_json::to_string(&profile).unwrap_or_else(|_| "null".to_string());
        let _ = conn.execute(
            "INSERT OR REPLACE INTO profile (id, version, json, updated_at) VALUES (1, ?1, ?2, ?3)",
            rusqlite::params![next_version, json_str, ts],
        );

        drop(conn); // release lock before broadcast
        let _ = self.tx.send(profile.clone());
        profile
    }

    /// Subscribe to profile-change broadcast events.
    pub fn subscribe(&self) -> ProfileSubscriber {
        self.tx.subscribe()
    }

    // -----------------------------------------------------------------------
    // History & rollback
    // -----------------------------------------------------------------------

    /// List the most recent `limit` history entries, newest first.
    /// `limit` is capped at 500.
    pub fn list_versions(&self, limit: usize) -> Result<Vec<ProfileHistoryEntry>, StoreError> {
        let cap = limit.min(500) as i64;
        let conn = self.inner.lock().map_err(|_| {
            StoreError::Rusqlite(rusqlite::Error::InvalidQuery)
        })?;
        let mut stmt = conn.prepare(
            "SELECT id, version, json, saved_at \
             FROM profile_history \
             ORDER BY saved_at DESC \
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![cap], |row| {
            Ok(ProfileHistoryEntry {
                id: row.get(0)?,
                version: row.get(1)?,
                json: row.get(2)?,
                saved_at: row.get(3)?,
            })
        })?;
        let mut entries = Vec::new();
        for r in rows {
            entries.push(r?);
        }
        Ok(entries)
    }

    /// Roll back to a specific history entry identified by `history_id`.
    ///
    /// 1. Fetches the history row; returns `StoreError::NotFound` if absent.
    /// 2. Archives the current profile to history.
    /// 3. Restores the history row's JSON as the new current profile (fresh
    ///    version number).
    /// 4. Broadcasts the restored profile.
    pub fn rollback_to(&self, history_id: i64) -> Result<Value, StoreError> {
        let conn = self.inner.lock().map_err(|_| {
            StoreError::Rusqlite(rusqlite::Error::InvalidQuery)
        })?;

        // 1. Fetch the target history row.
        let hist_json: String = conn
            .query_row(
                "SELECT json FROM profile_history WHERE id = ?1",
                rusqlite::params![history_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(StoreError::NotFound(history_id))?;

        let ts = now_secs();

        // 2. Archive current profile.
        let existing: Option<(i64, String)> = conn
            .query_row(
                "SELECT version, json FROM profile WHERE id = 1",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let next_version = existing.as_ref().map(|(v, _)| v + 1).unwrap_or(1);

        if let Some((prev_version, prev_json)) = &existing {
            conn.execute(
                "INSERT INTO profile_history (version, json, saved_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![prev_version, prev_json, ts],
            )?;
        }

        // 3. UPSERT the restored profile.
        conn.execute(
            "INSERT OR REPLACE INTO profile (id, version, json, updated_at) VALUES (1, ?1, ?2, ?3)",
            rusqlite::params![next_version, hist_json, ts],
        )?;

        let restored: Value = serde_json::from_str(&hist_json)?;

        drop(conn);
        let _ = self.tx.send(restored.clone());
        Ok(restored)
    }

    // -----------------------------------------------------------------------
    // KV store
    // -----------------------------------------------------------------------

    /// Retrieve a value from the key-value store.  Returns `None` when the
    /// key does not exist.
    pub fn get_kv(&self, key: &str) -> Result<Option<String>, StoreError> {
        let conn = self.inner.lock().map_err(|_| {
            StoreError::Rusqlite(rusqlite::Error::InvalidQuery)
        })?;
        let result = conn
            .query_row(
                "SELECT value FROM kv_store WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(result)
    }

    /// Insert or replace a value in the key-value store.
    pub fn set_kv(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let ts = now_secs();
        let conn = self.inner.lock().map_err(|_| {
            StoreError::Rusqlite(rusqlite::Error::InvalidQuery)
        })?;
        conn.execute(
            "INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![key, value, ts],
        )?;
        Ok(())
    }
}

impl Default for ProfileStore {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    const TEST_KEY: [u8; 32] = [0x42u8; 32];

    /// Create a temporary directory and open a fresh `ProfileStore` inside it.
    fn tempdir_with_db(key: &[u8; 32]) -> (TempDir, ProfileStore) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("profile.db");
        let store = ProfileStore::open_at(&db_path, key).expect("open_at");
        (dir, store)
    }

    // 1
    #[test]
    fn open_new_db_returns_store() {
        let (_dir, store) = tempdir_with_db(&TEST_KEY);
        // Just getting here without panic/error is the assertion.
        let _ = store.get();
    }

    // 2
    #[test]
    fn get_returns_null_initially() {
        let (_dir, store) = tempdir_with_db(&TEST_KEY);
        assert_eq!(store.get(), Value::Null);
    }

    // 3
    #[test]
    fn set_then_get_round_trips_profile() {
        let (_dir, store) = tempdir_with_db(&TEST_KEY);
        let profile = json!({"sensory": {"fontScale": 1.25}});
        store.set(profile.clone());
        assert_eq!(store.get(), profile);
    }

    // 4
    #[test]
    fn set_pushes_prior_to_history() {
        let (_dir, store) = tempdir_with_db(&TEST_KEY);
        let v1 = json!({"a": 1});
        let v2 = json!({"a": 2});
        store.set(v1.clone());
        store.set(v2.clone());
        // After two sets, history should have one entry (the first set was
        // archived when the second arrived).
        let hist = store.list_versions(10).expect("list_versions");
        assert_eq!(hist.len(), 1);
        let parsed: Value = serde_json::from_str(&hist[0].json).expect("parse");
        assert_eq!(parsed, v1);
    }

    // 5
    #[test]
    fn list_versions_returns_newest_first() {
        let (_dir, store) = tempdir_with_db(&TEST_KEY);
        store.set(json!({"v": 1}));
        store.set(json!({"v": 2}));
        store.set(json!({"v": 3}));
        let hist = store.list_versions(10).expect("list_versions");
        // Two history entries (first two sets archived on subsequent set).
        assert_eq!(hist.len(), 2);
        // saved_at should be non-decreasing ordered newest first.
        assert!(hist[0].saved_at >= hist[1].saved_at);
    }

    // 6
    #[test]
    fn list_versions_respects_limit() {
        let (_dir, store) = tempdir_with_db(&TEST_KEY);
        for i in 0..10 {
            store.set(json!({"i": i}));
        }
        let hist = store.list_versions(3).expect("list_versions");
        assert!(hist.len() <= 3);
    }

    // 7
    #[test]
    fn rollback_to_restores_profile() {
        let (_dir, store) = tempdir_with_db(&TEST_KEY);
        let original = json!({"original": true});
        store.set(original.clone());
        store.set(json!({"replaced": true}));

        let hist = store.list_versions(10).expect("list_versions");
        assert!(!hist.is_empty());
        let history_id = hist[0].id;

        let restored = store.rollback_to(history_id).expect("rollback_to");
        assert_eq!(restored, original);
        assert_eq!(store.get(), original);
    }

    // 8
    #[test]
    fn rollback_to_unknown_id_errors() {
        let (_dir, store) = tempdir_with_db(&TEST_KEY);
        let result = store.rollback_to(99999);
        assert!(matches!(result, Err(StoreError::NotFound(99999))));
    }

    // 9
    #[test]
    fn kv_get_returns_none_for_unset_key() {
        let (_dir, store) = tempdir_with_db(&TEST_KEY);
        let val = store.get_kv("missing_key").expect("get_kv");
        assert!(val.is_none());
    }

    // 10
    #[test]
    fn kv_set_then_get_round_trips() {
        let (_dir, store) = tempdir_with_db(&TEST_KEY);
        store.set_kv("hello", "world").expect("set_kv");
        let val = store.get_kv("hello").expect("get_kv");
        assert_eq!(val.as_deref(), Some("world"));
    }

    // 11
    #[test]
    fn kv_set_overwrites_existing() {
        let (_dir, store) = tempdir_with_db(&TEST_KEY);
        store.set_kv("k", "v1").expect("set_kv");
        store.set_kv("k", "v2").expect("set_kv");
        let val = store.get_kv("k").expect("get_kv");
        assert_eq!(val.as_deref(), Some("v2"));
    }

    // 12
    #[test]
    fn kv_persists_across_reopen() {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("profile.db");
        {
            let store = ProfileStore::open_at(&db_path, &TEST_KEY).expect("open1");
            store.set_kv("persist_key", "persist_val").expect("set_kv");
        }
        // Reopen
        let store2 = ProfileStore::open_at(&db_path, &TEST_KEY).expect("open2");
        let val = store2.get_kv("persist_key").expect("get_kv");
        assert_eq!(val.as_deref(), Some("persist_val"));
    }

    // 13
    #[test]
    fn profile_persists_across_reopen_with_correct_key() {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("profile.db");
        let profile = json!({"persist": 42});
        {
            let store = ProfileStore::open_at(&db_path, &TEST_KEY).expect("open1");
            store.set(profile.clone());
        }
        let store2 = ProfileStore::open_at(&db_path, &TEST_KEY).expect("open2");
        assert_eq!(store2.get(), profile);
    }

    // 14
    #[test]
    fn reopen_with_wrong_key_fails_with_wrong_key_error() {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("profile.db");
        {
            // Create with correct key so the DB file exists with data.
            let store = ProfileStore::open_at(&db_path, &TEST_KEY).expect("create");
            store.set(json!({"init": true}));
        }
        // Now try to open with a different key.
        let wrong_key = [0x11u8; 32];
        let result = ProfileStore::open_at(&db_path, &wrong_key);
        assert!(
            matches!(result, Err(StoreError::WrongKey(_))),
            "expected WrongKey, got {result:?}"
        );
    }

    // 15
    #[tokio::test]
    async fn broadcast_fires_on_set() {
        let (_dir, store) = tempdir_with_db(&TEST_KEY);
        let mut sub = store.subscribe();
        let profile = json!({"broadcast": "set"});
        store.set(profile.clone());
        let received = sub.recv().await.expect("recv");
        assert_eq!(received, profile);
    }

    // 16
    #[tokio::test]
    async fn broadcast_fires_on_rollback() {
        let (_dir, store) = tempdir_with_db(&TEST_KEY);
        let original = json!({"original": "yes"});
        store.set(original.clone());
        store.set(json!({"second": "yes"}));

        let hist = store.list_versions(10).expect("list_versions");
        let history_id = hist[0].id;

        let mut sub = store.subscribe();
        let restored = store.rollback_to(history_id).expect("rollback_to");
        let received = sub.recv().await.expect("recv");
        assert_eq!(received, restored);
        assert_eq!(restored, original);
    }

    // 17
    #[test]
    fn kv_key_with_sql_metachars_is_safe() {
        let (_dir, store) = tempdir_with_db(&TEST_KEY);
        let evil_key = "a'; DROP TABLE kv_store; --";
        let value = "safe_value";
        // Insert with the SQL-metachar key — must not panic or corrupt.
        store.set_kv(evil_key, value).expect("set_kv with metachars");
        // Retrieve it back.
        let got = store.get_kv(evil_key).expect("get_kv with metachars");
        assert_eq!(got.as_deref(), Some(value));
        // Verify kv_store still exists by successfully inserting another key.
        store.set_kv("normal_key", "normal_val").expect("kv_store still exists");
        let normal = store.get_kv("normal_key").expect("get normal");
        assert_eq!(normal.as_deref(), Some("normal_val"));
    }

    // 18
    #[test]
    fn open_default_creates_parent_directory() {
        let dir = TempDir::new().expect("tempdir");
        // Override LOCALAPPDATA / HOME to point inside our tempdir so that
        // `platform_profile_db_path()` resolves to a path we can inspect.
        let fake_appdata = dir.path().join("FakeAppData");
        // On all platforms we set the env var that `platform_profile_db_path`
        // reads so the test is deterministic.
        #[cfg(windows)]
        std::env::set_var("LOCALAPPDATA", &fake_appdata);
        #[cfg(not(windows))]
        std::env::set_var("HOME", &fake_appdata);

        let expected_db = platform_profile_db_path();
        // The parent directory should NOT exist yet.
        assert!(!expected_db.parent().unwrap().exists());

        // open_default should create the parent.
        let _store = ProfileStore::open_default(&TEST_KEY).expect("open_default");

        // Parent directory must now exist.
        assert!(expected_db.parent().unwrap().exists());

        // Restore env (best effort; tests run in same process).
        #[cfg(windows)]
        std::env::remove_var("LOCALAPPDATA");
        #[cfg(not(windows))]
        std::env::remove_var("HOME");
    }
}
