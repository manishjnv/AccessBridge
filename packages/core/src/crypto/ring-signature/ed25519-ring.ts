/**
 * SAG (Spontaneous Anonymous Group) linkable ring signature — Abe-Ohkubo-Suzuki
 * variant, implemented over Ristretto255.
 *
 * Why Ristretto255 (not raw ed25519 ExtendedPoint):
 *   @noble/curves' own docs flag ExtendedPoint as "a source of bugs for
 *   protocols like ring signatures" because each ed25519 point has 8
 *   torsion-equivalent representations. Ristretto255 wraps the same
 *   Curve25519 arithmetic into a prime-order group where every point has
 *   a unique 32-byte encoding, eliminating the cofactor-malleability
 *   footguns that historically broke naive ring-signature constructions.
 *
 * Security notes (see docs/features/zero-knowledge-attestation.md for the
 * full threat model):
 *   - All randomness comes from crypto.getRandomValues via @noble/curves
 *     (ed25519.utils.randomPrivateKey). Math.random is never used.
 *   - BigInt arithmetic in V8 is NOT constant-time. An attacker who can
 *     observe per-operation timing locally may learn bits of the signer's
 *     scalar. Acceptable for attestation over public daily counters — the
 *     signer's identity is the only secret, and the attestation server does
 *     not observe signing. Not acceptable for high-stakes anonymity
 *     (e.g. currency mixing) without native-code hardening.
 *   - Hash-to-point uses try-and-increment over sha512 output, domain-
 *     tagged. Input is always public (domain = date + ringHash), so timing
 *     depends only on public values — no secret-dependent branch.
 *   - The challenge hash includes the key image I in every step. This gives
 *     per-signer domain separation and hardens against cross-ring mixing.
 */

import { ed25519, RistrettoPoint } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import {
  bytesToHex,
  hexToBytes,
  concatBytes,
  utf8ToBytes,
} from '@noble/hashes/utils';
import type { KeyPair, SAGSignature, SAGSignatureHex } from './types.js';

type Point = InstanceType<typeof RistrettoPoint>;

const CURVE_L: bigint = ed25519.CURVE.n;
const SCALAR_BYTES = 32;
const MAX_HTP_COUNTER = 256;

const DOMAIN_SCALAR_PREFIX = utf8ToBytes('accessbridge-scalar-v1:');
const DOMAIN_HTP_PREFIX = 'accessbridge-htp-v1:';

// ---------- Encoding helpers ----------

export function hex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

export function unhex(s: string): Uint8Array {
  return hexToBytes(s);
}

function scalarToBytes(x: bigint): Uint8Array {
  const normalized = ((x % CURVE_L) + CURVE_L) % CURVE_L;
  const out = new Uint8Array(SCALAR_BYTES);
  let v = normalized;
  for (let i = 0; i < SCALAR_BYTES; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function bytesToScalar(b: Uint8Array): bigint {
  if (b.length !== SCALAR_BYTES) {
    throw new Error(`scalar bytes must be ${SCALAR_BYTES} long, got ${b.length}`);
  }
  let x = 0n;
  for (let i = SCALAR_BYTES - 1; i >= 0; i--) {
    x = (x << 8n) | BigInt(b[i]);
  }
  return ((x % CURVE_L) + CURVE_L) % CURVE_L;
}

// ---------- Deterministic signer scalar ----------

function seedToScalar(secKey: Uint8Array): bigint {
  if (secKey.length !== SCALAR_BYTES) {
    throw new Error(`secKey must be ${SCALAR_BYTES} bytes, got ${secKey.length}`);
  }
  const x = bytesToScalar(secKey);
  if (x === 0n) {
    // Adversary with unbounded keygen attempts could try to poison a zero
    // scalar; refuse to operate with one.
    throw new Error('secKey decodes to zero scalar');
  }
  return x;
}

// ---------- Random nonzero scalar ----------

function randomNonzeroScalar(): bigint {
  for (let attempt = 0; attempt < 16; attempt++) {
    const raw = ed25519.utils.randomPrivateKey();
    const x = bytesToScalar(raw);
    if (x !== 0n) return x;
  }
  throw new Error('RNG failed to produce a nonzero scalar after 16 attempts');
}

// ---------- Hashes ----------

function hashToScalar(input: Uint8Array): bigint {
  const digest = sha256(concatBytes(DOMAIN_SCALAR_PREFIX, input));
  return bytesToScalar(digest);
}

function hashToPoint(domain: string): Point {
  const domainBytes = utf8ToBytes(DOMAIN_HTP_PREFIX + domain + ':');
  for (let ctr = 0; ctr < MAX_HTP_COUNTER; ctr++) {
    const ctrBytes = utf8ToBytes(String(ctr));
    const digest = sha512(concatBytes(domainBytes, ctrBytes));
    const candidate = digest.slice(0, SCALAR_BYTES);
    try {
      const point = RistrettoPoint.fromHex(candidate);
      // Reject identity — guards against a pathological domain decoding.
      if (point.equals(RistrettoPoint.ZERO)) continue;
      return point;
    } catch {
      // Invalid Ristretto encoding — try next counter.
    }
  }
  throw new Error('hashToPoint: exhausted counter without a valid Ristretto point');
}

// ---------- Safe scalar multiplication ----------

function safeMultiply(point: Point, scalar: bigint): Point {
  const s = ((scalar % CURVE_L) + CURVE_L) % CURVE_L;
  if (s === 0n) return RistrettoPoint.ZERO;
  return point.multiply(s);
}

// ---------- Ring helpers ----------

function decodeRing(ring: Uint8Array[]): Point[] {
  if (ring.length === 0) throw new Error('ring must be non-empty');
  return ring.map((pk, idx) => {
    if (!(pk instanceof Uint8Array) || pk.length !== SCALAR_BYTES) {
      throw new Error(`ring[${idx}] must be a 32-byte Uint8Array`);
    }
    try {
      return RistrettoPoint.fromHex(pk);
    } catch (err) {
      throw new Error(
        `ring[${idx}] is not a valid Ristretto255 point: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

export function hashRing(ring: Uint8Array[]): string {
  if (ring.length === 0) return bytesToHex(sha256(new Uint8Array(0)));
  const buf = new Uint8Array(ring.length * SCALAR_BYTES);
  for (let i = 0; i < ring.length; i++) {
    if (!(ring[i] instanceof Uint8Array) || ring[i].length !== SCALAR_BYTES) {
      throw new Error(`hashRing: ring[${i}] must be 32 bytes`);
    }
    buf.set(ring[i], i * SCALAR_BYTES);
  }
  return bytesToHex(sha256(buf));
}

// ---------- Key generation ----------

export function generateKeypair(): KeyPair {
  for (let attempt = 0; attempt < 8; attempt++) {
    const secKey = ed25519.utils.randomPrivateKey();
    const x = bytesToScalar(secKey);
    if (x === 0n) continue;
    const pubKey = RistrettoPoint.BASE.multiply(x).toRawBytes();
    return { pubKey, secKey };
  }
  throw new Error('generateKeypair: RNG failed to produce nonzero scalar');
}

// ---------- Key image ----------

export function deriveKeyImage(secKey: Uint8Array, domain: string): Uint8Array {
  const x = seedToScalar(secKey);
  const Hp = hashToPoint(domain);
  const I = safeMultiply(Hp, x);
  return I.toRawBytes();
}

// ---------- Sign ----------

export function sign(
  message: Uint8Array,
  ring: Uint8Array[],
  signerIndex: number,
  secKey: Uint8Array,
  domain: string,
): SAGSignature {
  const n = ring.length;
  if (n < 2) throw new Error('ring must have at least 2 members');
  if (!Number.isInteger(signerIndex) || signerIndex < 0 || signerIndex >= n) {
    throw new Error('signerIndex out of range');
  }

  const P = decodeRing(ring);
  const x = seedToScalar(secKey);
  const G = RistrettoPoint.BASE;
  const Hp = hashToPoint(domain);
  const I = safeMultiply(Hp, x);
  const Ibytes = I.toRawBytes();

  // Defensive: the secKey MUST correspond to ring[signerIndex]. If a caller
  // passes a mismatched pair by mistake, the resulting signature would
  // silently fail to verify against the server ring — but we'd leak no
  // secret material. We check eagerly to turn a silent bug into a loud one.
  const expectedP = G.multiply(x);
  if (!expectedP.equals(P[signerIndex])) {
    throw new Error('secKey does not match ring[signerIndex]');
  }

  const c: bigint[] = new Array(n).fill(0n);
  const s: bigint[] = new Array(n).fill(0n);

  const alpha = randomNonzeroScalar();
  const Lpi = G.multiply(alpha);
  const Rpi = Hp.multiply(alpha);
  c[(signerIndex + 1) % n] = hashToScalar(
    concatBytes(message, Lpi.toRawBytes(), Rpi.toRawBytes(), Ibytes),
  );

  for (let k = 1; k < n; k++) {
    const i = (signerIndex + k) % n;
    s[i] = randomNonzeroScalar();
    const Li = safeMultiply(G, s[i]).add(safeMultiply(P[i], c[i]));
    const Ri = safeMultiply(Hp, s[i]).add(safeMultiply(I, c[i]));
    c[(i + 1) % n] = hashToScalar(
      concatBytes(message, Li.toRawBytes(), Ri.toRawBytes(), Ibytes),
    );
  }

  // s_pi = alpha - c_pi * x (mod L)
  const sPi = ((alpha - c[signerIndex] * x) % CURVE_L + CURVE_L) % CURVE_L;
  s[signerIndex] = sPi;

  return {
    c0: scalarToBytes(c[0]),
    s: s.map(scalarToBytes),
    keyImage: Ibytes,
  };
}

// ---------- Verify ----------

export function verify(
  message: Uint8Array,
  ring: Uint8Array[],
  signature: SAGSignature,
  domain: string,
): boolean {
  try {
    const n = ring.length;
    if (n < 2) return false;
    if (signature.s.length !== n) return false;
    if (signature.c0.length !== SCALAR_BYTES) return false;
    if (signature.keyImage.length !== SCALAR_BYTES) return false;

    const P = decodeRing(ring);
    const G = RistrettoPoint.BASE;
    const Hp = hashToPoint(domain);
    let I: Point;
    try {
      I = RistrettoPoint.fromHex(signature.keyImage);
    } catch {
      return false;
    }
    const Ibytes = I.toRawBytes();

    const c: bigint[] = new Array(n + 1).fill(0n);
    c[0] = bytesToScalar(signature.c0);
    for (let i = 0; i < n; i++) {
      const s_i = bytesToScalar(signature.s[i]);
      const Li = safeMultiply(G, s_i).add(safeMultiply(P[i], c[i]));
      const Ri = safeMultiply(Hp, s_i).add(safeMultiply(I, c[i]));
      c[i + 1] = hashToScalar(
        concatBytes(message, Li.toRawBytes(), Ri.toRawBytes(), Ibytes),
      );
    }
    return c[n] === c[0];
  } catch {
    return false;
  }
}

// ---------- Signature serialization ----------

export function sigToHex(sig: SAGSignature): SAGSignatureHex {
  return {
    c0: bytesToHex(sig.c0),
    s: sig.s.map(bytesToHex),
    keyImage: bytesToHex(sig.keyImage),
  };
}

export function sigFromHex(h: SAGSignatureHex): SAGSignature {
  if (typeof h.c0 !== 'string' || h.c0.length !== 64) {
    throw new Error('sigFromHex: c0 must be 64-char hex');
  }
  if (typeof h.keyImage !== 'string' || h.keyImage.length !== 64) {
    throw new Error('sigFromHex: keyImage must be 64-char hex');
  }
  if (!Array.isArray(h.s)) {
    throw new Error('sigFromHex: s must be an array');
  }
  const s = h.s.map((entry, idx) => {
    if (typeof entry !== 'string' || entry.length !== 64) {
      throw new Error(`sigFromHex: s[${idx}] must be 64-char hex`);
    }
    return hexToBytes(entry);
  });
  return {
    c0: hexToBytes(h.c0),
    s,
    keyImage: hexToBytes(h.keyImage),
  };
}
