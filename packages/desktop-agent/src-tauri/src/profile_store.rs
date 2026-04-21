//! In-memory AccessibilityProfile store.
//!
//! Phase 2 will migrate this to SQLCipher under %LOCALAPPDATA%\AccessBridge\.
//! For MVP, the profile lives only in agent process memory and is re-synced
//! from the extension at each handshake.

use serde_json::Value;
use std::sync::{Arc, RwLock};
use tokio::sync::broadcast;

pub type ProfileSubscriber = broadcast::Receiver<Value>;

#[derive(Clone)]
pub struct ProfileStore {
    inner: Arc<RwLock<Value>>,
    tx: broadcast::Sender<Value>,
}

impl ProfileStore {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(16);
        ProfileStore {
            inner: Arc::new(RwLock::new(Value::Null)),
            tx,
        }
    }

    pub fn get(&self) -> Value {
        self.inner.read().map(|g| g.clone()).unwrap_or(Value::Null)
    }

    pub fn set(&self, profile: Value) -> Value {
        if let Ok(mut g) = self.inner.write() {
            *g = profile.clone();
        }
        let _ = self.tx.send(profile.clone());
        profile
    }

    pub fn subscribe(&self) -> ProfileSubscriber {
        self.tx.subscribe()
    }
}

impl Default for ProfileStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn get_returns_null_initially() {
        let store = ProfileStore::new();
        assert_eq!(store.get(), Value::Null);
    }

    #[tokio::test]
    async fn set_updates_stored_value_and_broadcasts() {
        let store = ProfileStore::new();
        let mut sub = store.subscribe();
        let profile = json!({"sensory": {"fontScale": 1.25}});
        store.set(profile.clone());
        assert_eq!(store.get(), profile);
        let received = sub.recv().await.expect("recv");
        assert_eq!(received, profile);
    }

    #[tokio::test]
    async fn multiple_subscribers_each_receive() {
        let store = ProfileStore::new();
        let mut s1 = store.subscribe();
        let mut s2 = store.subscribe();
        store.set(json!({"a": 1}));
        assert_eq!(s1.recv().await.unwrap(), json!({"a": 1}));
        assert_eq!(s2.recv().await.unwrap(), json!({"a": 1}));
    }

    #[tokio::test]
    async fn set_returns_echoed_value() {
        let store = ProfileStore::new();
        let v = json!({"k": 1});
        assert_eq!(store.set(v.clone()), v);
    }
}
