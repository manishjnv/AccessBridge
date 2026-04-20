/**
 * Seed 30 days × up-to-47 synthetic devices of DP-noised counters into the
 * observatory DB. Exits idempotently if data already present (unless --force).
 */

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data.db');
const FORCE = process.argv.includes('--force');

const db = new Database(DB_PATH);

// Same schema as server.js — keep in sync.
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_at INTEGER NOT NULL,
    date TEXT NOT NULL,
    counters_json TEXT NOT NULL,
    merkle_root TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_submissions_date ON daily_submissions(date);
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

const existing = db.prepare('SELECT COUNT(*) AS n FROM daily_submissions').get().n;
if (existing > 0 && !FORCE) {
  console.log(`DB already populated (${existing} submissions); skipping. Pass --force to reseed.`);
  db.close();
  process.exit(0);
}
if (FORCE) {
  db.exec('DELETE FROM daily_submissions; DELETE FROM aggregated_daily;');
  console.log('Cleared existing data (--force).');
}

// ---------- RNG ----------
function cryptoUniform() {
  const buf = crypto.randomBytes(4);
  return buf.readUInt32BE(0) / 0x1_0000_0000;
}

function addLaplaceNoise(count, epsilon, sensitivity) {
  const b = sensitivity / epsilon;
  let u = cryptoUniform() - 0.5;
  if (u === 0) u = 0.0001;
  const sign = u < 0 ? -1 : 1;
  const noise = -b * sign * Math.log(1 - 2 * Math.abs(u));
  return Math.max(0, Math.round(count + noise));
}

function bernoulli(p) {
  return Math.random() < p;
}

function randomInt(lo, hi) {
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function pickWeighted(items) {
  const total = items.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it.value;
  }
  return items[items.length - 1].value;
}

function pickMany(items, count) {
  const picked = new Set();
  const clone = [...items];
  while (picked.size < Math.min(count, clone.length)) {
    picked.add(pickWeighted(clone));
  }
  return [...picked];
}

// ---------- Merkle root (node crypto, matches extension canonical form) ----------
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function merkleRoot(items) {
  if (items.length === 0) return sha256(Buffer.from('')).toString('hex');
  let layer = items.map((s) => sha256(Buffer.from(s, 'utf-8')));
  while (layer.length > 1) {
    if (layer.length % 2) layer.push(layer[layer.length - 1]);
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(sha256(Buffer.concat([layer[i], layer[i + 1]])));
    }
    layer = next;
  }
  return layer[0].toString('hex');
}

function canonicalLines(bundle) {
  const lines = [];
  for (const [k, v] of Object.entries(bundle.adaptations_applied)) lines.push(`adaptations_applied:${k}=${v}`);
  lines.push(`struggle_events_triggered:=${bundle.struggle_events_triggered}`);
  for (const [k, v] of Object.entries(bundle.features_enabled)) lines.push(`features_enabled:${k}=${v}`);
  for (const [k, v] of Object.entries(bundle.domain_connectors_activated)) lines.push(`domain_connectors_activated:${k}=${v}`);
  const langs = [...new Set(bundle.languages_used)].sort();
  lines.push(`languages_used:=[${langs.join(',')}]`);
  lines.push(`estimated_accessibility_score_improvement:=${bundle.estimated_accessibility_score_improvement}`);
  lines.sort();
  return lines;
}

// ---------- Distributions ----------
const ADAPTATION_TYPES = [
  { value: 'FONT_SCALE', weight: 0.5, mean: 2 },
  { value: 'CONTRAST', weight: 0.3, mean: 1 },
  { value: 'READING_MODE', weight: 0.25, mean: 2 },
  { value: 'FOCUS_MODE', weight: 0.3, mean: 3 },
  { value: 'VOICE_NAV', weight: 0.15, mean: 1 },
  { value: 'EYE_TRACKING', weight: 0.08, mean: 1 },
  { value: 'LAYOUT_SIMPLIFY', weight: 0.2, mean: 2 },
  { value: 'TEXT_SIMPLIFY', weight: 0.25, mean: 2 },
  { value: 'KEYBOARD_ONLY', weight: 0.2, mean: 1 },
  { value: 'PREDICTIVE_INPUT', weight: 0.15, mean: 2 },
];

const FEATURE_NAMES = [
  'focus_mode', 'voice_nav', 'eye_tracking', 'keyboard_only', 'predictive_input', 'dwell_click',
];

const LANGUAGES = [
  { value: 'hi', weight: 30 },
  { value: 'en', weight: 40 },
  { value: 'ta', weight: 10 },
  { value: 'bn', weight: 8 },
  { value: 'te', weight: 5 },
  { value: 'mr', weight: 3 },
  { value: 'gu', weight: 2 },
  { value: 'kn', weight: 1.5 },
  { value: 'ml', weight: 1 },
  { value: 'pa', weight: 0.5 },
];

const DOMAINS = [
  { value: 'banking', weight: 0.4 },
  { value: 'insurance', weight: 0.3 },
  { value: 'telecom', weight: 0.25 },
  { value: 'retail', weight: 0.35 },
  { value: 'healthcare', weight: 0.25 },
  { value: 'manufacturing', weight: 0.15 },
];

function genRawCounters(dayIndex) {
  const adaptations_applied = {};
  for (const a of ADAPTATION_TYPES) {
    if (Math.random() < a.weight) {
      adaptations_applied[a.value] = randomInt(1, Math.max(1, Math.round(a.mean * 2)));
    }
  }
  const struggle_events_triggered = Math.random() < 0.7 ? randomInt(0, 4) : randomInt(4, 8);
  const features_enabled = {};
  for (const f of FEATURE_NAMES) {
    if (Math.random() < 0.3) features_enabled[f] = 1;
  }
  const languages_used = pickMany(LANGUAGES, randomInt(1, 2));
  const domain_connectors_activated = {};
  for (const d of DOMAINS) {
    if (Math.random() < d.weight / 2) domain_connectors_activated[d.value] = randomInt(1, 3);
  }
  // Slight upward drift in score over 30 days
  const base = 40 + dayIndex * 0.4;
  const estimated_accessibility_score_improvement = Math.max(0, Math.min(100, Math.round(base + randomInt(-15, 20))));

  return {
    adaptations_applied,
    struggle_events_triggered,
    features_enabled,
    languages_used,
    domain_connectors_activated,
    estimated_accessibility_score_improvement,
  };
}

function applyNoise(raw) {
  const noised = {
    adaptations_applied: {},
    struggle_events_triggered: addLaplaceNoise(raw.struggle_events_triggered, 1.0, 1),
    features_enabled: {},
    languages_used: [...new Set(raw.languages_used)].sort(),
    domain_connectors_activated: {},
    estimated_accessibility_score_improvement: Math.max(0, Math.min(100, addLaplaceNoise(raw.estimated_accessibility_score_improvement, 1.0, 1))),
  };
  for (const [k, v] of Object.entries(raw.adaptations_applied)) noised.adaptations_applied[k] = addLaplaceNoise(v, 1.0, 1);
  for (const [k, v] of Object.entries(raw.features_enabled)) noised.features_enabled[k] = addLaplaceNoise(v, 1.0, 1);
  for (const [k, v] of Object.entries(raw.domain_connectors_activated)) noised.domain_connectors_activated[k] = addLaplaceNoise(v, 1.0, 1);
  return noised;
}

function dayISO(dayOffsetFromToday) {
  const d = new Date();
  d.setDate(d.getDate() - dayOffsetFromToday);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- Insertion ----------
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

const run = db.transaction(() => {
  const DAYS = 30;
  let totalSubmissions = 0;
  const metricSet = new Set();

  // Ramp adoption: day 1 → 12 devices, day 30 → 47 devices
  for (let d = 0; d < DAYS; d++) {
    const devicesToday = Math.round(12 + (47 - 12) * (d / (DAYS - 1)));
    const date = dayISO(DAYS - 1 - d);

    for (let dev = 0; dev < devicesToday; dev++) {
      const raw = genRawCounters(d);
      const noised = applyNoise(raw);
      const bundle = { date, schema_version: 1, ...noised };
      const lines = canonicalLines(bundle);
      bundle.merkle_root = merkleRoot(lines);

      const submittedAt = Date.now() - (DAYS - 1 - d) * 86_400_000 - randomInt(0, 4 * 3_600_000);
      insertSubmission.run(submittedAt, date, JSON.stringify(bundle), bundle.merkle_root);
      totalSubmissions += 1;

      for (const [k, v] of Object.entries(noised.adaptations_applied)) {
        upsertAggregate.run(date, `adaptations_applied:${k}`, v);
        metricSet.add(`adaptations_applied:${k}`);
      }
      upsertAggregate.run(date, 'struggle_events_triggered', noised.struggle_events_triggered);
      metricSet.add('struggle_events_triggered');
      for (const [k, v] of Object.entries(noised.features_enabled)) {
        upsertAggregate.run(date, `features_enabled:${k}`, v);
        metricSet.add(`features_enabled:${k}`);
      }
      for (const [k, v] of Object.entries(noised.domain_connectors_activated)) {
        upsertAggregate.run(date, `domain_connectors_activated:${k}`, v);
        metricSet.add(`domain_connectors_activated:${k}`);
      }
      upsertAggregate.run(date, 'estimated_accessibility_score_improvement', noised.estimated_accessibility_score_improvement);
      metricSet.add('estimated_accessibility_score_improvement');
      for (const lang of noised.languages_used) {
        upsertAggregate.run(date, `language_used:${lang}`, 1);
        metricSet.add(`language_used:${lang}`);
      }
    }
  }

  return { totalSubmissions, metricCount: metricSet.size };
});

try {
  const { totalSubmissions, metricCount } = run();
  console.log(`Seeded ${totalSubmissions} device-days across 30 days.`);
  console.log(`Distinct metrics in aggregated_daily: ${metricCount}.`);
  db.close();
  process.exit(0);
} catch (err) {
  console.error('Seed failed:', err);
  try { db.close(); } catch (e) {}
  process.exit(1);
}
