import type { AccessibilityProfile } from '../types/profile.js';
import { DEFAULT_PROFILE } from '../types/profile.js';

const DB_NAME = 'accessbridge-profile';
const STORE_NAME = 'profiles';
const DB_VERSION = 1;
const ENCRYPTION_KEY_NAME = 'accessbridge-profile-key';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getOrCreateEncryptionKey(): Promise<CryptoKey> {
  const stored = sessionStorage.getItem(ENCRYPTION_KEY_NAME);
  if (stored) {
    const raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, [
      'encrypt',
      'decrypt',
    ]);
  }

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );

  const exported = await crypto.subtle.exportKey('raw', key);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
  sessionStorage.setItem(ENCRYPTION_KEY_NAME, b64);

  return key;
}

async function encrypt(
  data: string,
  key: CryptoKey,
): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded,
  );

  return {
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
  };
}

async function decrypt(
  iv: string,
  ciphertext: string,
  key: CryptoKey,
): Promise<string> {
  const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
  const ciphertextBytes = Uint8Array.from(atob(ciphertext), (c) =>
    c.charCodeAt(0),
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes },
    key,
    ciphertextBytes,
  );

  return new TextDecoder().decode(decrypted);
}

export class ProfileStore {
  private db: IDBDatabase | null = null;
  private encryptionKey: CryptoKey | null = null;

  async init(): Promise<void> {
    this.db = await openDB();
    this.encryptionKey = await getOrCreateEncryptionKey();
  }

  private ensureInitialized(): { db: IDBDatabase; key: CryptoKey } {
    if (!this.db || !this.encryptionKey) {
      throw new Error(
        'ProfileStore not initialized. Call init() before using the store.',
      );
    }
    return { db: this.db, key: this.encryptionKey };
  }

  async getProfile(id = 'default'): Promise<AccessibilityProfile> {
    const { db } = this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onsuccess = () => {
        resolve(
          request.result
            ? (request.result as AccessibilityProfile)
            : { ...DEFAULT_PROFILE, id },
        );
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveProfile(profile: AccessibilityProfile): Promise<void> {
    const { db } = this.ensureInitialized();
    const updated: AccessibilityProfile = {
      ...profile,
      updatedAt: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(updated);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async exportProfile(id = 'default'): Promise<string> {
    const { key } = this.ensureInitialized();
    const profile = await this.getProfile(id);
    const json = JSON.stringify(profile);
    const encrypted = await encrypt(json, key);
    return JSON.stringify(encrypted);
  }

  async importProfile(encrypted: string): Promise<AccessibilityProfile> {
    const { key } = this.ensureInitialized();
    const { iv, ciphertext } = JSON.parse(encrypted) as {
      iv: string;
      ciphertext: string;
    };
    const json = await decrypt(iv, ciphertext, key);
    const profile = JSON.parse(json) as AccessibilityProfile;
    await this.saveProfile(profile);
    return profile;
  }

  async clearProfile(id = 'default'): Promise<void> {
    const { db } = this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}
