/**
 * Node-side (CommonJS) port of the verify + Merkle-recomputation halves of
 * the SAG linkable ring-signature algorithm implemented in
 *   packages/core/src/crypto/ring-signature/ed25519-ring.ts
 *   packages/core/src/crypto/ring-signature/commitment.ts
 *   packages/core/src/crypto/ring-signature/verifier.ts
 *
 * This file MUST stay byte-identical in its algorithm choices to the TS
 * version. Any change here without a matching TS change (or vice versa)
 * will silently invalidate every attestation — the ring-sig contract is
 * defined by agreement between signer and verifier on: domain strings,
 * scalar LE encoding, hash input layouts, and point serialization. Edit
 * with care. The crypto tests in packages/core/src/crypto/ring-signature/
 * __tests__/ cover the TS side; ops/observatory/__tests__/crypto-verify.test.js
 * should cover this file.
 */

const { ed25519, RistrettoPoint } = require('@noble/curves/ed25519');
const { sha256 } = require('@noble/hashes/sha256');
const { sha512 } = require('@noble/hashes/sha512');
const {
  bytesToHex,
  hexToBytes,
  concatBytes,
  utf8ToBytes,
} = require('@noble/hashes/utils');

const CURVE_L = ed25519.CURVE.n;
const SCALAR_BYTES = 32;
const MAX_HTP_COUNTER = 256;
const DOMAIN_SCALAR_PREFIX = utf8ToBytes('accessbridge-scalar-v1:');
const DOMAIN_HTP_PREFIX = 'accessbridge-htp-v1:';

function scalarToBytes(x) {
  const normalized = ((x % CURVE_L) + CURVE_L) % CURVE_L;
  const out = new Uint8Array(SCALAR_BYTES);
  let v = normalized;
  for (let i = 0; i < SCALAR_BYTES; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function bytesToScalar(b) {
  if (b.length !== SCALAR_BYTES) {
    throw new Error(`scalar bytes must be ${SCALAR_BYTES} long`);
  }
  let x = 0n;
  for (let i = SCALAR_BYTES - 1; i >= 0; i--) {
    x = (x << 8n) | BigInt(b[i]);
  }
  return ((x % CURVE_L) + CURVE_L) % CURVE_L;
}

function hashToScalar(input) {
  return bytesToScalar(sha256(concatBytes(DOMAIN_SCALAR_PREFIX, input)));
}

function hashToPoint(domain) {
  const domainBytes = utf8ToBytes(DOMAIN_HTP_PREFIX + domain + ':');
  for (let ctr = 0; ctr < MAX_HTP_COUNTER; ctr++) {
    const ctrBytes = utf8ToBytes(String(ctr));
    const digest = sha512(concatBytes(domainBytes, ctrBytes));
    const candidate = digest.slice(0, SCALAR_BYTES);
    try {
      const point = RistrettoPoint.fromHex(candidate);
      if (point.equals(RistrettoPoint.ZERO)) continue;
      return point;
    } catch {
      // try next counter
    }
  }
  throw new Error('hashToPoint: exhausted counter');
}

function safeMultiply(point, scalar) {
  const s = ((scalar % CURVE_L) + CURVE_L) % CURVE_L;
  if (s === 0n) return RistrettoPoint.ZERO;
  return point.multiply(s);
}

function decodeRing(ring) {
  if (!Array.isArray(ring) || ring.length === 0) {
    throw new Error('ring must be non-empty');
  }
  return ring.map((pk, idx) => {
    if (!(pk instanceof Uint8Array) || pk.length !== SCALAR_BYTES) {
      throw new Error(`ring[${idx}] must be a 32-byte Uint8Array`);
    }
    try {
      return RistrettoPoint.fromHex(pk);
    } catch (err) {
      throw new Error(`ring[${idx}] is not a valid Ristretto255 point: ${err.message}`);
    }
  });
}

function hashRing(ring) {
  if (!Array.isArray(ring) || ring.length === 0) {
    return bytesToHex(sha256(new Uint8Array(0)));
  }
  const buf = new Uint8Array(ring.length * SCALAR_BYTES);
  for (let i = 0; i < ring.length; i++) {
    if (!(ring[i] instanceof Uint8Array) || ring[i].length !== SCALAR_BYTES) {
      throw new Error(`hashRing: ring[${i}] must be 32 bytes`);
    }
    buf.set(ring[i], i * SCALAR_BYTES);
  }
  return bytesToHex(sha256(buf));
}

function attestationMessageBytes(a) {
  const s = `accessbridge-attest-v1:${a.date}:${a.ringVersion}:${a.ringHash}:${a.merkleRoot}`;
  return utf8ToBytes(s);
}

function attestationKeyImageDomain(date, _ringHash) {
  // See packages/core/src/crypto/ring-signature/commitment.ts for the full
  // reasoning; keyImage is scoped by date only so a mid-day ring rotation
  // cannot be used to double-publish by signing against two valid rings.
  return `accessbridge-obs-v1:${date}`;
}

function sigFromHex(h) {
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

function verifySAG(message, ringBytes, signature, domain) {
  try {
    const n = ringBytes.length;
    if (n < 2) return false;
    if (signature.s.length !== n) return false;
    if (signature.c0.length !== SCALAR_BYTES) return false;
    if (signature.keyImage.length !== SCALAR_BYTES) return false;

    const P = decodeRing(ringBytes);
    const G = RistrettoPoint.BASE;
    const Hp = hashToPoint(domain);
    let I;
    try {
      I = RistrettoPoint.fromHex(signature.keyImage);
    } catch {
      return false;
    }
    const Ibytes = I.toRawBytes();

    const c = new Array(n + 1).fill(0n);
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

// ---------- Merkle recomputation (mirrors observatory-publisher.ts) ----------

function merkleRootOf(lines) {
  if (lines.length === 0) {
    return bytesToHex(sha256(utf8ToBytes('')));
  }
  let layer = lines.map((line) => sha256(utf8ToBytes(line)));
  while (layer.length > 1) {
    if (layer.length % 2) layer.push(layer[layer.length - 1]);
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(sha256(concatBytes(layer[i], layer[i + 1])));
    }
    layer = next;
  }
  return bytesToHex(layer[0]);
}

function canonicalLinesForBundle(b) {
  const lines = [];
  for (const [k, v] of Object.entries(b.adaptations_applied || {})) {
    lines.push(`adaptations_applied:${k}=${v}`);
  }
  lines.push(`struggle_events_triggered:=${b.struggle_events_triggered}`);
  for (const [k, v] of Object.entries(b.features_enabled || {})) {
    lines.push(`features_enabled:${k}=${v}`);
  }
  for (const [k, v] of Object.entries(b.domain_connectors_activated || {})) {
    lines.push(`domain_connectors_activated:${k}=${v}`);
  }
  for (const [k, v] of Object.entries(b.onnx_inferences || {})) {
    lines.push(`onnx_inferences:${k}=${v}`);
  }
  const langs = [...new Set(b.languages_used || [])].sort();
  lines.push(`languages_used:=[${langs.join(',')}]`);
  lines.push(
    `estimated_accessibility_score_improvement:=${b.estimated_accessibility_score_improvement}`,
  );
  lines.sort();
  return lines;
}

function recomputeCounterMerkleRoot(counters) {
  return merkleRootOf(canonicalLinesForBundle(counters));
}

// ---------- Public verify entry ----------

/**
 * Verify an attestation against the supplied ring (as hex strings). Returns
 * { valid, reason? }. Does all four checks: ring hash match, ring size
 * match, Merkle recomputation match, signature verify.
 */
function verifyAttestation(attestation, ringHexes) {
  if (!attestation || attestation.format !== 1) {
    return { valid: false, reason: 'malformed' };
  }
  if (!Array.isArray(ringHexes)) {
    return { valid: false, reason: 'malformed' };
  }

  let ringBytes;
  try {
    ringBytes = ringHexes.map((h) => {
      if (typeof h !== 'string' || h.length !== 64) {
        throw new Error('pubkey must be 64-char hex');
      }
      return hexToBytes(h);
    });
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  let expectedRingHash;
  try {
    expectedRingHash = hashRing(ringBytes);
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (expectedRingHash !== attestation.ringHash) {
    return { valid: false, reason: 'ring-mismatch' };
  }

  if (attestation.signature.s.length !== ringBytes.length) {
    return { valid: false, reason: 'ring-size-mismatch' };
  }

  try {
    const recomputed = recomputeCounterMerkleRoot(attestation.counters || {});
    if (recomputed !== attestation.merkleRoot) {
      return { valid: false, reason: 'merkle-mismatch' };
    }
  } catch {
    return { valid: false, reason: 'merkle-mismatch' };
  }

  const message = attestationMessageBytes({
    date: attestation.date,
    ringHash: attestation.ringHash,
    merkleRoot: attestation.merkleRoot,
    ringVersion: attestation.ringVersion,
  });
  const domain = attestationKeyImageDomain(attestation.date, attestation.ringHash);

  let sig;
  try {
    sig = sigFromHex(attestation.signature);
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  const ok = verifySAG(message, ringBytes, sig, domain);
  if (!ok) return { valid: false, reason: 'signature-invalid' };
  return { valid: true };
}

module.exports = {
  verifyAttestation,
  recomputeCounterMerkleRoot,
  hashRing,
  scalarToBytes,
  bytesToScalar,
  sigFromHex,
  verifySAG,
  attestationMessageBytes,
  attestationKeyImageDomain,
};
