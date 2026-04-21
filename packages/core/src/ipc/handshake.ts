/**
 * PSK-based handshake. Agent drops a JSON file at
 * %LOCALAPPDATA%\AccessBridge\pair.key containing:
 *   { version: 1, createdAt: <unix-secs>, pskB64: <url-safe-base64-no-padding> }
 *
 * The extension reads the PSK (via the popup's "Pair with agent" dialog, where
 * the user pastes the key) and the agent verifies sha256(psk || nonce) during
 * the WS handshake. Loopback-only WS + PSK = defense in depth against other
 * local processes impersonating either side.
 */

export interface PairKeyFile {
  version: 1;
  createdAt: number;
  pskB64: string;
}

export function parsePairKeyFile(raw: string): PairKeyFile {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid pair key: not an object');
  if (parsed.version !== 1) throw new Error(`invalid pair key: version ${parsed.version} (want 1)`);
  if (typeof parsed.createdAt !== 'number') throw new Error('invalid pair key: createdAt missing');
  if (typeof parsed.pskB64 !== 'string') throw new Error('invalid pair key: pskB64 missing');
  return parsed as PairKeyFile;
}

/** Decode URL-safe base64 (no padding) to bytes. */
export function base64UrlDecode(s: string): Uint8Array {
  let padded = s.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4 !== 0) padded += '=';
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Compute sha256(psk || nonce) as hex. Matches the Rust agent's psk_hash.
 * Uses SubtleCrypto in SW/browser; throws if unavailable.
 */
export async function pskHash(psk: Uint8Array, nonce: Uint8Array): Promise<string> {
  const buf = new Uint8Array(psk.length + nonce.length);
  buf.set(psk, 0);
  buf.set(nonce, psk.length);
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('SubtleCrypto unavailable — required for PSK handshake');
  }
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Cryptographically strong random nonce, URL-safe base64. */
export function generateNonce(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}
