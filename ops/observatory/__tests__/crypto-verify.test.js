/**
 * Node-side self-test for crypto-verify.js. Constructs a SAG attestation
 * inline using @noble primitives (no dependency on the TS workspace), then
 * re-verifies via our crypto-verify module. This proves Node verify is
 * byte-compatible with the algorithm the extension signs with.
 *
 * Run with: node __tests__/crypto-verify.test.js
 * Assertion failures throw and set process.exit(1).
 */

const { ed25519, RistrettoPoint } = require('@noble/curves/ed25519');
const { sha256 } = require('@noble/hashes/sha256');
const { sha512 } = require('@noble/hashes/sha512');
const { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } = require('@noble/hashes/utils');

const {
  verifyAttestation,
  hashRing,
  recomputeCounterMerkleRoot,
  attestationMessageBytes,
  attestationKeyImageDomain,
  verifySAG,
  sigFromHex,
} = require('../crypto-verify');

const CURVE_L = ed25519.CURVE.n;
const SCALAR_BYTES = 32;
const DOMAIN_SCALAR = utf8ToBytes('accessbridge-scalar-v1:');
const HTP_PREFIX = 'accessbridge-htp-v1:';

function scalarToBytes(x) {
  const n = ((x % CURVE_L) + CURVE_L) % CURVE_L;
  const out = new Uint8Array(SCALAR_BYTES);
  let v = n;
  for (let i = 0; i < SCALAR_BYTES; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
function bytesToScalar(b) {
  let x = 0n;
  for (let i = SCALAR_BYTES - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]);
  return ((x % CURVE_L) + CURVE_L) % CURVE_L;
}
function hashToScalar(input) {
  return bytesToScalar(sha256(concatBytes(DOMAIN_SCALAR, input)));
}
function hashToPoint(domain) {
  const db = utf8ToBytes(HTP_PREFIX + domain + ':');
  for (let ctr = 0; ctr < 256; ctr++) {
    const d = sha512(concatBytes(db, utf8ToBytes(String(ctr))));
    try {
      const p = RistrettoPoint.fromHex(d.slice(0, SCALAR_BYTES));
      if (!p.equals(RistrettoPoint.ZERO)) return p;
    } catch {}
  }
  throw new Error('htp exhausted');
}
function safeMul(p, s) {
  const r = ((s % CURVE_L) + CURVE_L) % CURVE_L;
  if (r === 0n) return RistrettoPoint.ZERO;
  return p.multiply(r);
}
function randomScalar() {
  for (let i = 0; i < 16; i++) {
    const x = bytesToScalar(ed25519.utils.randomPrivateKey());
    if (x !== 0n) return x;
  }
  throw new Error('rng');
}
function makeKeypair() {
  const sec = ed25519.utils.randomPrivateKey();
  const x = bytesToScalar(sec);
  if (x === 0n) return makeKeypair();
  return { sec, x, pub: RistrettoPoint.BASE.multiply(x).toRawBytes() };
}

// Sign — inline port of ed25519-ring.ts sign()
function sign(msg, ringBytes, pi, secKey, domain) {
  const n = ringBytes.length;
  const P = ringBytes.map((b) => RistrettoPoint.fromHex(b));
  const x = bytesToScalar(secKey);
  const G = RistrettoPoint.BASE;
  const Hp = hashToPoint(domain);
  const I = safeMul(Hp, x);
  const Ibytes = I.toRawBytes();

  const c = new Array(n).fill(0n);
  const s = new Array(n).fill(0n);
  const alpha = randomScalar();
  const Lpi = G.multiply(alpha);
  const Rpi = Hp.multiply(alpha);
  c[(pi + 1) % n] = hashToScalar(concatBytes(msg, Lpi.toRawBytes(), Rpi.toRawBytes(), Ibytes));
  for (let k = 1; k < n; k++) {
    const i = (pi + k) % n;
    s[i] = randomScalar();
    const Li = safeMul(G, s[i]).add(safeMul(P[i], c[i]));
    const Ri = safeMul(Hp, s[i]).add(safeMul(I, c[i]));
    c[(i + 1) % n] = hashToScalar(concatBytes(msg, Li.toRawBytes(), Ri.toRawBytes(), Ibytes));
  }
  s[pi] = ((alpha - c[pi] * x) % CURVE_L + CURVE_L) % CURVE_L;
  return {
    c0: bytesToHex(scalarToBytes(c[0])),
    s: s.map((v) => bytesToHex(scalarToBytes(v))),
    keyImage: bytesToHex(Ibytes),
  };
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('  ok  ', msg);
}

function buildAttestation({ date, counters, ring, ringVersion, pi, secKey }) {
  const merkleRoot = recomputeCounterMerkleRoot(counters);
  const ringHashHex = hashRing(ring);
  const domain = attestationKeyImageDomain(date, ringHashHex);
  const msg = attestationMessageBytes({ date, ringHash: ringHashHex, merkleRoot, ringVersion });
  const sig = sign(msg, ring, pi, secKey, domain);
  return {
    format: 1,
    date,
    ringVersion,
    ringHash: ringHashHex,
    merkleRoot,
    counters,
    signature: sig,
  };
}

function sampleCounters(date) {
  return {
    schema_version: 1,
    date,
    adaptations_applied: { FONT_SCALE: 3 },
    struggle_events_triggered: 7,
    features_enabled: { focus_mode: 1 },
    languages_used: ['en'],
    domain_connectors_activated: { banking: 2 },
    estimated_accessibility_score_improvement: 45,
    onnx_inferences: { tier0: 12 },
    merkle_root: 'placeholder',
  };
}

// ---------- Test cases ----------

console.log('crypto-verify — Node cross-check');
const date = '2026-04-21';

// Ring of 4
const kps = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
const ring = kps.map((k) => k.pub);
const ringHexes = ring.map(bytesToHex);
const ringV = 1;

for (let signerIdx = 0; signerIdx < ring.length; signerIdx++) {
  const counters = sampleCounters(date);
  const a = buildAttestation({
    date,
    counters,
    ring,
    ringVersion: ringV,
    pi: signerIdx,
    secKey: kps[signerIdx].sec,
  });
  a.counters.merkle_root = a.merkleRoot; // mirror publisher behavior
  const result = verifyAttestation(a, ringHexes);
  assert(result.valid, `valid attestation signer=${signerIdx}`);
}

// Tampered counter → merkle-mismatch
{
  const counters = sampleCounters(date);
  const a = buildAttestation({ date, counters, ring, ringVersion: ringV, pi: 0, secKey: kps[0].sec });
  a.counters.struggle_events_triggered = 9999; // tamper
  const r = verifyAttestation(a, ringHexes);
  assert(!r.valid && r.reason === 'merkle-mismatch', 'tampered counter → merkle-mismatch');
}

// Wrong ring → ring-mismatch
{
  const counters = sampleCounters(date);
  const a = buildAttestation({ date, counters, ring, ringVersion: ringV, pi: 1, secKey: kps[1].sec });
  const otherRing = [makeKeypair().pub, makeKeypair().pub, makeKeypair().pub, makeKeypair().pub];
  const r = verifyAttestation(a, otherRing.map(bytesToHex));
  assert(!r.valid && r.reason === 'ring-mismatch', 'wrong ring → ring-mismatch');
}

// Forged c0 → signature-invalid
{
  const counters = sampleCounters(date);
  const a = buildAttestation({ date, counters, ring, ringVersion: ringV, pi: 2, secKey: kps[2].sec });
  a.signature.c0 = '00'.repeat(32);
  const r = verifyAttestation(a, ringHexes);
  assert(!r.valid && r.reason === 'signature-invalid', 'forged c0 → signature-invalid');
}

// Malformed format → malformed
{
  const counters = sampleCounters(date);
  const a = buildAttestation({ date, counters, ring, ringVersion: ringV, pi: 0, secKey: kps[0].sec });
  a.format = 99;
  const r = verifyAttestation(a, ringHexes);
  assert(!r.valid && r.reason === 'malformed', 'bad format → malformed');
}

// Linkability: same signer + same (date, ringHash) → same keyImage
{
  const c1 = sampleCounters(date); c1.struggle_events_triggered = 1;
  const c2 = sampleCounters(date); c2.struggle_events_triggered = 2;
  const a1 = buildAttestation({ date, counters: c1, ring, ringVersion: ringV, pi: 0, secKey: kps[0].sec });
  const a2 = buildAttestation({ date, counters: c2, ring, ringVersion: ringV, pi: 0, secKey: kps[0].sec });
  assert(a1.signature.keyImage === a2.signature.keyImage, 'same signer → same keyImage');
  assert(verifyAttestation(a1, ringHexes).valid && verifyAttestation(a2, ringHexes).valid, 'both link-sigs verify');
}

// Domain separation: different date → different keyImage
{
  const a1 = buildAttestation({ date: '2026-04-21', counters: sampleCounters('2026-04-21'), ring, ringVersion: ringV, pi: 0, secKey: kps[0].sec });
  const a2 = buildAttestation({ date: '2026-04-22', counters: sampleCounters('2026-04-22'), ring, ringVersion: ringV, pi: 0, secKey: kps[0].sec });
  assert(a1.signature.keyImage !== a2.signature.keyImage, 'different date → different keyImage');
}

console.log('crypto-verify Node cross-check: ALL PASSED');
