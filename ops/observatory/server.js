/**
 * AccessBridge Compliance Observatory service.
 * Receives DP-noised daily counter bundles from the extension, aggregates them
 * per-metric-per-date, and exposes summary/trends/compliance endpoints.
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

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

// ---------- Routes ----------
app.post('/api/publish', rateLimit, (req, res) => {
  try {
    const err = validateBundle(req.body);
    if (err) return res.status(400).json({ error: 'invalid bundle' });
    // Reject forged bundles: client-declared merkle_root must match the canonical
    // hash we would independently compute. Prevents metric fabrication.
    if (!verifyMerkle(req.body)) return res.status(400).json({ error: 'invalid bundle' });
    const result = aggregateBundle(req.body);
    res.json({ ok: true, id: result.id, duplicate: result.duplicate });
  } catch (e) {
    console.error('[publish]', e);
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

// ---------- Static dashboard ----------
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
