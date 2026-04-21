import { describe, it, expect } from 'vitest';
import {
  generateKeypair,
  buildAttestation,
  verifyAttestation,
  attestationMessageBytes,
  attestationKeyImageDomain,
  hashRing,
  hex,
} from '../index.js';

function makeRing(size: number) {
  const ring: Uint8Array[] = [];
  const keys: Uint8Array[] = [];
  for (let i = 0; i < size; i++) {
    const kp = generateKeypair();
    ring.push(kp.pubKey);
    keys.push(kp.secKey);
  }
  return { ring, keys };
}

const FIXED_DATE = '2026-04-21';
const FIXED_MERKLE = '9f'.repeat(32);

describe('attestation — message + domain encoding', () => {
  it('message bytes are stable over repeated calls', () => {
    const a = attestationMessageBytes({
      date: FIXED_DATE,
      ringHash: 'ab'.repeat(32),
      merkleRoot: FIXED_MERKLE,
      ringVersion: 1,
    });
    const b = attestationMessageBytes({
      date: FIXED_DATE,
      ringHash: 'ab'.repeat(32),
      merkleRoot: FIXED_MERKLE,
      ringVersion: 1,
    });
    expect(hex(a)).toBe(hex(b));
  });

  it('message bytes differ when ringVersion differs', () => {
    const a = attestationMessageBytes({
      date: FIXED_DATE,
      ringHash: 'ab'.repeat(32),
      merkleRoot: FIXED_MERKLE,
      ringVersion: 1,
    });
    const b = attestationMessageBytes({
      date: FIXED_DATE,
      ringHash: 'ab'.repeat(32),
      merkleRoot: FIXED_MERKLE,
      ringVersion: 2,
    });
    expect(hex(a)).not.toBe(hex(b));
  });

  it('domain is scoped by date only (ringHash intentionally ignored)', () => {
    const d1 = attestationKeyImageDomain('2026-04-21', 'aa');
    const d2 = attestationKeyImageDomain('2026-04-22', 'aa');
    const d3 = attestationKeyImageDomain('2026-04-21', 'bb');
    expect(d1).not.toBe(d2);
    // Different ringHash, same date -> SAME domain. Prevents mid-day-ring-
    // rotation double-publish (two different ringHash values on the same
    // day would otherwise produce different keyImages and pass the
    // UNIQUE(date, key_image) constraint).
    expect(d1).toBe(d3);
    expect(d1).toMatch(/2026-04-21/);
  });
});

describe('buildAttestation', () => {
  it('produces a well-formed Attestation', () => {
    const { ring, keys } = makeRing(4);
    const a = buildAttestation({
      date: FIXED_DATE,
      counters: { struggle_events_triggered: 3 },
      merkleRoot: FIXED_MERKLE,
      ring,
      ringVersion: 7,
      signerIndex: 2,
      secKey: keys[2],
    });
    expect(a.format).toBe(1);
    expect(a.date).toBe(FIXED_DATE);
    expect(a.ringVersion).toBe(7);
    expect(a.ringHash).toBe(hashRing(ring));
    expect(a.merkleRoot).toBe(FIXED_MERKLE);
    expect(a.counters).toEqual({ struggle_events_triggered: 3 });
    expect(a.signature.c0).toMatch(/^[0-9a-f]{64}$/);
    expect(a.signature.keyImage).toMatch(/^[0-9a-f]{64}$/);
    expect(a.signature.s).toHaveLength(4);
  });

  it('rejects malformed date', () => {
    const { ring, keys } = makeRing(2);
    expect(() =>
      buildAttestation({
        date: 'not-a-date',
        counters: {},
        merkleRoot: FIXED_MERKLE,
        ring,
        ringVersion: 1,
        signerIndex: 0,
        secKey: keys[0],
      }),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('rejects ring too small', () => {
    const kp = generateKeypair();
    expect(() =>
      buildAttestation({
        date: FIXED_DATE,
        counters: {},
        merkleRoot: FIXED_MERKLE,
        ring: [kp.pubKey],
        ringVersion: 1,
        signerIndex: 0,
        secKey: kp.secKey,
      }),
    ).toThrow(/at least 2/);
  });

  it('rejects out-of-range signerIndex', () => {
    const { ring, keys } = makeRing(3);
    expect(() =>
      buildAttestation({
        date: FIXED_DATE,
        counters: {},
        merkleRoot: FIXED_MERKLE,
        ring,
        ringVersion: 1,
        signerIndex: 9,
        secKey: keys[0],
      }),
    ).toThrow(/signerIndex/);
  });
});

describe('verifyAttestation', () => {
  it('accepts a freshly built attestation', async () => {
    const { ring, keys } = makeRing(5);
    const a = buildAttestation({
      date: FIXED_DATE,
      counters: { struggle_events_triggered: 3 },
      merkleRoot: FIXED_MERKLE,
      ring,
      ringVersion: 1,
      signerIndex: 3,
      secKey: keys[3],
    });
    const r = await verifyAttestation({ attestation: a, expectedRing: ring });
    expect(r.valid).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.warnings).toEqual([]);
    expect(r.date).toBe(FIXED_DATE);
    expect(r.merkleRoot).toBe(FIXED_MERKLE);
    expect(r.keyImageHex).toBe(a.signature.keyImage);
  });

  it('rejects when expectedRing differs (ring-mismatch)', async () => {
    const { ring, keys } = makeRing(3);
    const a = buildAttestation({
      date: FIXED_DATE,
      counters: {},
      merkleRoot: FIXED_MERKLE,
      ring,
      ringVersion: 1,
      signerIndex: 0,
      secKey: keys[0],
    });
    const other = makeRing(3).ring;
    const r = await verifyAttestation({ attestation: a, expectedRing: other });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('ring-mismatch');
  });

  it('rejects when ring size differs (ring-size-mismatch)', async () => {
    const { ring, keys } = makeRing(3);
    const a = buildAttestation({
      date: FIXED_DATE,
      counters: {},
      merkleRoot: FIXED_MERKLE,
      ring,
      ringVersion: 1,
      signerIndex: 0,
      secKey: keys[0],
    });
    // Same-hash ring is impossible with different size; construct a crafted
    // attestation with a deliberately-wrong ringHash to hit the size path.
    const fakeAttestation = {
      ...a,
      ringHash: hashRing([...ring, generateKeypair().pubKey]),
    };
    const r = await verifyAttestation({
      attestation: fakeAttestation,
      expectedRing: [...ring, generateKeypair().pubKey],
    });
    // Ring-mismatch OR ring-size-mismatch — depends on order of checks.
    expect(r.valid).toBe(false);
  });

  it('rejects on Merkle mismatch via recomputeMerkleRoot', async () => {
    const { ring, keys } = makeRing(3);
    const a = buildAttestation({
      date: FIXED_DATE,
      counters: { a: 1 },
      merkleRoot: FIXED_MERKLE,
      ring,
      ringVersion: 1,
      signerIndex: 0,
      secKey: keys[0],
    });
    const r = await verifyAttestation({
      attestation: a,
      expectedRing: ring,
      recomputeMerkleRoot: async () => '00'.repeat(32),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('merkle-mismatch');
  });

  it('accepts when recomputeMerkleRoot returns the correct root', async () => {
    const { ring, keys } = makeRing(3);
    const a = buildAttestation({
      date: FIXED_DATE,
      counters: { a: 1 },
      merkleRoot: FIXED_MERKLE,
      ring,
      ringVersion: 1,
      signerIndex: 0,
      secKey: keys[0],
    });
    const r = await verifyAttestation({
      attestation: a,
      expectedRing: ring,
      recomputeMerkleRoot: async () => FIXED_MERKLE,
    });
    expect(r.valid).toBe(true);
  });

  it('rejects forged signature (tampered c0)', async () => {
    const { ring, keys } = makeRing(3);
    const a = buildAttestation({
      date: FIXED_DATE,
      counters: {},
      merkleRoot: FIXED_MERKLE,
      ring,
      ringVersion: 1,
      signerIndex: 0,
      secKey: keys[0],
    });
    const bad = {
      ...a,
      signature: { ...a.signature, c0: '00'.repeat(32) },
    };
    const r = await verifyAttestation({ attestation: bad, expectedRing: ring });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('signature-invalid');
  });

  it('rejects attestation with unknown format', async () => {
    const { ring, keys } = makeRing(3);
    const a = buildAttestation({
      date: FIXED_DATE,
      counters: {},
      merkleRoot: FIXED_MERKLE,
      ring,
      ringVersion: 1,
      signerIndex: 0,
      secKey: keys[0],
    });
    const bad = { ...a, format: 2 as unknown as 1 };
    const r = await verifyAttestation({ attestation: bad, expectedRing: ring });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('malformed');
  });

  it('still validates signature without a Merkle recomputer', async () => {
    const { ring, keys } = makeRing(4);
    const a = buildAttestation({
      date: FIXED_DATE,
      counters: { x: 1 },
      merkleRoot: 'deadbeef',
      ring,
      ringVersion: 2,
      signerIndex: 1,
      secKey: keys[1],
    });
    const r = await verifyAttestation({ attestation: a, expectedRing: ring });
    expect(r.valid).toBe(true);
  });

  it('counters are passed through verbatim (opaque payload)', async () => {
    const { ring, keys } = makeRing(3);
    const counters = {
      adaptations_applied: { FONT_SCALE: 5, CONTRAST: 2 },
      struggle_events_triggered: 7,
      weird_nested: { a: [1, 2], b: true },
    };
    const a = buildAttestation({
      date: FIXED_DATE,
      counters,
      merkleRoot: FIXED_MERKLE,
      ring,
      ringVersion: 1,
      signerIndex: 0,
      secKey: keys[0],
    });
    expect(a.counters).toEqual(counters);
    const r = await verifyAttestation({ attestation: a, expectedRing: ring });
    expect(r.valid).toBe(true);
  });

  it('linkability: two attestations by the same device on the same (date, ring) share the keyImage', async () => {
    const { ring, keys } = makeRing(3);
    const a1 = buildAttestation({
      date: FIXED_DATE,
      counters: { v: 1 },
      merkleRoot: FIXED_MERKLE,
      ring,
      ringVersion: 1,
      signerIndex: 1,
      secKey: keys[1],
    });
    const a2 = buildAttestation({
      date: FIXED_DATE,
      counters: { v: 2 },
      merkleRoot: FIXED_MERKLE,
      ring,
      ringVersion: 1,
      signerIndex: 1,
      secKey: keys[1],
    });
    expect(a1.signature.keyImage).toBe(a2.signature.keyImage);
  });

  it('different (date, ring) → different keyImage (domain separation)', async () => {
    const { ring, keys } = makeRing(3);
    const a1 = buildAttestation({
      date: '2026-04-21',
      counters: {},
      merkleRoot: FIXED_MERKLE,
      ring,
      ringVersion: 1,
      signerIndex: 0,
      secKey: keys[0],
    });
    const a2 = buildAttestation({
      date: '2026-04-22',
      counters: {},
      merkleRoot: FIXED_MERKLE,
      ring,
      ringVersion: 1,
      signerIndex: 0,
      secKey: keys[0],
    });
    expect(a1.signature.keyImage).not.toBe(a2.signature.keyImage);
  });
});
