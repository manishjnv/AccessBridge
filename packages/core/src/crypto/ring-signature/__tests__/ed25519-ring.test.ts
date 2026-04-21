import { describe, it, expect } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils';
import {
  generateKeypair,
  deriveKeyImage,
  sign,
  verify,
  hashRing,
  sigToHex,
  sigFromHex,
  hex,
  unhex,
} from '../ed25519-ring.js';

const MSG = utf8ToBytes('accessbridge-test-message');
const DOMAIN_A = 'accessbridge-test:2026-04-21:ringA';
const DOMAIN_B = 'accessbridge-test:2026-04-21:ringB';

function makeRing(size: number): { ring: Uint8Array[]; keys: Uint8Array[] } {
  const ring: Uint8Array[] = [];
  const keys: Uint8Array[] = [];
  for (let i = 0; i < size; i++) {
    const kp = generateKeypair();
    ring.push(kp.pubKey);
    keys.push(kp.secKey);
  }
  return { ring, keys };
}

describe('SAG ring signature — key generation', () => {
  it('produces 32-byte public + secret keys', () => {
    const kp = generateKeypair();
    expect(kp.pubKey).toBeInstanceOf(Uint8Array);
    expect(kp.secKey).toBeInstanceOf(Uint8Array);
    expect(kp.pubKey.length).toBe(32);
    expect(kp.secKey.length).toBe(32);
  });

  it('two calls produce distinct keypairs (sanity for RNG)', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(hex(a.pubKey)).not.toBe(hex(b.pubKey));
    expect(hex(a.secKey)).not.toBe(hex(b.secKey));
  });
});

describe('SAG ring signature — hex helpers', () => {
  it('hex/unhex round-trip', () => {
    const bytes = new Uint8Array([0x00, 0xde, 0xad, 0xbe, 0xef, 0xff]);
    expect(hex(bytes)).toBe('00deadbeefff');
    expect(Array.from(unhex('00deadbeefff'))).toEqual(Array.from(bytes));
  });

  it('hex output is always lowercase', () => {
    const bytes = new Uint8Array([0xab, 0xcd, 0xef]);
    expect(hex(bytes)).toBe(hex(bytes).toLowerCase());
  });
});

describe('SAG ring signature — hashRing', () => {
  it('is deterministic', () => {
    const { ring } = makeRing(4);
    expect(hashRing(ring)).toBe(hashRing(ring));
  });

  it('order-sensitive (ring is a sequence, not a set)', () => {
    const { ring } = makeRing(3);
    const reversed = [...ring].reverse();
    expect(hashRing(ring)).not.toBe(hashRing(reversed));
  });

  it('returns 64-char hex', () => {
    const { ring } = makeRing(2);
    expect(hashRing(ring)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects non-32-byte members', () => {
    expect(() => hashRing([new Uint8Array(31)])).toThrow();
  });
});

describe('SAG ring signature — sign + verify round trip', () => {
  it('works for ring size 2', () => {
    const { ring, keys } = makeRing(2);
    const sig = sign(MSG, ring, 0, keys[0], DOMAIN_A);
    expect(verify(MSG, ring, sig, DOMAIN_A)).toBe(true);
  });

  it('works for ring size 3, signer at every index', () => {
    const { ring, keys } = makeRing(3);
    for (let pi = 0; pi < 3; pi++) {
      const sig = sign(MSG, ring, pi, keys[pi], DOMAIN_A);
      expect(verify(MSG, ring, sig, DOMAIN_A)).toBe(true);
    }
  });

  it('works for ring size 8', () => {
    const { ring, keys } = makeRing(8);
    const sig = sign(MSG, ring, 5, keys[5], DOMAIN_A);
    expect(verify(MSG, ring, sig, DOMAIN_A)).toBe(true);
  });

  it('works for ring size 32', () => {
    const { ring, keys } = makeRing(32);
    const sig = sign(MSG, ring, 17, keys[17], DOMAIN_A);
    expect(verify(MSG, ring, sig, DOMAIN_A)).toBe(true);
  });

  it('signature response-vector length equals ring size', () => {
    const { ring, keys } = makeRing(5);
    const sig = sign(MSG, ring, 2, keys[2], DOMAIN_A);
    expect(sig.s.length).toBe(5);
    expect(sig.c0.length).toBe(32);
    expect(sig.keyImage.length).toBe(32);
    for (const s_i of sig.s) expect(s_i.length).toBe(32);
  });
});

describe('SAG ring signature — tampering rejection', () => {
  it('tampered message fails verify', () => {
    const { ring, keys } = makeRing(3);
    const sig = sign(MSG, ring, 0, keys[0], DOMAIN_A);
    const tampered = utf8ToBytes('different-message');
    expect(verify(tampered, ring, sig, DOMAIN_A)).toBe(false);
  });

  it('tampered ring (pubkey swap) fails verify', () => {
    const { ring, keys } = makeRing(4);
    const sig = sign(MSG, ring, 1, keys[1], DOMAIN_A);
    const tamperedRing = [...ring];
    const outsider = generateKeypair();
    tamperedRing[2] = outsider.pubKey;
    expect(verify(MSG, tamperedRing, sig, DOMAIN_A)).toBe(false);
  });

  it('tampered domain fails verify', () => {
    const { ring, keys } = makeRing(3);
    const sig = sign(MSG, ring, 0, keys[0], DOMAIN_A);
    expect(verify(MSG, ring, sig, DOMAIN_B)).toBe(false);
  });

  it('bit-flipped c0 fails verify', () => {
    const { ring, keys } = makeRing(3);
    const sig = sign(MSG, ring, 0, keys[0], DOMAIN_A);
    const bad = { ...sig, c0: new Uint8Array(sig.c0) };
    bad.c0[0] ^= 0x01;
    expect(verify(MSG, ring, bad, DOMAIN_A)).toBe(false);
  });

  it('bit-flipped s[k] fails verify', () => {
    const { ring, keys } = makeRing(4);
    const sig = sign(MSG, ring, 2, keys[2], DOMAIN_A);
    const bad = { ...sig, s: sig.s.map((b) => new Uint8Array(b)) };
    bad.s[1][5] ^= 0x10;
    expect(verify(MSG, ring, bad, DOMAIN_A)).toBe(false);
  });

  it('replaced keyImage fails verify (different keypair)', () => {
    const { ring, keys } = makeRing(3);
    const sig = sign(MSG, ring, 0, keys[0], DOMAIN_A);
    const otherImage = deriveKeyImage(generateKeypair().secKey, DOMAIN_A);
    expect(verify(MSG, ring, { ...sig, keyImage: otherImage }, DOMAIN_A)).toBe(false);
  });
});

describe('SAG ring signature — non-member rejection', () => {
  it('non-member signing fails (signer public key not in ring)', () => {
    const { ring } = makeRing(3);
    const outsider = generateKeypair();
    // Sign attempt lies about signerIndex → our eager consistency check
    // inside sign() detects the mismatch and throws before producing a sig.
    expect(() => sign(MSG, ring, 0, outsider.secKey, DOMAIN_A)).toThrow(
      /ring\[signerIndex\]/,
    );
  });
});

describe('SAG ring signature — linkability (key image)', () => {
  it('same device + same domain → same key image', () => {
    const kp = generateKeypair();
    const ki1 = deriveKeyImage(kp.secKey, DOMAIN_A);
    const ki2 = deriveKeyImage(kp.secKey, DOMAIN_A);
    expect(hex(ki1)).toBe(hex(ki2));
  });

  it('same device + different domain → different key images (domain separation)', () => {
    const kp = generateKeypair();
    const kiA = deriveKeyImage(kp.secKey, DOMAIN_A);
    const kiB = deriveKeyImage(kp.secKey, DOMAIN_B);
    expect(hex(kiA)).not.toBe(hex(kiB));
  });

  it('different devices + same domain → different key images', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(hex(deriveKeyImage(a.secKey, DOMAIN_A))).not.toBe(
      hex(deriveKeyImage(b.secKey, DOMAIN_A)),
    );
  });

  it('signing twice on the same domain yields the SAME keyImage inside the sig', () => {
    const { ring, keys } = makeRing(3);
    const sig1 = sign(MSG, ring, 1, keys[1], DOMAIN_A);
    const sig2 = sign(MSG, ring, 1, keys[1], DOMAIN_A);
    expect(hex(sig1.keyImage)).toBe(hex(sig2.keyImage));
    // Both valid, different s/c0 (random alpha).
    expect(verify(MSG, ring, sig1, DOMAIN_A)).toBe(true);
    expect(verify(MSG, ring, sig2, DOMAIN_A)).toBe(true);
    expect(hex(sig1.c0)).not.toBe(hex(sig2.c0));
  });
});

describe('SAG ring signature — invariants & bad input', () => {
  it('sign throws on ring size 1', () => {
    const kp = generateKeypair();
    expect(() => sign(MSG, [kp.pubKey], 0, kp.secKey, DOMAIN_A)).toThrow(
      /at least 2/,
    );
  });

  it('sign throws on out-of-range signerIndex', () => {
    const { ring, keys } = makeRing(3);
    expect(() => sign(MSG, ring, 9, keys[0], DOMAIN_A)).toThrow(/signerIndex/);
    expect(() => sign(MSG, ring, -1, keys[0], DOMAIN_A)).toThrow(/signerIndex/);
  });

  it('sign throws on signerIndex not matching secKey', () => {
    const { ring, keys } = makeRing(3);
    // keys[0] at index 1 → pubkey mismatch
    expect(() => sign(MSG, ring, 1, keys[0], DOMAIN_A)).toThrow(
      /ring\[signerIndex\]/,
    );
  });

  it('sign throws on invalid ring pubkey bytes', () => {
    const kp = generateKeypair();
    const bad = [kp.pubKey, new Uint8Array(32)]; // all-zero is not a valid Ristretto encoding of a non-identity point; fromHex of all-zero IS valid (identity), so use random noise
    const junk = new Uint8Array(32);
    junk.fill(0xff);
    expect(() => sign(MSG, [kp.pubKey, junk], 0, kp.secKey, DOMAIN_A)).toThrow();
  });

  it('sigToHex / sigFromHex round-trip', () => {
    const { ring, keys } = makeRing(3);
    const sig = sign(MSG, ring, 0, keys[0], DOMAIN_A);
    const h = sigToHex(sig);
    const sig2 = sigFromHex(h);
    expect(hex(sig2.c0)).toBe(hex(sig.c0));
    expect(hex(sig2.keyImage)).toBe(hex(sig.keyImage));
    for (let i = 0; i < sig.s.length; i++) {
      expect(hex(sig2.s[i])).toBe(hex(sig.s[i]));
    }
    expect(verify(MSG, ring, sig2, DOMAIN_A)).toBe(true);
  });

  it('sigFromHex rejects wrong-length c0', () => {
    expect(() =>
      sigFromHex({ c0: 'abcd', s: [], keyImage: '00'.repeat(32) }),
    ).toThrow(/c0/);
  });

  it('sigFromHex rejects wrong-length keyImage', () => {
    expect(() =>
      sigFromHex({ c0: '00'.repeat(32), s: [], keyImage: 'deadbeef' }),
    ).toThrow(/keyImage/);
  });

  it('sigFromHex rejects non-array s', () => {
    expect(() =>
      sigFromHex({
        c0: '00'.repeat(32),
        // @ts-expect-error — testing runtime type guard
        s: 'oops',
        keyImage: '00'.repeat(32),
      }),
    ).toThrow(/s must be/);
  });

  it('verify returns false (not throws) on malformed signature', () => {
    const { ring } = makeRing(3);
    const bad = {
      c0: new Uint8Array(31), // wrong length
      s: [new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)],
      keyImage: new Uint8Array(32),
    };
    expect(verify(MSG, ring, bad, DOMAIN_A)).toBe(false);
  });

  it('verify returns false on mismatched s.length vs ring.length', () => {
    const { ring, keys } = makeRing(3);
    const sig = sign(MSG, ring, 0, keys[0], DOMAIN_A);
    expect(verify(MSG, [...ring, generateKeypair().pubKey], sig, DOMAIN_A)).toBe(
      false,
    );
  });
});
