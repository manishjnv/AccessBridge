/**
 * Compliance Observatory — metrics publisher (Feature #10 + Feature #7).
 *
 * Session 10 shipped the DP-noise + Merkle-commitment publish path. Session 16
 * layers SAG linkable ring signatures on top: each enrolled device holds a
 * Ristretto255 keypair, every publish is a ring signature over
 * (date, ringHash, merkleRoot, ringVersion), and the server rejects any
 * bundle whose key image already appears for the same date. See
 * docs/features/zero-knowledge-attestation.md.
 */

import {
  generateKeypair,
  buildAttestation,
  type Attestation,
  type KeyPair,
} from '@accessbridge/core/crypto';

export const OBSERVATORY_ENDPOINT =
  'http://72.61.227.64:8300/observatory/api/publish';

// --- Session 16: Zero-Knowledge Attestation (Feature #7) ---
export const OBSERVATORY_ENROLL_ENDPOINT =
  'http://72.61.227.64:8300/observatory/api/enroll';
export const OBSERVATORY_RING_ENDPOINT =
  'http://72.61.227.64:8300/observatory/api/ring';
/** Re-fetch the ring at most weekly. Ring changes are monotonic + rare. */
export const RING_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export const DP_EPSILON = 1.0;
export const DP_SENSITIVITY = 1;

// ---------- Types ----------

export interface RawCounters {
  adaptations_applied: Record<string, number>;
  struggle_events_triggered: number;
  features_enabled: Record<string, number>;
  languages_used: string[];
  domain_connectors_activated: Record<string, number>;
  estimated_accessibility_score_improvement: number;
  /** Session 12: on-device ONNX inference counters per tier. Keys: 'tier0', 'tier1', 'tier2', 'fallback'. Session 17 adds 'tier3'. */
  onnx_inferences?: Record<string, number>;
  /** Session 17: voice STT tier usage counts. Keys: 'a' (Web Speech), 'b' (IndicWhisper ONNX), 'c' (cloud). */
  voice_tier_counts?: Record<string, number>;
  /** Session 20: orgHash — opaque Merkle hash of org device ring, set by Group Policy. Never transmitted when absent. */
  org_hash?: string;
}

export interface NoisyBundle {
  date: string;
  adaptations_applied: Record<string, number>;
  struggle_events_triggered: number;
  features_enabled: Record<string, number>;
  languages_used: string[];
  domain_connectors_activated: Record<string, number>;
  estimated_accessibility_score_improvement: number;
  /** Session 12: Laplace-noised ONNX inference counters per tier + fallback. */
  onnx_inferences: Record<string, number>;
  /** Session 17: Laplace-noised voice-STT tier usage counts. */
  voice_tier_counts: Record<string, number>;
  merkle_root: string;
  schema_version: 1;
  /** Session 20: orgHash — opaque Merkle hash of org device ring, set by Group Policy. Never transmitted when absent. */
  org_hash?: string;
}

export interface PublishResult {
  ok: boolean;
  status?: number;
  error?: string;
}

// ---------- Pure helpers ----------

/**
 * Sample uniform in (-0.5, 0.5) excluding 0 using crypto.getRandomValues.
 * Redraws on edge cases so callers don't take log(0).
 */
function sampleUniform(): number {
  for (let attempt = 0; attempt < 16; attempt++) {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    const r = buf[0] / 0x1_0000_0000; // [0, 1)
    const u = r - 0.5; // [-0.5, 0.5)
    if (u !== 0 && u !== -0.5) return u;
  }
  // Fallback — extremely unlikely to reach.
  return 0.1;
}

/**
 * Add Laplace noise (mean 0, scale b = sensitivity/epsilon) to a count.
 * Returns a non-negative integer — count data must not go below zero.
 */
export function addLaplaceNoise(
  count: number,
  epsilon: number,
  sensitivity: number,
): number {
  if (epsilon <= 0) throw new Error('epsilon must be positive');
  if (sensitivity <= 0) throw new Error('sensitivity must be positive');
  const b = sensitivity / epsilon;
  const u = sampleUniform();
  const sign = u < 0 ? -1 : 1;
  const noise = -b * sign * Math.log(1 - 2 * Math.abs(u));
  return Math.max(0, Math.round(count + noise));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer so SubtleCrypto's BufferSource typing accepts it
  // under strict DOM lib settings (rejects SharedArrayBuffer-backed views).
  const view = new Uint8Array(data.byteLength);
  view.set(data);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', view.buffer);
  return new Uint8Array(buf);
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await sha256Bytes(data));
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Canonical binary Merkle tree over `items` using SHA-256.
 * - Leaf = sha256(utf8 bytes of item)
 * - Internal node = sha256(left_hash || right_hash)
 * - Odd level: duplicate last node
 * - Empty input: sha256("") hex
 */
export async function merkleRoot(items: string[]): Promise<string> {
  const enc = new TextEncoder();
  if (items.length === 0) {
    return sha256Hex(enc.encode(''));
  }
  let layer: Uint8Array[] = await Promise.all(
    items.map((item) => sha256Bytes(enc.encode(item))),
  );
  while (layer.length > 1) {
    if (layer.length % 2 !== 0) {
      layer = [...layer, layer[layer.length - 1]];
    }
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(await sha256Bytes(concatBytes(layer[i], layer[i + 1])));
    }
    layer = next;
  }
  return toHex(layer[0]);
}

function todayLocalISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function canonicalLines(bundle: {
  adaptations_applied: Record<string, number>;
  struggle_events_triggered: number;
  features_enabled: Record<string, number>;
  domain_connectors_activated: Record<string, number>;
  languages_used: string[];
  estimated_accessibility_score_improvement: number;
  onnx_inferences?: Record<string, number>;
  voice_tier_counts?: Record<string, number>;
}): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(bundle.adaptations_applied)) {
    lines.push(`adaptations_applied:${k}=${v}`);
  }
  lines.push(`struggle_events_triggered:=${bundle.struggle_events_triggered}`);
  for (const [k, v] of Object.entries(bundle.features_enabled)) {
    lines.push(`features_enabled:${k}=${v}`);
  }
  for (const [k, v] of Object.entries(bundle.domain_connectors_activated)) {
    lines.push(`domain_connectors_activated:${k}=${v}`);
  }
  for (const [k, v] of Object.entries(bundle.onnx_inferences ?? {})) {
    lines.push(`onnx_inferences:${k}=${v}`);
  }
  // Session 17: voice_tier_counts are carried on the raw bundle + noised payload
  // but intentionally NOT folded into the merkle root — the observatory server's
  // canonicalLinesForBundle() does not yet know about this field, so including
  // it here would cause merkle_root mismatches and reject publishes. A future
  // observatory deploy that adds voice_tier_counts to the server-side canonical
  // line set can then mirror the addition here.
  const langs = [...new Set(bundle.languages_used)].sort();
  lines.push(`languages_used:=[${langs.join(',')}]`);
  lines.push(
    `estimated_accessibility_score_improvement:=${bundle.estimated_accessibility_score_improvement}`,
  );
  lines.sort();
  return lines;
}

// ---------- Session 20: org_hash wiring ----------

/**
 * Module-level org_hash set by background/index.ts after the managed policy
 * loads. The value originates from Group Policy (Chrome managed storage) and
 * is an opaque 64-hex Merkle hash identifying the enterprise device ring.
 * When absent (non-managed installs), the field is omitted from published
 * bundles entirely — `undefined` serialises as absence in JSON.stringify.
 */
let _managedOrgHash: string | undefined;

/**
 * Called by background/index.ts once the managed policy has loaded (and again
 * whenever the policy changes). Pass `undefined` to clear.
 */
export function setManagedOrgHash(hash: string | undefined): void {
  _managedOrgHash = hash;
}

/**
 * Apply Laplace noise (ε=1, sensitivity=1) to every numeric counter and
 * compute a Merkle commitment over the canonicalized noised bundle.
 * `languages_used` is a categorical membership set — no noise is applied;
 * individual membership carries low marginal information vs the full bundle.
 */
export async function aggregateDailyBundle(
  raw: RawCounters,
): Promise<NoisyBundle> {
  const adaptations_applied: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.adaptations_applied)) {
    adaptations_applied[k] = addLaplaceNoise(v, DP_EPSILON, DP_SENSITIVITY);
  }
  const features_enabled: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.features_enabled)) {
    features_enabled[k] = addLaplaceNoise(v, DP_EPSILON, DP_SENSITIVITY);
  }
  const domain_connectors_activated: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.domain_connectors_activated)) {
    domain_connectors_activated[k] = addLaplaceNoise(
      v,
      DP_EPSILON,
      DP_SENSITIVITY,
    );
  }
  const struggle_events_triggered = addLaplaceNoise(
    raw.struggle_events_triggered,
    DP_EPSILON,
    DP_SENSITIVITY,
  );
  const score_raw = addLaplaceNoise(
    raw.estimated_accessibility_score_improvement,
    DP_EPSILON,
    DP_SENSITIVITY,
  );
  const estimated_accessibility_score_improvement = clamp(score_raw, 0, 100);

  const languages_used = [...new Set(raw.languages_used)].sort();

  const onnx_inferences: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.onnx_inferences ?? {})) {
    onnx_inferences[k] = addLaplaceNoise(v, DP_EPSILON, DP_SENSITIVITY);
  }

  // Session 17: voice-STT tier counts are DP-noised the same way. Keys
  // are 'a' | 'b' | 'c' — per-utterance cardinality, one of three slots.
  const voice_tier_counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.voice_tier_counts ?? {})) {
    voice_tier_counts[k] = addLaplaceNoise(v, DP_EPSILON, DP_SENSITIVITY);
  }

  const partial = {
    date: todayLocalISO(),
    adaptations_applied,
    struggle_events_triggered,
    features_enabled,
    languages_used,
    domain_connectors_activated,
    estimated_accessibility_score_improvement,
    onnx_inferences,
    voice_tier_counts,
  };
  const lines = canonicalLines(partial);
  const merkle_root = await merkleRoot(lines);

  // Session 20: include org_hash only when present — undefined omits the key
  // entirely from the JSON payload so non-managed bundles are unchanged.
  // Managed (Group-Policy-supplied) value is authoritative: if a caller ever
  // passes raw.org_hash (e.g. in tests), managed still wins. Prevents a
  // compromised counter-producer from overriding the enterprise device-ring.
  const org_hash = _managedOrgHash ?? raw.org_hash;

  return {
    ...partial,
    merkle_root,
    schema_version: 1,
    ...(org_hash !== undefined ? { org_hash } : {}),
  };
}

// ---------- Runtime (chrome.storage + fetch) ----------

const STORAGE_LAST_PUBLISH = 'observatory_last_publish';
const PUBLISH_INTERVAL_MS = 24 * 60 * 60 * 1000;

// --- Session 16: ZK attestation storage keys ---
const STORAGE_DEVICE_SECKEY = 'observatory_device_seckey'; // 32 bytes, hex
const STORAGE_DEVICE_PUBKEY = 'observatory_device_pubkey'; // 32 bytes, hex
const STORAGE_RING_CACHE = 'observatory_ring_cache';       // { version, pubKeys[], ringHash, fetchedAt }
const STORAGE_LAST_KEY_IMAGE = 'observatory_last_key_image'; // { date, hex }
const STORAGE_LAST_ATTESTATION = 'observatory_last_attestation'; // { date, valid, reason? }

export async function getLastPublish(): Promise<number | null> {
  const result = await chrome.storage.local.get(STORAGE_LAST_PUBLISH);
  const v = result[STORAGE_LAST_PUBLISH];
  return typeof v === 'number' ? v : null;
}

export async function recordPublish(timestamp: number): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_LAST_PUBLISH]: timestamp });
}

export async function shouldPublishNow(): Promise<boolean> {
  const last = await getLastPublish();
  if (last === null) return true;
  return Date.now() - last >= PUBLISH_INTERVAL_MS;
}

// --- Session 16: enrolment + ring-signed publish ---

export interface RingCache {
  version: number;
  /** Hex-encoded 32-byte Ristretto255 public keys in ring order. */
  pubKeys: string[];
  ringHash: string;
  fetchedAt: number;
}

export interface EnrollResponse {
  ringHash: string;
  ringVersion: number;
  ringSize: number;
  yourIndex: number;
}

function hexEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function hexDecode(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error('invalid hex length');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * Load the device's observatory keypair, generating one on first call.
 * The secret key is persisted to chrome.storage.local; at rest it is
 * protected by Chrome's built-in profile encryption (tied to the user's
 * OS account). Additional AES-GCM wrapping would require storing a key
 * alongside the ciphertext, which provides no marginal security.
 */
export async function getOrCreateDeviceKeypair(): Promise<KeyPair> {
  const res = await chrome.storage.local.get([
    STORAGE_DEVICE_SECKEY,
    STORAGE_DEVICE_PUBKEY,
  ]);
  const sec = res[STORAGE_DEVICE_SECKEY];
  const pub = res[STORAGE_DEVICE_PUBKEY];
  if (typeof sec === 'string' && typeof pub === 'string' && sec.length === 64 && pub.length === 64) {
    return { secKey: hexDecode(sec), pubKey: hexDecode(pub) };
  }
  const kp = generateKeypair();
  await chrome.storage.local.set({
    [STORAGE_DEVICE_SECKEY]: hexEncode(kp.secKey),
    [STORAGE_DEVICE_PUBKEY]: hexEncode(kp.pubKey),
  });
  return kp;
}

/**
 * Rotate the device keypair — used by the "Re-enroll" button. The caller is
 * responsible for calling enrollDevice() afterward so the server picks up
 * the new pubkey.
 */
export async function rotateDeviceKeypair(): Promise<KeyPair> {
  const kp = generateKeypair();
  await chrome.storage.local.set({
    [STORAGE_DEVICE_SECKEY]: hexEncode(kp.secKey),
    [STORAGE_DEVICE_PUBKEY]: hexEncode(kp.pubKey),
  });
  return kp;
}

export async function getCachedRing(): Promise<RingCache | null> {
  const res = await chrome.storage.local.get(STORAGE_RING_CACHE);
  const v = res[STORAGE_RING_CACHE];
  if (!v || typeof v !== 'object') return null;
  const cache = v as RingCache;
  if (
    typeof cache.version !== 'number' ||
    !Array.isArray(cache.pubKeys) ||
    typeof cache.ringHash !== 'string' ||
    typeof cache.fetchedAt !== 'number'
  ) {
    return null;
  }
  return cache;
}

export async function setCachedRing(cache: RingCache): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_RING_CACHE]: cache });
}

/**
 * Enroll the device's pubkey with the observatory server. Idempotent on the
 * server side (re-submitting a known pubkey returns the existing ring index).
 */
export async function enrollDevice(
  pubKey: Uint8Array,
  fetchImpl: typeof fetch = fetch,
  endpoint: string = OBSERVATORY_ENROLL_ENDPOINT,
): Promise<EnrollResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubKey: hexEncode(pubKey) }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`enroll HTTP ${res.status}`);
    const body = (await res.json()) as EnrollResponse;
    if (
      typeof body.ringHash !== 'string' ||
      typeof body.ringVersion !== 'number' ||
      typeof body.ringSize !== 'number' ||
      typeof body.yourIndex !== 'number'
    ) {
      throw new Error('enroll: malformed response');
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchedRing {
  version: number;
  pubKeys: Uint8Array[];
  ringHash: string;
}

export async function fetchRing(
  fetchImpl: typeof fetch = fetch,
  endpoint: string = OBSERVATORY_RING_ENDPOINT,
): Promise<FetchedRing> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetchImpl(endpoint, { signal: controller.signal });
    if (!res.ok) throw new Error(`ring HTTP ${res.status}`);
    const body = (await res.json()) as {
      version: number;
      pubKeys: string[];
      ringHash: string;
    };
    if (
      typeof body.version !== 'number' ||
      !Array.isArray(body.pubKeys) ||
      typeof body.ringHash !== 'string'
    ) {
      throw new Error('ring: malformed response');
    }
    return {
      version: body.version,
      pubKeys: body.pubKeys.map(hexDecode),
      ringHash: body.ringHash,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return a ring that's freshly fetched when the cache is stale, else cached.
 * Caller may pass `forceRefresh=true` after a "Re-enroll" action so the
 * new pubkey is picked up immediately.
 */
export async function getOrRefreshRing(
  forceRefresh = false,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedRing> {
  if (!forceRefresh) {
    const cached = await getCachedRing();
    if (cached && Date.now() - cached.fetchedAt < RING_REFRESH_INTERVAL_MS) {
      return {
        version: cached.version,
        pubKeys: cached.pubKeys.map(hexDecode),
        ringHash: cached.ringHash,
      };
    }
  }
  const fresh = await fetchRing(fetchImpl);
  await setCachedRing({
    version: fresh.version,
    pubKeys: fresh.pubKeys.map(hexEncode),
    ringHash: fresh.ringHash,
    fetchedAt: Date.now(),
  });
  return fresh;
}

function findSelfIndex(ring: Uint8Array[], self: Uint8Array): number {
  const target = hexEncode(self);
  for (let i = 0; i < ring.length; i++) {
    if (hexEncode(ring[i]) === target) return i;
  }
  return -1;
}

/** Build a ring-signed Attestation bundle for the given noised counters. */
export function buildRingSignedAttestation(args: {
  bundle: NoisyBundle;
  ring: Uint8Array[];
  ringVersion: number;
  signerIndex: number;
  secKey: Uint8Array;
}): Attestation {
  const { bundle, ring, ringVersion, signerIndex, secKey } = args;
  return buildAttestation({
    date: bundle.date,
    counters: bundle as unknown as Record<string, unknown>,
    merkleRoot: bundle.merkle_root,
    ring,
    ringVersion,
    signerIndex,
    secKey,
  });
}

export async function publishAttestation(
  attestation: Attestation,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetchImpl(OBSERVATORY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attestation }),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * High-level daily flow: ensure device is enrolled + ring is up-to-date,
 * then sign + publish a noised counter bundle. Called by the collector's
 * alarm handler when the opt-in is on and it's time to publish.
 *
 * Returns { ok, reason? }. On success, also stamps
 * observatory_last_key_image so the popup can show "you published today".
 */
export async function runDailyAttestation(args: {
  bundle: NoisyBundle;
  fetchImpl?: typeof fetch;
}): Promise<PublishResult & { keyImageHex?: string }> {
  const fetchImpl = args.fetchImpl ?? fetch;
  try {
    const kp = await getOrCreateDeviceKeypair();
    let ring = await getOrRefreshRing(false, fetchImpl);
    let selfIndex = findSelfIndex(ring.pubKeys, kp.pubKey);
    if (selfIndex < 0) {
      // Not in the ring yet — enroll then re-fetch.
      await enrollDevice(kp.pubKey, fetchImpl);
      ring = await getOrRefreshRing(true, fetchImpl);
      selfIndex = findSelfIndex(ring.pubKeys, kp.pubKey);
      if (selfIndex < 0) {
        return { ok: false, error: 'post-enroll ring missing self' };
      }
    }
    if (ring.pubKeys.length < 2) {
      return {
        ok: false,
        error: 'ring-size-too-small (need at least 2 enrolled devices)',
      };
    }

    const attestation = buildRingSignedAttestation({
      bundle: args.bundle,
      ring: ring.pubKeys,
      ringVersion: ring.version,
      signerIndex: selfIndex,
      secKey: kp.secKey,
    });

    const result = await publishAttestation(attestation, fetchImpl);
    if (result.ok) {
      await chrome.storage.local.set({
        [STORAGE_LAST_KEY_IMAGE]: {
          date: attestation.date,
          hex: attestation.signature.keyImage,
        },
        [STORAGE_LAST_ATTESTATION]: {
          date: attestation.date,
          valid: true,
        },
      });
      return { ...result, keyImageHex: attestation.signature.keyImage };
    }
    await chrome.storage.local.set({
      [STORAGE_LAST_ATTESTATION]: {
        date: attestation.date,
        valid: false,
        reason: result.error ?? `HTTP ${result.status ?? 'unknown'}`,
      },
    });
    return result;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Legacy publishDailyBundle — pre-Session-16 plain JSON path. Retained for
// tests and for the server's v1-format fallback acceptance. New callers
// should use runDailyAttestation.
export async function publishDailyBundle(
  bundle: NoisyBundle,
): Promise<PublishResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(OBSERVATORY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
