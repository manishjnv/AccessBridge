import { describe, it, expect } from 'vitest';
import {
  parsePairKeyFile,
  base64UrlEncode,
  base64UrlDecode,
  pskHash,
  generateNonce,
} from '../handshake.js';

const subtleCryptoAvailable = typeof crypto !== 'undefined' && !!crypto.subtle;

describe('parsePairKeyFile', () => {
  it('accepts a valid JSON pair key file', () => {
    const raw = JSON.stringify({ version: 1, createdAt: 1700000000, pskB64: 'abc-def_xyz' });
    const parsed = parsePairKeyFile(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.createdAt).toBe(1700000000);
    expect(parsed.pskB64).toBe('abc-def_xyz');
  });

  it('rejects wrong version', () => {
    const raw = JSON.stringify({ version: 2, createdAt: 1700000000, pskB64: 'abc' });
    expect(() => parsePairKeyFile(raw)).toThrow('version 2');
  });

  it('rejects missing createdAt', () => {
    const raw = JSON.stringify({ version: 1, pskB64: 'abc' });
    expect(() => parsePairKeyFile(raw)).toThrow('createdAt missing');
  });

  it('rejects missing pskB64', () => {
    const raw = JSON.stringify({ version: 1, createdAt: 1700000000 });
    expect(() => parsePairKeyFile(raw)).toThrow('pskB64 missing');
  });

  it('rejects non-object JSON', () => {
    expect(() => parsePairKeyFile('"just a string"')).toThrow('not an object');
  });

  it('rejects non-JSON input', () => {
    expect(() => parsePairKeyFile('not json at all')).toThrow();
  });
});

describe('base64Url round-trip', () => {
  it('encodes and decodes a 50-byte random array', () => {
    const input = new Uint8Array(50);
    for (let i = 0; i < input.length; i++) input[i] = Math.floor(Math.random() * 256);
    const encoded = base64UrlEncode(input);
    const decoded = base64UrlDecode(encoded);
    expect(decoded).toEqual(input);
  });

  it('handles all 256 byte values', () => {
    const input = Uint8Array.from({ length: 256 }, (_, i) => i);
    const encoded = base64UrlEncode(input);
    const decoded = base64UrlDecode(encoded);
    expect(decoded).toEqual(input);
  });
});

describe('pskHash', () => {
  it.runIf(subtleCryptoAvailable)('is deterministic for fixed inputs', async () => {
    const psk = new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    ]);
    const nonce = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]);
    // Compute the expected hash in-test via SubtleCrypto, then assert the function matches
    const buf = new Uint8Array(psk.length + nonce.length);
    buf.set(psk, 0);
    buf.set(nonce, psk.length);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const expected = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const result = await pskHash(psk, nonce);
    expect(result).toBe(expected);
    // Sanity: SHA-256 hex is 64 chars
    expect(result).toHaveLength(64);
  });

  it.runIf(subtleCryptoAvailable)('differs when nonce differs', async () => {
    const psk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const nonce1 = new Uint8Array([1, 1, 1, 1]);
    const nonce2 = new Uint8Array([2, 2, 2, 2]);
    const h1 = await pskHash(psk, nonce1);
    const h2 = await pskHash(psk, nonce2);
    expect(h1).not.toBe(h2);
  });
});

describe('generateNonce', () => {
  it.runIf(subtleCryptoAvailable)('returns distinct values', () => {
    const a = generateNonce(16);
    const b = generateNonce(16);
    expect(a).not.toBe(b);
  });

  it.runIf(subtleCryptoAvailable)('decodes to the requested byte length', () => {
    for (const len of [8, 16, 32]) {
      const encoded = generateNonce(len);
      const decoded = base64UrlDecode(encoded);
      expect(decoded.length).toBe(len);
    }
  });
});
