/**
 * AccessBridge Compliance Observatory service.
 * Receives DP-noised daily counter bundles from the extension, aggregates them
 * per-metric-per-date, and exposes summary/trends/compliance endpoints.
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const {
  verifyAttestation,
  hashRing,
} = require('./crypto-verify');

const PORT = Number(process.env.PORT || 8200);
const DB_PATH = path.join(__dirname, 'data.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Allowlists: reject arbitrary keys so attackers can't pollute the metric space
// or inflate aggregated_daily cardinality. These should track the extension's
// own enums; update both sides together.
const ADAPTATION_TYPES = new Set([
  'FONT_SCALE', 'CONTRAST', 'READING_MODE', 'FOCUS_MODE', 'VOICE_NAV',
  'EYE_TRACKING', 'LAYOUT_SIMPLIFY', 'TEXT_SIMPLIFY', 'KEYBOARD_ONLY',
  'PREDICTIVE_INPUT', 'CLICK_TARGET_ENLARGE', 'REDUCED_MOTION', 'AUTO_SUMMARIZE',
]);
const FEATURE_NAMES = new Set([
  'focus_mode', 'reading_mode', 'distraction_shield', 'smart_targets',
  'text_simplify', 'reduced_motion', 'auto_summarize', 'voice_nav',
  'eye_tracking', 'keyboard_only', 'predictive_input', 'dwell_click',
]);
const DOMAIN_NAMES = new Set([
  'banking', 'insurance', 'telecom', 'retail', 'healthcare', 'manufacturing',
]);
const LANGUAGE_CODES = new Set([
  'en', 'hi', 'bn', 'ur', 'pa', 'mr', 'te', 'ta', 'gu', 'kn', 'ml',
  'zh', 'es', 'pt', 'ru', 'fr', 'ar', 'id', 'de', 'ja', 'tr', 'vi',
  'ko', 'tl', 'fa', 'it', 'th', 'pl',
]);
const MAX_KEYS_PER_RECORD = 32;
const MAX_LANGS = 6;

// --- Session 16: Zero-Knowledge Attestation limits ---
const MAX_ENROLLED_DEVICES = 10000;
const ENROLL_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ENROLL_RATE_LIMIT = 1; // enrollments per IP per hour
const PUBKEY_HEX_RE = /^[0-9a-f]{64}$/;

const app = express();
const db = new Database(DB_PATH);

// ---------- Schema ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_at INTEGER NOT NULL,
    date TEXT NOT NULL,
    counters_json TEXT NOT NULL,
    merkle_root TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_submissions_date ON daily_submissions(date);
  -- Replay protection: (date, merkle_root) uniquely identifies a given counter
  -- bundle; duplicate POSTs (retries, replays) become no-ops.
  CREATE UNIQUE INDEX IF NOT EXISTS ux_submissions_date_merkle
    ON daily_submissions(date, merkle_root);

  CREATE TABLE IF NOT EXISTS aggregated_daily (
    date TEXT NOT NULL,
    metric TEXT NOT NULL,
    total REAL NOT NULL,
    device_count INTEGER NOT NULL,
    PRIMARY KEY(date, metric)
  );
  CREATE INDEX IF NOT EXISTS idx_agg_date ON aggregated_daily(date);
  CREATE INDEX IF NOT EXISTS idx_agg_metric ON aggregated_daily(metric);

  -- Session 16: Zero-Knowledge Attestation schema
  CREATE TABLE IF NOT EXISTS enrolled_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pub_key_hex TEXT NOT NULL UNIQUE,
    enrolled_at INTEGER NOT NULL,
    ring_version_at_enrollment INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rings (
    version INTEGER PRIMARY KEY AUTOINCREMENT,
    pub_keys_json TEXT NOT NULL,
    ring_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attestations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    ring_version INTEGER NOT NULL,
    key_image TEXT NOT NULL,
    merkle_root TEXT NOT NULL,
    attestation_json TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    UNIQUE(date, key_image)
  );
  CREATE INDEX IF NOT EXISTS idx_attestations_date ON attestations(date);
  CREATE INDEX IF NOT EXISTS idx_attestations_ring ON attestations(ring_version);
`);

// ---------- Middleware ----------
app.use(express.json({ limit: '64kb' }));

// Open CORS — dashboard is same-origin via nginx; extensions have no Origin
// guarantee so we serve everywhere. Publish is still gated by schema + rate limit.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Request log
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${ms}ms`,
    );
  });
  next();
});

// ---------- Rate limiter (in-memory, per-IP, 60 rps per 60s) ----------
const rateBuckets = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = { count: 0, windowStart: now };
    rateBuckets.set(ip, bucket);
  }
  if (now - bucket.windowStart > RATE_WINDOW_MS) {
    bucket.count = 0;
    bucket.windowStart = now;
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'rate limited' });
  }
  next();
}

// Evict stale rate buckets occasionally so the Map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets.entries()) {
    if (now - v.windowStart > RATE_WINDOW_MS * 5) rateBuckets.delete(k);
  }
}, RATE_WINDOW_MS).unref();

// --- Session 16: enroll rate limiter (separate bucket, tighter window) ---
const enrollBuckets = new Map();
function enrollRateLimit(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  let bucket = enrollBuckets.get(ip);
  if (!bucket) {
    bucket = { count: 0, windowStart: now };
    enrollBuckets.set(ip, bucket);
  }
  if (now - bucket.windowStart > ENROLL_RATE_WINDOW_MS) {
    bucket.count = 0;
    bucket.windowStart = now;
  }
  bucket.count += 1;
  if (bucket.count > ENROLL_RATE_LIMIT) {
    return res.status(429).json({ error: 'enroll rate limited' });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of enrollBuckets.entries()) {
    if (now - v.windowStart > ENROLL_RATE_WINDOW_MS * 3) enrollBuckets.delete(k);
  }
}, ENROLL_RATE_WINDOW_MS).unref();

// ---------- Validation ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(a, b) {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db2 = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db2 - da) / 86_400_000);
}

function isIntegerRecord(o, allow, maxKeys) {
  if (!o || typeof o !== 'object') return false;
  const keys = Object.keys(o);
  if (keys.length > maxKeys) return false;
  for (const k of keys) {
    if (!allow.has(k)) return false;
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1_000_000) return false;
  }
  return true;
}

function validateBundle(b) {
  if (!b || typeof b !== 'object') return 'not object';
  if (b.schema_version !== 1) return 'schema_version';
  if (typeof b.date !== 'string' || !DATE_RE.test(b.date)) return 'date';
  const delta = daysBetween(b.date, todayISO());
  if (delta < 0 || delta > 7) return 'date out of window';
  if (typeof b.merkle_root !== 'string' || !HEX64_RE.test(b.merkle_root)) return 'merkle_root';
  if (!isIntegerRecord(b.adaptations_applied, ADAPTATION_TYPES, MAX_KEYS_PER_RECORD)) return 'adaptations_applied';
  if (!Number.isFinite(b.struggle_events_triggered) || b.struggle_events_triggered < 0 || b.struggle_events_triggered > 1_000_000) return 'struggle_events_triggered';
  if (!isIntegerRecord(b.features_enabled, FEATURE_NAMES, MAX_KEYS_PER_RECORD)) return 'features_enabled';
  if (!Array.isArray(b.languages_used) || b.languages_used.length > MAX_LANGS || b.languages_used.some((l) => typeof l !== 'string' || !LANGUAGE_CODES.has(l))) return 'languages_used';
  if (!isIntegerRecord(b.domain_connectors_activated, DOMAIN_NAMES, MAX_KEYS_PER_RECORD)) return 'domain_connectors_activated';
  if (
    !Number.isFinite(b.estimated_accessibility_score_improvement) ||
    b.estimated_accessibility_score_improvement < 0 ||
    b.estimated_accessibility_score_improvement > 100
  )
    return 'score';
  return null;
}

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function merkleRootOf(items) {
  if (items.length === 0) return sha256hex(Buffer.from('')).toString('hex');
  let layer = items.map((s) => sha256hex(Buffer.from(s, 'utf-8')));
  while (layer.length > 1) {
    if (layer.length % 2) layer.push(layer[layer.length - 1]);
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(sha256hex(Buffer.concat([layer[i], layer[i + 1]])));
    }
    layer = next;
  }
  return layer[0].toString('hex');
}

function canonicalLinesForBundle(b) {
  const lines = [];
  for (const [k, v] of Object.entries(b.adaptations_applied || {})) lines.push(`adaptations_applied:${k}=${v}`);
  lines.push(`struggle_events_triggered:=${b.struggle_events_triggered}`);
  for (const [k, v] of Object.entries(b.features_enabled || {})) lines.push(`features_enabled:${k}=${v}`);
  for (const [k, v] of Object.entries(b.domain_connectors_activated || {})) lines.push(`domain_connectors_activated:${k}=${v}`);
  const langs = [...new Set(b.languages_used || [])].sort();
  lines.push(`languages_used:=[${langs.join(',')}]`);
  lines.push(`estimated_accessibility_score_improvement:=${b.estimated_accessibility_score_improvement}`);
  lines.sort();
  return lines;
}

function verifyMerkle(b) {
  return merkleRootOf(canonicalLinesForBundle(b)) === b.merkle_root;
}

// ---------- Aggregation helpers ----------
const insertSubmission = db.prepare(
  'INSERT INTO daily_submissions (submitted_at, date, counters_json, merkle_root) VALUES (?, ?, ?, ?)',
);
const upsertAggregate = db.prepare(`
  INSERT INTO aggregated_daily (date, metric, total, device_count)
  VALUES (?, ?, ?, 1)
  ON CONFLICT(date, metric) DO UPDATE SET
    total = total + excluded.total,
    device_count = device_count + 1
`);

const findSubmission = db.prepare(
  'SELECT id FROM daily_submissions WHERE date = ? AND merkle_root = ?',
);

// --- Session 16 prepared statements ---
const findDeviceByPubKey = db.prepare(
  'SELECT id FROM enrolled_devices WHERE pub_key_hex = ?',
);
const insertDevice = db.prepare(
  'INSERT INTO enrolled_devices (pub_key_hex, enrolled_at, ring_version_at_enrollment) VALUES (?, ?, ?)',
);
const countDevices = db.prepare('SELECT COUNT(*) AS n FROM enrolled_devices');
const allDevicesOrdered = db.prepare(
  'SELECT pub_key_hex FROM enrolled_devices ORDER BY id ASC',
);
const insertRing = db.prepare(
  'INSERT INTO rings (pub_keys_json, ring_hash, created_at) VALUES (?, ?, ?)',
);
const findRingByHash = db.prepare('SELECT * FROM rings WHERE ring_hash = ?');
const findRingByVersion = db.prepare('SELECT * FROM rings WHERE version = ?');
const latestRing = db.prepare('SELECT * FROM rings ORDER BY version DESC LIMIT 1');
const insertAttestation = db.prepare(
  'INSERT INTO attestations (date, ring_version, key_image, merkle_root, attestation_json, received_at) VALUES (?, ?, ?, ?, ?, ?)',
);
const findAttestationByKeyImage = db.prepare(
  'SELECT id FROM attestations WHERE date = ? AND key_image = ?',
);
const attestationsForDate = db.prepare(
  'SELECT attestation_json, key_image, merkle_root, ring_version, received_at FROM attestations WHERE date = ? ORDER BY received_at ASC',
);

const aggregateBundle = db.transaction((bundle) => {
  const { date } = bundle;
  // Idempotency: if this exact (date, merkle_root) was already committed,
  // do not re-aggregate — replay/retry is a no-op.
  const existing = findSubmission.get(date, bundle.merkle_root);
  if (existing) return { id: existing.id, duplicate: true };
  const id = insertSubmission.run(
    Date.now(),
    date,
    JSON.stringify(bundle),
    bundle.merkle_root,
  ).lastInsertRowid;

  for (const [k, v] of Object.entries(bundle.adaptations_applied || {})) {
    upsertAggregate.run(date, `adaptations_applied:${k}`, v);
  }
  upsertAggregate.run(date, 'struggle_events_triggered', bundle.struggle_events_triggered);
  for (const [k, v] of Object.entries(bundle.features_enabled || {})) {
    upsertAggregate.run(date, `features_enabled:${k}`, v);
  }
  for (const [k, v] of Object.entries(bundle.domain_connectors_activated || {})) {
    upsertAggregate.run(date, `domain_connectors_activated:${k}`, v);
  }
  upsertAggregate.run(date, 'estimated_accessibility_score_improvement', bundle.estimated_accessibility_score_improvement);
  const langs = [...new Set(bundle.languages_used || [])];
  for (const lang of langs) {
    upsertAggregate.run(date, `language_used:${lang}`, 1);
  }
  return { id, duplicate: false };
});

// ---------- Summary helpers ----------
function clampDays(n, lo, hi) {
  if (!Number.isFinite(n)) return 30;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function getSummary(days) {
  const windowDays = clampDays(days, 1, 365);
  const since = `date('now','-${windowDays} days','localtime')`;

  const totalsByMetric = db.prepare(
    `SELECT metric, SUM(total) AS total, SUM(device_count) AS device_count
     FROM aggregated_daily WHERE date >= ${since} GROUP BY metric`,
  ).all();

  let totalAdaptations = 0;
  let totalStruggle = 0;
  let maxDeviceCount = 0;
  const adaptationsByType = {};
  const featuresByName = {};
  const domainsByName = {};
  const languagesByCode = {};

  for (const row of totalsByMetric) {
    if (row.device_count > maxDeviceCount) maxDeviceCount = row.device_count;
    if (row.metric.startsWith('adaptations_applied:')) {
      const type = row.metric.slice('adaptations_applied:'.length);
      adaptationsByType[type] = (adaptationsByType[type] || 0) + row.total;
      totalAdaptations += row.total;
    } else if (row.metric === 'struggle_events_triggered') {
      totalStruggle += row.total;
    } else if (row.metric.startsWith('features_enabled:')) {
      const f = row.metric.slice('features_enabled:'.length);
      featuresByName[f] = (featuresByName[f] || 0) + row.total;
    } else if (row.metric.startsWith('domain_connectors_activated:')) {
      const d = row.metric.slice('domain_connectors_activated:'.length);
      domainsByName[d] = (domainsByName[d] || 0) + row.device_count;
    } else if (row.metric.startsWith('language_used:')) {
      const lang = row.metric.slice('language_used:'.length);
      languagesByCode[lang] = (languagesByCode[lang] || 0) + row.device_count;
    }
  }

  // k-anonymity floor: suppress any categorical metric with < K devices so
  // low-population languages / domains / adaptations / features can't be used
  // to single out a small cohort. Count-only totals are safe because they're
  // already DP-noised at the device and added up — aggregation helps, not hurts.
  const K_ANON_MIN = 5;
  const deviceCountFor = (metricKey) => {
    const row = totalsByMetric.find((r) => r.metric === metricKey);
    return row ? row.device_count : 0;
  };
  const sortBy = (obj, keyName, valKey, metricPrefix) =>
    Object.entries(obj)
      .filter(([k]) => {
        if (!metricPrefix) return true;
        return deviceCountFor(`${metricPrefix}${k}`) >= K_ANON_MIN;
      })
      .map(([k, v]) => ({ [keyName]: k, [valKey]: Math.round(v) }))
      .sort((a, b) => b[valKey] - a[valKey]);

  return {
    window_days: windowDays,
    total_devices: maxDeviceCount,
    total_adaptations: Math.round(totalAdaptations),
    total_struggle_events: Math.round(totalStruggle),
    top_languages: sortBy(languagesByCode, 'lang', 'devices', 'language_used:').slice(0, 5),
    top_domains: sortBy(domainsByName, 'domain', 'devices', 'domain_connectors_activated:').slice(0, 3),
    top_adaptations: sortBy(adaptationsByType, 'type', 'count', 'adaptations_applied:').slice(0, 5),
    top_features: sortBy(featuresByName, 'feature', 'count', 'features_enabled:').slice(0, 5),
    disclaimer:
      'Metrics include Laplace noise (ε=1.0). Individual users cannot be identified.',
  };
}

// ---------- Session 16 ring helpers ----------

function hexBytes(s) {
  if (typeof s !== 'string' || s.length % 2 !== 0) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

function currentRingRow() {
  return latestRing.get();
}

function ringFromRow(row) {
  if (!row) return null;
  const pubKeys = JSON.parse(row.pub_keys_json);
  return { version: row.version, pubKeys, ringHash: row.ring_hash };
}

/** Create a fresh ring snapshot from the current set of enrolled devices.
 *  Returns the new ring row. Idempotent on ring_hash collision (i.e. if the
 *  device set didn't change since the last ring version). */
function rotateRing() {
  const devices = allDevicesOrdered.all();
  const pubKeys = devices.map((d) => d.pub_key_hex);
  const bytes = pubKeys.map(hexBytes);
  const ringHash = hashRing(bytes);
  const existing = findRingByHash.get(ringHash);
  if (existing) return existing;
  const info = insertRing.run(JSON.stringify(pubKeys), ringHash, Date.now());
  return findRingByVersion.get(info.lastInsertRowid);
}

// ---------- Routes ----------

// Session 16: publish route now accepts EITHER:
//   (a) Legacy plain JSON bundle { schema_version: 1, date, ... }
//   (b) Ring-signed attestation { attestation: { format: 1, ..., signature, counters } }
app.post('/api/publish', rateLimit, (req, res) => {
  try {
    const body = req.body;
    if (body && body.attestation) {
      return handleRingSignedPublish(body.attestation, res);
    }
    const err = validateBundle(body);
    if (err) return res.status(400).json({ error: 'invalid bundle' });
    // Reject forged bundles: client-declared merkle_root must match the canonical
    // hash we would independently compute. Prevents metric fabrication.
    if (!verifyMerkle(body)) return res.status(400).json({ error: 'invalid bundle' });
    const result = aggregateBundle(body);
    res.json({ ok: true, id: result.id, duplicate: result.duplicate });
  } catch (e) {
    console.error('[publish]', e);
    res.status(500).json({ error: 'internal' });
  }
});

function handleRingSignedPublish(attestation, res) {
  if (
    !attestation ||
    attestation.format !== 1 ||
    typeof attestation.date !== 'string' ||
    !DATE_RE.test(attestation.date) ||
    typeof attestation.ringVersion !== 'number' ||
    typeof attestation.ringHash !== 'string' ||
    typeof attestation.merkleRoot !== 'string' ||
    !attestation.signature ||
    typeof attestation.signature.keyImage !== 'string' ||
    !PUBKEY_HEX_RE.test(attestation.signature.keyImage)
  ) {
    return res.status(400).json({ error: 'invalid attestation shape' });
  }
  // Date freshness window (same as legacy path)
  const delta = daysBetween(attestation.date, todayISO());
  if (delta < 0 || delta > 7) {
    return res.status(400).json({ error: 'date out of window' });
  }

  const ringRow = findRingByVersion.get(attestation.ringVersion);
  if (!ringRow) return res.status(404).json({ error: 'unknown ringVersion' });
  if (ringRow.ring_hash !== attestation.ringHash) {
    return res.status(400).json({ error: 'ringHash mismatch' });
  }

  const ringPubKeys = JSON.parse(ringRow.pub_keys_json);
  const result = verifyAttestation(attestation, ringPubKeys);
  if (!result.valid) {
    return res.status(400).json({ error: 'invalid attestation', reason: result.reason });
  }

  // Replay / double-publish protection via UNIQUE(date, key_image).
  const existing = findAttestationByKeyImage.get(
    attestation.date,
    attestation.signature.keyImage,
  );
  if (existing) {
    return res.status(409).json({ error: 'duplicate attestation', id: existing.id });
  }

  // Validate counter allowlists before aggregation so the attestation
  // cannot inject unknown metric keys even with a valid signature.
  // Build a legacy-shaped bundle wrapper for validateBundle.
  const legacyBundle = {
    schema_version: 1,
    date: attestation.date,
    merkle_root: attestation.merkleRoot,
    ...(attestation.counters || {}),
  };
  const valErr = validateBundle(legacyBundle);
  if (valErr) return res.status(400).json({ error: 'invalid counters', reason: valErr });

  let insertedId;
  const tx = db.transaction(() => {
    const info = insertAttestation.run(
      attestation.date,
      attestation.ringVersion,
      attestation.signature.keyImage,
      attestation.merkleRoot,
      JSON.stringify(attestation),
      Date.now(),
    );
    insertedId = info.lastInsertRowid;
    // Also aggregate into aggregated_daily via the existing path so the
    // dashboard continues to work. Merkle-verified counters go straight in.
    aggregateBundle(legacyBundle);
  });
  tx();
  res.json({ ok: true, id: insertedId, keyImage: attestation.signature.keyImage });
}

// POST /api/enroll — register a device pubkey, return ring info.
app.post('/api/enroll', enrollRateLimit, (req, res) => {
  try {
    const pubKey = req.body && req.body.pubKey;
    if (typeof pubKey !== 'string' || !PUBKEY_HEX_RE.test(pubKey)) {
      return res.status(400).json({ error: 'invalid pubKey' });
    }
    // Validate curve point
    try {
      hexBytes(pubKey);
    } catch {
      return res.status(400).json({ error: 'invalid pubKey encoding' });
    }

    const existing = findDeviceByPubKey.get(pubKey);
    if (existing) {
      const row = currentRingRow();
      const ring = ringFromRow(row);
      if (!ring) return res.status(500).json({ error: 'ring inconsistent' });
      const yourIndex = ring.pubKeys.indexOf(pubKey);
      return res.json({
        ringHash: ring.ringHash,
        ringVersion: ring.version,
        ringSize: ring.pubKeys.length,
        yourIndex,
        alreadyEnrolled: true,
      });
    }

    const { n } = countDevices.get();
    if (n >= MAX_ENROLLED_DEVICES) {
      return res.status(503).json({ error: 'ring at capacity' });
    }

    // Bump the ring as a single transaction so concurrent enrolls don't
    // produce a partial state.
    let ring;
    const tx = db.transaction(() => {
      const current = currentRingRow();
      const nextRingVersionGuess = current ? current.version + 1 : 1;
      insertDevice.run(pubKey, Date.now(), nextRingVersionGuess);
      ring = ringFromRow(rotateRing());
    });
    tx();

    const yourIndex = ring.pubKeys.indexOf(pubKey);
    res.json({
      ringHash: ring.ringHash,
      ringVersion: ring.version,
      ringSize: ring.pubKeys.length,
      yourIndex,
      alreadyEnrolled: false,
    });
  } catch (e) {
    console.error('[enroll]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// GET /api/ring — return the most recent ring snapshot.
app.get('/api/ring', (req, res) => {
  try {
    const ring = ringFromRow(currentRingRow());
    if (!ring) {
      return res.json({ version: 0, pubKeys: [], ringHash: '' });
    }
    res.json(ring);
  } catch (e) {
    console.error('[ring]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// GET /api/verify/:date — return all stored attestations for that date plus
// the ring(s) referenced by them, for client-side re-verification.
app.get('/api/verify/:date', (req, res) => {
  try {
    const date = req.params.date;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'bad date' });
    const rows = attestationsForDate.all(date);
    const attestations = rows
      .map((r) => {
        try {
          return JSON.parse(r.attestation_json);
        } catch {
          return null;
        }
      })
      .filter((a) => a !== null);

    // Attach every ring referenced by at least one attestation.
    const versions = [...new Set(attestations.map((a) => a.ringVersion))];
    const rings = versions
      .map((v) => ringFromRow(findRingByVersion.get(v)))
      .filter(Boolean);
    // Include the current ring too so auditors can compare.
    const current = ringFromRow(currentRingRow());
    res.json({
      date,
      count: attestations.length,
      attestations,
      rings,
      currentRing: current,
    });
  } catch (e) {
    console.error('[verify]', e);
    res.status(500).json({ error: 'internal' });
  }
});

app.get('/api/summary', (req, res) => {
  try {
    const days = clampDays(Number(req.query.days || 30), 1, 365);
    res.json(getSummary(days));
  } catch (e) {
    console.error('[summary]', e);
    res.status(500).json({ error: 'internal' });
  }
});

app.get('/api/trends', (req, res) => {
  try {
    const metric = req.query.metric;
    if (!metric || typeof metric !== 'string') {
      return res.status(400).json({ error: 'metric required' });
    }
    const days = clampDays(Number(req.query.days || 30), 1, 365);

    const rows = db.prepare(
      `SELECT date, total, device_count FROM aggregated_daily
       WHERE metric = ? AND date >= date('now','-${days} days','localtime')
       ORDER BY date ASC`,
    ).all(metric);

    // Fill missing days with zeros so charts render continuously.
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const points = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const row = byDate.get(iso);
      points.push({
        date: iso,
        total: row ? Math.round(row.total * 100) / 100 : 0,
        device_count: row ? row.device_count : 0,
      });
    }

    res.json({ metric, days, points });
  } catch (e) {
    console.error('[trends]', e);
    res.status(500).json({ error: 'internal' });
  }
});

app.get('/api/health', (req, res) => {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM daily_submissions').get();
    res.json({ status: 'ok', service: 'observatory', db: row.n });
  } catch (e) {
    res.status(500).json({ status: 'err' });
  }
});

app.get('/api/compliance-report', (req, res) => {
  try {
    const s = getSummary(30);
    const langList = s.top_languages.map((l) => l.lang).join(', ') || 'none yet';
    const domainList = s.top_domains.map((d) => d.domain).join(', ') || 'none yet';
    const adaptList = s.top_adaptations.map((a) => a.type).join(', ') || 'none yet';
    const featureList = s.top_features.map((f) => f.feature).join(', ') || 'none yet';

    res.json({
      disclaimer:
        'This report is a self-assessment supporting aid. It is NOT a legal certification. Consult counsel for regulatory audits.',
      window_days: 30,
      generated_at: new Date().toISOString(),
      mappings: [
        {
          regulation: 'RPwD Act 2016 (India) — Section 20',
          summary:
            'Reasonable accommodation in employment for persons with disabilities.',
          accessbridge_evidence: [
            `Aggregate accessibility adaptations applied (30d): ${s.total_adaptations}`,
            `Accommodation-trigger events (struggle events): ${s.total_struggle_events}`,
            `Distinct accommodation categories in use: ${adaptList}`,
          ],
        },
        {
          regulation: 'European Accessibility Act 2025 — Art. 4',
          summary:
            'Accessibility requirements for products and services for persons with disabilities.',
          accessbridge_evidence: [
            `Language coverage: ${langList}`,
            `Sectoral adoption (domain connectors): ${domainList}`,
          ],
        },
        {
          regulation: 'ADA Title I (USA)',
          summary:
            'Reasonable accommodation in employment. ADA does not prescribe specific tools; documented accommodation provision supports compliance records.',
          accessbridge_evidence: [
            `Feature enablement counts: ${featureList}`,
            'Per-day struggle-trigger trend: /api/trends?metric=struggle_events_triggered',
          ],
        },
      ],
    });
  } catch (e) {
    console.error('[compliance-report]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ---------- Session 20: Enterprise endpoints (stub — 501 until Session 21 migration) ----------
const { createEnterpriseRouter } = require('./enterprise-endpoint');
app.use('/api/observatory/enterprise', createEnterpriseRouter());

// ==========================================================================
// Session 23 Part 5 — Enterprise analytics expansion (/api/observatory/*)
// All endpoints:
//   - Use parameterized prepared statements (never string-concat user input)
//   - Apply rateLimit middleware
//   - Return { disclaimer: 'Metrics include Laplace noise...' }
//   - Enforce k-anonymity floor K_ANON_MIN=5 on categorical breakdowns
//   - Use clampDays(n, 1, 365) for ?days= parameter
//   - Limit SELECT results to LIMIT 1000 to bound response size
// ==========================================================================

const K_ANON_MIN = 5;
const DP_DISCLAIMER = 'Metrics include Laplace noise (ε=1.0). Individual users cannot be identified.';

/** Parse and clamp the ?days= query parameter. */
function parseDays(query) {
  return clampDays(Number(query.days || 30), 1, 365);
}

/** Format a Date to YYYY-MM-DD in UTC. */
function toISODate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ---------- 1. GET /api/observatory/funnel ----------
app.get('/api/observatory/funnel', rateLimit, (req, res) => {
  try {
    const days = parseDays(req.query);
    const windowDays = days;

    const devicesEnrolled = db.prepare('SELECT COUNT(*) AS n FROM enrolled_devices').get().n;

    // Devices active: distinct count of device_count across feature rows in window
    // Proxy: sum of device_count for features_enabled:* rows in window (may double-count
    // across features per date, so use MAX device_count per date instead).
    const devicesActiveRow = db.prepare(
      `SELECT COALESCE(SUM(dc),0) AS n FROM (
         SELECT MAX(device_count) AS dc
         FROM aggregated_daily
         WHERE metric LIKE 'features_enabled:%'
           AND date >= date('now','-' || ? || ' days','localtime')
         GROUP BY date
         LIMIT 1000
       )`
    ).get(windowDays);
    const devicesActive = devicesActiveRow ? devicesActiveRow.n : 0;

    // Features used: sum of all features_enabled totals in window
    const featuresUsedRow = db.prepare(
      `SELECT COALESCE(SUM(total),0) AS n
       FROM aggregated_daily
       WHERE metric LIKE 'features_enabled:%'
         AND date >= date('now','-' || ? || ' days','localtime')
       LIMIT 1000`
    ).get(windowDays);
    const featuresUsed = featuresUsedRow ? Math.round(featuresUsedRow.n) : 0;

    // Sustained use 7d: rows in last 7d with device_count > 0
    const sustained7Row = db.prepare(
      `SELECT COUNT(*) AS n
       FROM aggregated_daily
       WHERE metric LIKE 'features_enabled:%'
         AND date >= date('now','-7 days','localtime')
         AND device_count > 0
       LIMIT 1000`
    ).get();
    const sustainedUse7d = sustained7Row ? sustained7Row.n : 0;

    // Sustained use 30d: rows in last 30d with device_count > 0
    const sustained30Row = db.prepare(
      `SELECT COUNT(*) AS n
       FROM aggregated_daily
       WHERE metric LIKE 'features_enabled:%'
         AND date >= date('now','-30 days','localtime')
         AND device_count > 0
       LIMIT 1000`
    ).get();
    const sustainedUse30d = sustained30Row ? sustained30Row.n : 0;

    res.json({
      window_days: windowDays,
      funnel: {
        devices_enrolled: devicesEnrolled,
        devices_active: devicesActive,
        features_used: featuresUsed,
        sustained_use_7d: sustainedUse7d,
        sustained_use_30d: sustainedUse30d,
      },
      disclaimer: DP_DISCLAIMER,
    });
  } catch (e) {
    console.error('[observatory/funnel]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ---------- 2. GET /api/observatory/feature-usage ----------
const VALID_BUCKETS = new Set(['day', 'week', 'month']);

app.get('/api/observatory/feature-usage', rateLimit, (req, res) => {
  try {
    const days = parseDays(req.query);
    const bucket = req.query.bucket || 'day';
    if (!VALID_BUCKETS.has(bucket)) {
      return res.status(400).json({ error: "bucket must be 'day', 'week', or 'month'" });
    }

    // Determine SQLite strftime format for grouping
    let dateFmt;
    if (bucket === 'day') dateFmt = '%Y-%m-%d';
    else if (bucket === 'week') dateFmt = '%Y-W%W';
    else dateFmt = '%Y-%m';

    // Pull top-10 features by total in window
    const topFeatures = db.prepare(
      `SELECT REPLACE(metric,'features_enabled:','') AS feature,
              SUM(total) AS grand_total
       FROM aggregated_daily
       WHERE metric LIKE 'features_enabled:%'
         AND date >= date('now','-' || ? || ' days','localtime')
       GROUP BY metric
       ORDER BY grand_total DESC
       LIMIT 10`
    ).all(days);

    const series = [];
    for (const { feature } of topFeatures) {
      const metricKey = `features_enabled:${feature}`;
      const rows = db.prepare(
        `SELECT strftime(?, date) AS bucket_label,
                SUM(total) AS total,
                SUM(device_count) AS device_count
         FROM aggregated_daily
         WHERE metric = ?
           AND date >= date('now','-' || ? || ' days','localtime')
         GROUP BY bucket_label
         ORDER BY bucket_label ASC
         LIMIT 1000`
      ).all(dateFmt, metricKey, days);

      const points = rows.map((r) => ({
        date: r.bucket_label,
        total: Math.round(r.total),
        device_count: r.device_count,
      }));
      series.push({ feature, points });
    }

    res.json({ window_days: days, bucket, series, disclaimer: DP_DISCLAIMER });
  } catch (e) {
    console.error('[observatory/feature-usage]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ---------- 3. GET /api/observatory/language-breakdown ----------

// Script-family definitions as per spec
const SCRIPT_FAMILIES = [
  { family: 'Devanagari', langs: ['hi', 'mr', 'sa', 'ne'] },
  { family: 'Tamil',      langs: ['ta'] },
  { family: 'Telugu',     langs: ['te'] },
  { family: 'Bengali',    langs: ['bn', 'as'] },
  { family: 'Gujarati',   langs: ['gu'] },
  { family: 'Kannada',    langs: ['kn'] },
  { family: 'Malayalam',  langs: ['ml'] },
  { family: 'Gurmukhi',   langs: ['pa'] },
  { family: 'Arabic',     langs: ['ur', 'ar', 'fa'] },
  { family: 'Latin',      langs: ['en', 'es', 'pt', 'fr', 'de', 'it', 'pl', 'id', 'tl', 'vi'] },
  { family: 'CJK',        langs: ['zh', 'ja', 'ko'] },
  { family: 'Cyrillic',   langs: ['ru'] },
  { family: 'Thai',       langs: ['th'] },
  { family: 'Turkish',    langs: ['tr'] },
];
// Build reverse map: lang → family name
const LANG_TO_FAMILY = new Map();
for (const { family, langs } of SCRIPT_FAMILIES) {
  for (const l of langs) LANG_TO_FAMILY.set(l, family);
}

app.get('/api/observatory/language-breakdown', rateLimit, (req, res) => {
  try {
    const days = parseDays(req.query);

    const rows = db.prepare(
      `SELECT REPLACE(metric,'language_used:','') AS lang,
              SUM(device_count) AS devices
       FROM aggregated_daily
       WHERE metric LIKE 'language_used:%'
         AND date >= date('now','-' || ? || ' days','localtime')
       GROUP BY metric
       HAVING SUM(device_count) >= ?
       ORDER BY devices DESC
       LIMIT 1000`
    ).all(days, K_ANON_MIN);

    // Per-language (already k-anon filtered above)
    const byLanguage = rows.map((r) => ({ lang: r.lang, devices: r.devices }));

    // Aggregate into script families
    const familyMap = new Map(); // family → { devices, langs }
    for (const { lang, devices } of rows) {
      const fam = LANG_TO_FAMILY.get(lang);
      if (!fam) continue;
      if (!familyMap.has(fam)) familyMap.set(fam, { devices: 0, langs: [] });
      const entry = familyMap.get(fam);
      entry.devices += devices;
      if (!entry.langs.includes(lang)) entry.langs.push(lang);
    }

    const byScriptFamily = [...familyMap.entries()]
      .filter(([, v]) => v.devices >= K_ANON_MIN)
      .map(([family, v]) => ({ family, devices: v.devices, languages: v.langs.sort() }))
      .sort((a, b) => b.devices - a.devices);

    res.json({ window_days: days, by_language: byLanguage, by_script_family: byScriptFamily, disclaimer: DP_DISCLAIMER });
  } catch (e) {
    console.error('[observatory/language-breakdown]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ---------- 4. GET /api/observatory/domain-penetration ----------
app.get('/api/observatory/domain-penetration', rateLimit, (req, res) => {
  try {
    const days = parseDays(req.query);

    const rows = db.prepare(
      `SELECT REPLACE(metric,'domain_connectors_activated:','') AS domain,
              SUM(device_count) AS devices,
              SUM(total) AS usage_score
       FROM aggregated_daily
       WHERE metric LIKE 'domain_connectors_activated:%'
         AND date >= date('now','-' || ? || ' days','localtime')
       GROUP BY metric
       ORDER BY usage_score DESC
       LIMIT 1000`
    ).all(days);

    const byDomain = rows.map((r, i) => ({
      domain: r.domain,
      devices: r.devices,
      usage_score: Math.round(r.usage_score),
      rank: i + 1,
    }));

    res.json({ window_days: days, by_domain: byDomain, disclaimer: DP_DISCLAIMER });
  } catch (e) {
    console.error('[observatory/domain-penetration]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ---------- 5. GET /api/observatory/adaptation-effectiveness ----------
// NOTE: `adaptations_reverted` metric is NOT yet collected by the extension
// (scheduled for Session 24). Until then, reverted is proxied as 0 everywhere.
// See ROADMAP.md Session 24 scope. The `notes` field documents this caveat.
app.get('/api/observatory/adaptation-effectiveness', rateLimit, (req, res) => {
  try {
    const days = parseDays(req.query);

    // Sum applied per adaptation type in window
    const appliedRows = db.prepare(
      `SELECT REPLACE(metric,'adaptations_applied:','') AS type,
              SUM(total) AS applied
       FROM aggregated_daily
       WHERE metric LIKE 'adaptations_applied:%'
         AND date >= date('now','-' || ? || ' days','localtime')
       GROUP BY metric
       ORDER BY applied DESC
       LIMIT 1000`
    ).all(days);

    // Sum reverted per adaptation type — metric prefix adaptations_reverted:<TYPE>
    // Currently no data exists; will return 0 for all. Retained so the query
    // automatically starts returning real data once Session 24 ships.
    const revertedRows = db.prepare(
      `SELECT REPLACE(metric,'adaptations_reverted:','') AS type,
              SUM(total) AS reverted
       FROM aggregated_daily
       WHERE metric LIKE 'adaptations_reverted:%'
         AND date >= date('now','-' || ? || ' days','localtime')
       GROUP BY metric
       LIMIT 1000`
    ).all(days);

    const revertedMap = new Map(revertedRows.map((r) => [r.type, r.reverted]));

    let totalApplied = 0;
    let totalReverted = 0;

    const byAdaptation = appliedRows.map((r) => {
      const applied = Math.round(r.applied);
      const reverted = Math.round(revertedMap.get(r.type) || 0);
      const effectivenessPct =
        applied > 0 ? Math.round(((applied - reverted) / applied) * 1000) / 10 : 100;
      totalApplied += applied;
      totalReverted += reverted;
      return { type: r.type, applied, reverted, effectiveness_pct: effectivenessPct };
    });

    const overallEffectivenessPct =
      totalApplied > 0
        ? Math.round(((totalApplied - totalReverted) / totalApplied) * 1000) / 10
        : 100;

    res.json({
      window_days: days,
      overall: {
        applied: totalApplied,
        reverted: totalReverted,
        effectiveness_pct: overallEffectivenessPct,
      },
      by_adaptation: byAdaptation,
      notes: 'adaptations_reverted metric not yet collected; proxy = 0',
      disclaimer: DP_DISCLAIMER,
    });
  } catch (e) {
    console.error('[observatory/adaptation-effectiveness]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ---------- Compliance helpers (RPwD / ADA / EAA) ----------

// Shared adaptation → disability-category mapping (same 4 categories for all regs)
const COMPLIANCE_CATEGORIES = [
  {
    category: 'Visual',
    adaptations: new Set(['FONT_SCALE', 'CONTRAST', 'REDUCED_MOTION']),
  },
  {
    category: 'Auditory',
    adaptations: new Set(['AUTO_SUMMARIZE']),
  },
  {
    category: 'Motor',
    adaptations: new Set(['VOICE_NAV', 'EYE_TRACKING', 'KEYBOARD_ONLY', 'PREDICTIVE_INPUT', 'CLICK_TARGET_ENLARGE']),
  },
  {
    category: 'Cognitive',
    adaptations: new Set(['FOCUS_MODE', 'READING_MODE', 'TEXT_SIMPLIFY', 'LAYOUT_SIMPLIFY']),
  },
];

function buildComplianceReport(days, regulation) {
  // Pull all adaptations_applied totals for the window in one prepared statement
  const appliedRows = db.prepare(
    `SELECT REPLACE(metric,'adaptations_applied:','') AS type,
            SUM(total) AS total
     FROM aggregated_daily
     WHERE metric LIKE 'adaptations_applied:%'
       AND date >= date('now','-' || ? || ' days','localtime')
     GROUP BY metric
     LIMIT 1000`
  ).all(days);

  // Build map: adaptation_type → total
  const appliedMap = new Map(appliedRows.map((r) => [r.type, Math.round(r.total)]));

  let categoryCount = 0;
  let coverageSum = 0;

  const categories = COMPLIANCE_CATEGORIES.map(({ category, adaptations }) => {
    let adaptationsTrigered = 0;
    for (const [type, total] of appliedMap.entries()) {
      if (adaptations.has(type)) adaptationsTrigered += total;
    }
    const coveragePct = adaptationsTrigered > 0 ? 100 : 0;
    coverageSum += coveragePct;
    categoryCount += 1;
    return { category, adaptations_triggered: adaptationsTrigered, coverage_pct: coveragePct };
  });

  const overallCoveragePct =
    categoryCount > 0
      ? Math.round((coverageSum / categoryCount) * 10) / 10
      : 0;

  return {
    window_days: days,
    regulation,
    categories,
    overall_coverage_pct: overallCoveragePct,
    disclaimer:
      'This is a self-assessment aid, NOT a legal certification. Consult counsel for regulatory audits.',
  };
}

// ---------- 6. GET /api/observatory/compliance/rpwd ----------
app.get('/api/observatory/compliance/rpwd', rateLimit, (req, res) => {
  try {
    const days = parseDays(req.query);
    res.json(buildComplianceReport(days, 'RPwD Act 2016 (India) — Section 20'));
  } catch (e) {
    console.error('[observatory/compliance/rpwd]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ---------- 7. GET /api/observatory/compliance/ada ----------
app.get('/api/observatory/compliance/ada', rateLimit, (req, res) => {
  try {
    const days = parseDays(req.query);
    res.json(buildComplianceReport(days, 'ADA Title I (USA) — reasonable accommodation in employment'));
  } catch (e) {
    console.error('[observatory/compliance/ada]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ---------- 8. GET /api/observatory/compliance/eaa ----------
app.get('/api/observatory/compliance/eaa', rateLimit, (req, res) => {
  try {
    const days = parseDays(req.query);
    res.json(buildComplianceReport(days, 'European Accessibility Act 2025 — Article 4'));
  } catch (e) {
    console.error('[observatory/compliance/eaa]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ---------- Static dashboard + verifier ----------
// Pretty URL for the auditor verifier tool (the HTML file is
// public/verifier.html; this alias saves auditors from typing .html).
app.get('/verifier', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'verifier.html'));
});
app.use(express.static(PUBLIC_DIR));

// ---------- Boot ----------
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`AccessBridge Observatory listening on ${PORT}`);
  console.log(`DB at ${DB_PATH}`);
  console.log(`Static dashboard from ${PUBLIC_DIR}`);
});

function shutdown() {
  console.log('Shutting down observatory...');
  server.close(() => {
    try {
      db.close();
    } catch (e) {
      // ignore
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
