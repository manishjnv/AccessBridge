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
}
