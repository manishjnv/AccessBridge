/**
 * Compliance Observatory — metrics publisher (Feature #10).
 *
 * Pure helpers + a daily publish routine. Collects no identity, no content,
 * no URLs, no IP — only noised integer counters and a Merkle commitment of
 * that day's counter bundle. See docs/features/compliance-observatory.md.
 */

export const OBSERVATORY_ENDPOINT =
  'http://72.61.227.64:8300/observatory/api/publish';

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
}

export interface NoisyBundle {
  date: string;
  adaptations_applied: Record<string, number>;
  struggle_events_triggered: number;
  features_enabled: Record<string, number>;
  languages_used: string[];
  domain_connectors_activated: Record<string, number>;
  estimated_accessibility_score_improvement: number;
  merkle_root: string;
  schema_version: 1;
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
  const langs = [...new Set(bundle.languages_used)].sort();
  lines.push(`languages_used:=[${langs.join(',')}]`);
  lines.push(
    `estimated_accessibility_score_improvement:=${bundle.estimated_accessibility_score_improvement}`,
  );
  lines.sort();
  return lines;
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

  const partial = {
    date: todayLocalISO(),
    adaptations_applied,
    struggle_events_triggered,
    features_enabled,
    languages_used,
    domain_connectors_activated,
    estimated_accessibility_score_improvement,
  };
  const lines = canonicalLines(partial);
  const merkle_root = await merkleRoot(lines);

  return {
    ...partial,
    merkle_root,
    schema_version: 1,
  };
}

// ---------- Runtime (chrome.storage + fetch) ----------

const STORAGE_LAST_PUBLISH = 'observatory_last_publish';
const PUBLISH_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
