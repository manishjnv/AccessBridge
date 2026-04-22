/**
 * Tests for Session 24 — Pilot Rollout Orchestrator endpoints (/api/pilot/*).
 *
 * Uses Node built-in test runner (node --test) + raw http module.
 * Spins up a minimal Express app with an in-memory SQLite DB that reproduces
 * exactly the route + schema logic from server.js (no file I/O, no real port 8200).
 *
 * Run: node --test __tests__/pilot-orchestrator.test.js
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

// ---- In-memory DB ----
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_at INTEGER NOT NULL,
    date TEXT NOT NULL,
    counters_json TEXT NOT NULL,
    merkle_root TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS aggregated_daily (
    date TEXT NOT NULL,
    metric TEXT NOT NULL,
    total REAL NOT NULL,
    device_count INTEGER NOT NULL,
    PRIMARY KEY(date, metric)
  );
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
    pilot_id INTEGER,
    UNIQUE(date, key_image)
  );
  CREATE TABLE IF NOT EXISTS pilots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    preset TEXT NOT NULL,
    target_size INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pilot_enrollments (
    pilot_id INTEGER NOT NULL,
    device_pub_key TEXT NOT NULL,
    enrolled_at INTEGER NOT NULL,
    PRIMARY KEY (pilot_id, device_pub_key)
  );
  CREATE INDEX IF NOT EXISTS idx_pilot_enrollments_pilot_id ON pilot_enrollments(pilot_id);
  CREATE TABLE IF NOT EXISTS pilot_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pilot_id INTEGER NOT NULL,
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    comment_hash TEXT,
    comment_text TEXT,
    device_hash TEXT NOT NULL,
    submitted_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pilot_feedback_pilot_id ON pilot_feedback(pilot_id);
`);

// ---- Constants ----
const PILOT_K_ANON = 20;
const K_ANON_MIN = 5;
const PUBKEY_HEX_RE = /^[0-9a-f]{64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PILOT_NAME_RE = /^[a-zA-Z0-9 _-]+$/;
const PILOT_PRESET_RE = /^[a-z0-9-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEST_ADMIN_TOKEN = 'test-admin-token-for-unit-tests';

// ---- Helpers ----
function isValidISODate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(a, b) {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db2 = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db2 - da) / 86_400_000);
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  const safe = s.replace(/[\r\n]/g, ' ');
  const INJECTION_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);
  const first = safe.charAt(0);
  const prefix = INJECTION_CHARS.has(first) ? "'" : '';
  if (safe.includes(',')) return `"${prefix}${safe.replace(/"/g, '""')}"`;
  return prefix + safe;
}

function sanitizeComment(s) {
  if (typeof s !== 'string') return null;
  const truncated = s.slice(0, 500);
  return truncated
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[‪-‮⁦-⁩]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'is','are','was','were','be','been','being','have','has','had','do','does',
  'did','will','would','could','should','may','might','shall','not','no',
  'it','its','this','that','these','those','i','we','you','he','she','they',
  'my','our','your','his','her','their','me','us','him','them','what','which',
  'who','how','when','where','why','all','any','some','very','just','so',
  'hai','hain','ka','ki','ke','ko','se','mein','par','aur','yeh','jo','kya',
  'nahi','nahin','tha','thi','the','hoga','hogi','honge','bhi','hi','toh',
]);

// ---- Prepared statements ----
const insertPilot = db.prepare(
  'INSERT INTO pilots (name, preset, target_size, start_date, end_date, contact_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
const findPilotById = db.prepare('SELECT * FROM pilots WHERE id = ?');
const upsertPilotEnrollment = db.prepare(
  'INSERT OR IGNORE INTO pilot_enrollments (pilot_id, device_pub_key, enrolled_at) VALUES (?, ?, ?)',
);
const countPilotEnrollments = db.prepare(
  'SELECT COUNT(*) AS n FROM pilot_enrollments WHERE pilot_id = ?',
);
const insertPilotFeedback = db.prepare(
  'INSERT INTO pilot_feedback (pilot_id, rating, comment_hash, comment_text, device_hash, submitted_at) VALUES (?, ?, ?, ?, ?, ?)',
);
const countPilotFeedback = db.prepare(
  'SELECT COUNT(*) AS n FROM pilot_feedback WHERE pilot_id = ?',
);
const feedbackAggByDay = db.prepare(
  `SELECT strftime('%Y-%m-%d', submitted_at / 1000, 'unixepoch') AS date,
          ROUND(AVG(rating), 2) AS avg_rating,
          COUNT(*) AS count
   FROM pilot_feedback
   WHERE pilot_id = ?
   GROUP BY date
   ORDER BY date ASC
   LIMIT 365`,
);
const feedbackAllComments = db.prepare(
  'SELECT comment_text FROM pilot_feedback WHERE pilot_id = ? AND comment_text IS NOT NULL LIMIT 5000',
);

// ---- Admin token middleware ----
function requirePilotAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const maxLen = Math.max(token.length, TEST_ADMIN_TOKEN.length);
  const a = Buffer.from(token.padEnd(maxLen, '\0'));
  const b = Buffer.from(TEST_ADMIN_TOKEN.padEnd(maxLen, '\0'));
  const timingSafe = crypto.timingSafeEqual(a, b);
  if (!timingSafe || token.length !== TEST_ADMIN_TOKEN.length) {
    return res.status(401).json({ error: 'invalid admin token' });
  }
  next();
}

// ---- Rate limit buckets (pilot-specific, prune on write BUG-013) ----
const PILOT_ENROLL_WINDOW_MS = 60 * 60 * 1000;
const PILOT_ENROLL_LIMIT = 10;
const pilotEnrollBuckets = new Map();

function pilotEnrollRateLimit(req, res, next) {
  const ip = req.ip || 'test';
  const now = Date.now();
  for (const [k, v] of pilotEnrollBuckets.entries()) {
    if (now - v.windowStart > PILOT_ENROLL_WINDOW_MS * 2) pilotEnrollBuckets.delete(k);
  }
  let bucket = pilotEnrollBuckets.get(ip);
  if (!bucket) { bucket = { count: 0, windowStart: now }; pilotEnrollBuckets.set(ip, bucket); }
  if (now - bucket.windowStart > PILOT_ENROLL_WINDOW_MS) { bucket.count = 0; bucket.windowStart = now; }
  bucket.count += 1;
  if (bucket.count > PILOT_ENROLL_LIMIT) return res.status(429).json({ error: 'rate limited' });
  next();
}

const PILOT_FEEDBACK_WINDOW_MS = 60 * 60 * 1000;
const PILOT_FEEDBACK_LIMIT = 5;
const pilotFeedbackBuckets = new Map();

function pilotFeedbackRateLimit(req, res, next) {
  const key = (req.body && typeof req.body.device_hash === 'string' && req.body.device_hash)
    ? `dh:${req.body.device_hash}`
    : `ip:${req.ip || 'test'}`;
  const now = Date.now();
  for (const [k, v] of pilotFeedbackBuckets.entries()) {
    if (now - v.windowStart > PILOT_FEEDBACK_WINDOW_MS * 2) pilotFeedbackBuckets.delete(k);
  }
  let bucket = pilotFeedbackBuckets.get(key);
  if (!bucket) { bucket = { count: 0, windowStart: now }; pilotFeedbackBuckets.set(key, bucket); }
  if (now - bucket.windowStart > PILOT_FEEDBACK_WINDOW_MS) { bucket.count = 0; bucket.windowStart = now; }
  bucket.count += 1;
  if (bucket.count > PILOT_FEEDBACK_LIMIT) return res.status(429).json({ error: 'rate limited' });
  next();
}

// General rate limiter (60/min)
const rateBuckets = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
function rateLimit(req, res, next) {
  const ip = req.ip || 'test';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket) { bucket = { count: 0, windowStart: now }; rateBuckets.set(ip, bucket); }
  if (now - bucket.windowStart > RATE_WINDOW_MS) { bucket.count = 0; bucket.windowStart = now; }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT) return res.status(429).json({ error: 'rate limited' });
  next();
}

// ---- Express app ----
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// POST /api/pilot/enrollments
app.post('/api/pilot/enrollments', requirePilotAdmin, (req, res) => {
  try {
    const { name, preset, target_size, start_date, end_date, contact_email } = req.body || {};
    if (typeof name !== 'string' || name.length === 0 || name.length > 80 || !PILOT_NAME_RE.test(name))
      return res.status(400).json({ error: 'name must be 1–80 chars, alphanumeric/space/_/-' });
    if (typeof preset !== 'string' || !PILOT_PRESET_RE.test(preset))
      return res.status(400).json({ error: 'preset must match /^[a-z0-9-]+$/' });
    if (!Number.isInteger(target_size) || target_size < 10 || target_size > 10000)
      return res.status(400).json({ error: 'target_size must be integer 10–10000' });
    if (!isValidISODate(start_date) || !isValidISODate(end_date))
      return res.status(400).json({ error: 'start_date and end_date must be valid YYYY-MM-DD' });
    if (start_date >= end_date)
      return res.status(400).json({ error: 'start_date must be before end_date' });
    if (typeof contact_email !== 'string' || !EMAIL_RE.test(contact_email))
      return res.status(400).json({ error: 'invalid contact_email' });

    const created_at = Date.now();
    let result;
    try {
      result = insertPilot.run(name, preset, target_size, start_date, end_date, contact_email, created_at);
    } catch (e) {
      if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'pilot name exists' });
      throw e;
    }
    res.status(201).json({ pilot_id: result.lastInsertRowid, created_at });
  } catch (e) {
    res.status(500).json({ error: 'internal' });
  }
});

// GET /api/pilot/:id/status
app.get('/api/pilot/:id/status', rateLimit, (req, res) => {
  try {
    const pilotId = Number(req.params.id);
    if (!Number.isInteger(pilotId) || pilotId <= 0) return res.status(400).json({ error: 'invalid pilot id' });
    const pilot = findPilotById.get(pilotId);
    if (!pilot) return res.status(404).json({ error: 'pilot not found' });
    const { n: enrolled_count } = countPilotEnrollments.get(pilotId);
    if (enrolled_count < PILOT_K_ANON) {
      return res.json({
        pilot_id: pilotId, name: pilot.name, enrolled_count,
        status: 'gated', reason: `pilot cohort below N=${PILOT_K_ANON} disclosure floor`,
      });
    }
    const featureRows = db.prepare(
      `SELECT REPLACE(metric,'features_enabled:','') AS feature, SUM(total) AS cnt
       FROM aggregated_daily WHERE metric LIKE 'features_enabled:%' AND date BETWEEN ? AND ?
       GROUP BY metric ORDER BY cnt DESC LIMIT 20`
    ).all(pilot.start_date, pilot.end_date);
    const feature_adoption = {};
    for (const row of featureRows) feature_adoption[row.feature] = Math.round(row.cnt);
    res.json({
      pilot_id: pilotId, name: pilot.name, preset: pilot.preset,
      target_size: pilot.target_size, enrolled_count, active_count_24h: 0,
      struggle_rate: null, effectiveness_rate: null,
      _notes: 'struggle_rate and effectiveness_rate null: not per-pilot attributed',
      feature_adoption,
    });
  } catch (e) {
    res.status(500).json({ error: 'internal' });
  }
});

// GET /api/pilot/:id/results
app.get('/api/pilot/:id/results', rateLimit, (req, res) => {
  try {
    const pilotId = Number(req.params.id);
    if (!Number.isInteger(pilotId) || pilotId <= 0) return res.status(400).json({ error: 'invalid pilot id' });
    const pilot = findPilotById.get(pilotId);
    if (!pilot) return res.status(404).json({ error: 'pilot not found' });
    const { n: enrolled_count } = countPilotEnrollments.get(pilotId);
    if (enrolled_count < PILOT_K_ANON) {
      return res.json({ pilot_id: pilotId, name: pilot.name, enrolled_count, status: 'gated', reason: `pilot cohort below N=${PILOT_K_ANON} disclosure floor` });
    }
    const durationDays = daysBetween(pilot.start_date, pilot.end_date);
    res.json({
      pilot_id: pilotId, name: pilot.name, preset: pilot.preset, duration_days: durationDays,
      cohort: { target_size: pilot.target_size, enrolled: enrolled_count, active_during_pilot: 0 },
      metrics: {
        install_rate: { value: enrolled_count / pilot.target_size, target: 0.80, status: 'unknown' },
        daily_active: { value: null, target: 0.70, status: 'unknown' },
        adaptations_per_user_per_day: { value: null, target_min: 5, target_max: 15, status: 'unknown' },
        voice_commands_per_day: { value: null, target_min: 10, status: 'unknown' },
        indian_language_usage: { value: null, target_min: 0.50, status: 'unknown' },
      },
      satisfaction_score: null, top_issues: [], recommendations: [],
    });
  } catch (e) {
    res.status(500).json({ error: 'internal' });
  }
});

// GET /api/pilot/:id/export.csv
app.get('/api/pilot/:id/export.csv', rateLimit, (req, res) => {
  try {
    const pilotId = Number(req.params.id);
    if (!Number.isInteger(pilotId) || pilotId <= 0) return res.status(400).json({ error: 'invalid pilot id' });
    const pilot = findPilotById.get(pilotId);
    if (!pilot) return res.status(404).json({ error: 'pilot not found' });
    const { n: enrolled_count } = countPilotEnrollments.get(pilotId);
    if (enrolled_count < PILOT_K_ANON) return res.status(403).json({ error: 'gated', reason: `pilot cohort below N=${PILOT_K_ANON} disclosure floor` });
    const rows = db.prepare(
      `SELECT date, metric, total AS total_noised, device_count
       FROM aggregated_daily WHERE date BETWEEN ? AND ?
       ORDER BY date ASC, metric ASC LIMIT 5000`
    ).all(pilot.start_date, pilot.end_date);
    const lines = ['date,metric,total_noised,device_count'];
    for (const row of rows) {
      lines.push([
        csvEscape(row.date), csvEscape(row.metric),
        csvEscape(String(Math.round(row.total_noised * 100) / 100)),
        csvEscape(String(row.device_count)),
      ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pilot-${pilotId}-export.csv"`);
    res.send(lines.join('\r\n'));
  } catch (e) {
    res.status(500).json({ error: 'internal' });
  }
});

// POST /api/pilot/:id/enroll-device
app.post('/api/pilot/:id/enroll-device', pilotEnrollRateLimit, (req, res) => {
  try {
    const pilotId = Number(req.params.id);
    if (!Number.isInteger(pilotId) || pilotId <= 0) return res.status(400).json({ error: 'invalid pilot id' });
    const { device_pub_key } = req.body || {};
    if (typeof device_pub_key !== 'string' || !PUBKEY_HEX_RE.test(device_pub_key))
      return res.status(400).json({ error: 'device_pub_key must be 64-char hex string' });
    const pilot = findPilotById.get(pilotId);
    if (!pilot) return res.status(404).json({ error: 'pilot not found' });
    upsertPilotEnrollment.run(pilotId, device_pub_key, Date.now());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'internal' });
  }
});

// POST /api/pilot/:id/feedback
app.post('/api/pilot/:id/feedback', pilotFeedbackRateLimit, (req, res) => {
  try {
    const pilotId = Number(req.params.id);
    if (!Number.isInteger(pilotId) || pilotId <= 0) return res.status(400).json({ error: 'invalid pilot id' });
    const { rating, comment, device_hash } = req.body || {};
    if (!Number.isInteger(rating) || rating < 1 || rating > 5)
      return res.status(400).json({ error: 'rating must be integer 1–5' });
    if (typeof device_hash !== 'string' || !HEX64_RE.test(device_hash))
      return res.status(400).json({ error: 'device_hash must be 64-char hex string' });
    const pilot = findPilotById.get(pilotId);
    if (!pilot) return res.status(404).json({ error: 'pilot not found' });
    const sanitizedComment = comment != null ? sanitizeComment(comment) : null;
    const commentHash = (typeof comment === 'string' && comment.length > 0)
      ? crypto.createHash('sha256').update(comment.slice(0, 500), 'utf8').digest('hex')
      : null;
    const result = insertPilotFeedback.run(pilotId, rating, commentHash, sanitizedComment, device_hash, Date.now());
    res.json({ ok: true, feedback_id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: 'internal' });
  }
});

// GET /api/pilot/:id/feedback/aggregate
app.get('/api/pilot/:id/feedback/aggregate', rateLimit, (req, res) => {
  try {
    const pilotId = Number(req.params.id);
    if (!Number.isInteger(pilotId) || pilotId <= 0) return res.status(400).json({ error: 'invalid pilot id' });
    const pilot = findPilotById.get(pilotId);
    if (!pilot) return res.status(404).json({ error: 'pilot not found' });
    const { n: feedbackCount } = countPilotFeedback.get(pilotId);
    if (feedbackCount < K_ANON_MIN) {
      return res.json({ pilot_id: pilotId, status: 'gated', reason: `feedback below k-anonymity floor (N=${K_ANON_MIN})` });
    }
    const ratingByDay = feedbackAggByDay.all(pilotId);
    const commentRows = feedbackAllComments.all(pilotId);
    const wordCounts = new Map();
    for (const row of commentRows) {
      if (!row.comment_text) continue;
      const words = row.comment_text.toLowerCase().split(/\s+/);
      for (const word of words) {
        const clean = word.replace(/[^\p{L}\p{N}]/gu, '');
        if (!clean || clean.length < 2) continue;
        if (STOPWORDS.has(clean)) continue;
        wordCounts.set(clean, (wordCounts.get(clean) || 0) + 1);
      }
    }
    const word_frequency = [...wordCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([word, count]) => ({ word, count }));
    res.json({ pilot_id: pilotId, name: pilot.name, feedback_count: feedbackCount, rating_by_day: ratingByDay, word_frequency });
  } catch (e) {
    res.status(500).json({ error: 'internal' });
  }
});

// ---- HTTP test helpers ----
let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), rawBody: data, headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: data, rawBody: data, headers: res.headers }); }
      });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

const adminHeaders = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
const badAdminHeaders = { Authorization: 'Bearer wrong-token' };
const noAuthHeaders = {};

// ---- Valid pilot payload factory ----
let pilotCounter = 0;
function validPilotPayload(overrides = {}) {
  pilotCounter++;
  return {
    name: `Test Pilot ${pilotCounter}`,
    preset: 'standard-a11y',
    target_size: 100,
    start_date: '2025-01-01',
    end_date: '2025-03-31',
    contact_email: 'pilot@test.example.com',
    ...overrides,
  };
}

// ---- Tests ----

describe('POST /api/pilot/enrollments — create pilot (admin only)', () => {
  test('1. creates pilot with valid payload, returns pilot_id + created_at', async () => {
    const payload = validPilotPayload();
    const { status, body } = await req('POST', '/api/pilot/enrollments', payload, adminHeaders);
    assert.equal(status, 201);
    assert.ok(typeof body.pilot_id === 'number' && body.pilot_id > 0, 'pilot_id is positive integer');
    assert.ok(typeof body.created_at === 'number', 'created_at is timestamp');
  });

  test('2. returns 401 with no auth token', async () => {
    const { status, body } = await req('POST', '/api/pilot/enrollments', validPilotPayload(), noAuthHeaders);
    assert.equal(status, 401);
    assert.ok(body.error.includes('invalid admin token'));
  });

  test('3. returns 401 with wrong token', async () => {
    const { status, body } = await req('POST', '/api/pilot/enrollments', validPilotPayload(), badAdminHeaders);
    assert.equal(status, 401);
    assert.ok(body.error.includes('invalid admin token'));
  });

  test('4. rejects invalid name with special chars', async () => {
    const { status, body } = await req('POST', '/api/pilot/enrollments',
      validPilotPayload({ name: 'Bad<Name>' }), adminHeaders);
    assert.equal(status, 400);
    assert.ok(body.error.includes('name'));
  });

  test('5. rejects name longer than 80 chars', async () => {
    const { status } = await req('POST', '/api/pilot/enrollments',
      validPilotPayload({ name: 'a'.repeat(81) }), adminHeaders);
    assert.equal(status, 400);
  });

  test('6. rejects invalid preset (uppercase)', async () => {
    const { status, body } = await req('POST', '/api/pilot/enrollments',
      validPilotPayload({ preset: 'BadPreset' }), adminHeaders);
    assert.equal(status, 400);
    assert.ok(body.error.includes('preset'));
  });

  test('7. rejects target_size below 10', async () => {
    const { status } = await req('POST', '/api/pilot/enrollments',
      validPilotPayload({ target_size: 5 }), adminHeaders);
    assert.equal(status, 400);
  });

  test('8. rejects target_size above 10000', async () => {
    const { status } = await req('POST', '/api/pilot/enrollments',
      validPilotPayload({ target_size: 10001 }), adminHeaders);
    assert.equal(status, 400);
  });

  test('9. rejects start_date >= end_date', async () => {
    const { status, body } = await req('POST', '/api/pilot/enrollments',
      validPilotPayload({ start_date: '2025-03-31', end_date: '2025-01-01' }), adminHeaders);
    assert.equal(status, 400);
    assert.ok(body.error.includes('start_date'));
  });

  test('10. rejects invalid email', async () => {
    const { status } = await req('POST', '/api/pilot/enrollments',
      validPilotPayload({ contact_email: 'not-an-email' }), adminHeaders);
    assert.equal(status, 400);
  });

  test('11. duplicate pilot name returns 409', async () => {
    const payload = validPilotPayload({ name: 'Duplicate Name Test' });
    const first = await req('POST', '/api/pilot/enrollments', payload, adminHeaders);
    assert.equal(first.status, 201);
    const second = await req('POST', '/api/pilot/enrollments', payload, adminHeaders);
    assert.equal(second.status, 409);
    assert.ok(second.body.error.includes('pilot name exists'));
  });

  test('12. rejects SQL injection-like input in name field (parameterized SQL)', async () => {
    // name contains SQL injection attempt — should be caught by regex validation, NOT by SQL error
    const { status, body } = await req('POST', '/api/pilot/enrollments',
      validPilotPayload({ name: "'; DROP TABLE pilots; --" }), adminHeaders);
    // Should be 400 (name regex rejects it) rather than 500 (SQL error)
    assert.equal(status, 400, 'injection input rejected by validation, not SQL');
    // DB should still be intact
    const pilotCount = db.prepare('SELECT COUNT(*) AS n FROM pilots').get();
    assert.ok(pilotCount.n >= 0, 'pilots table still exists after injection attempt');
  });
});

describe('GET /api/pilot/:id/status — small-cohort k-anon gate', () => {
  let smallPilotId;

  before(async () => {
    // Create a pilot with zero enrollments (below PILOT_K_ANON=20)
    const { body } = await req('POST', '/api/pilot/enrollments',
      validPilotPayload({ name: 'Small Cohort Pilot', target_size: 50 }), adminHeaders);
    smallPilotId = body.pilot_id;
  });

  test('13. status endpoint returns gated response when enrolled_count < 20', async () => {
    const { status, body } = await req('GET', `/api/pilot/${smallPilotId}/status`);
    assert.equal(status, 200);
    assert.equal(body.status, 'gated');
    assert.ok(body.reason.includes(`N=${PILOT_K_ANON}`));
    // Must NOT reveal metrics
    assert.ok(!('struggle_rate' in body), 'no struggle_rate in gated response');
    assert.ok(!('effectiveness_rate' in body), 'no effectiveness_rate in gated response');
    assert.ok(!('feature_adoption' in body), 'no feature_adoption in gated response');
  });

  test('14. status endpoint returns 404 for unknown pilot id', async () => {
    const { status } = await req('GET', '/api/pilot/999999/status');
    assert.equal(status, 404);
  });
});

describe('POST /api/pilot/:id/enroll-device — idempotency', () => {
  let enrollPilotId;
  const testPubKey = 'ab'.repeat(32); // 64-char hex

  before(async () => {
    const { body } = await req('POST', '/api/pilot/enrollments',
      validPilotPayload({ name: 'Enroll Test Pilot' }), adminHeaders);
    enrollPilotId = body.pilot_id;
  });

  test('15. first enrollment succeeds with ok: true', async () => {
    const { status, body } = await req('POST', `/api/pilot/${enrollPilotId}/enroll-device`,
      { device_pub_key: testPubKey });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  test('16. second enrollment of same device is idempotent (no error, ok: true)', async () => {
    const { status, body } = await req('POST', `/api/pilot/${enrollPilotId}/enroll-device`,
      { device_pub_key: testPubKey });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    // Count should still be 1 (not 2)
    const { n } = countPilotEnrollments.get(enrollPilotId);
    assert.equal(n, 1, 'exactly one enrollment row after two identical POSTs');
  });

  test('17. rejects malformed device_pub_key (too short)', async () => {
    const { status } = await req('POST', `/api/pilot/${enrollPilotId}/enroll-device`,
      { device_pub_key: 'abc123' });
    assert.equal(status, 400);
  });

  test('18. rejects non-hex device_pub_key', async () => {
    const { status } = await req('POST', `/api/pilot/${enrollPilotId}/enroll-device`,
      { device_pub_key: 'z'.repeat(64) });
    assert.equal(status, 400);
  });
});

describe('POST /api/pilot/:id/feedback — comment sanitization', () => {
  let feedbackPilotId;
  const deviceHash = 'cc'.repeat(32);

  before(async () => {
    const { body } = await req('POST', '/api/pilot/enrollments',
      validPilotPayload({ name: 'Feedback Test Pilot' }), adminHeaders);
    feedbackPilotId = body.pilot_id;
  });

  test('19. submits valid feedback and returns feedback_id', async () => {
    const { status, body } = await req('POST', `/api/pilot/${feedbackPilotId}/feedback`, {
      rating: 4,
      comment: 'Great accessibility features!',
      device_hash: deviceHash,
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(typeof body.feedback_id === 'number', 'feedback_id is number');
  });

  test('20. strips XSS from comment and stores sanitized version', async () => {
    const maliciousComment = '<script>alert("xss")</script> Good tool';
    const { status, body } = await req('POST', `/api/pilot/${feedbackPilotId}/feedback`, {
      rating: 3,
      comment: maliciousComment,
      device_hash: 'dd'.repeat(32),
    });
    assert.equal(status, 200);
    // Read back from DB to verify sanitization
    const row = db.prepare('SELECT comment_text FROM pilot_feedback WHERE id = ?').get(body.feedback_id);
    assert.ok(!row.comment_text.includes('<script>'), 'script tag stripped');
    assert.ok(row.comment_text.includes('&lt;script&gt;'), 'angle brackets entity-encoded');
  });

  test('21. truncates comment at 500 chars', async () => {
    const longComment = 'a'.repeat(600);
    const { status, body } = await req('POST', `/api/pilot/${feedbackPilotId}/feedback`, {
      rating: 5,
      comment: longComment,
      device_hash: 'ee'.repeat(32),
    });
    assert.equal(status, 200);
    const row = db.prepare('SELECT comment_text FROM pilot_feedback WHERE id = ?').get(body.feedback_id);
    assert.ok(row.comment_text.length <= 500, `comment_text length ${row.comment_text.length} <= 500`);
  });

  test('22. rejects rating outside 1–5', async () => {
    const { status } = await req('POST', `/api/pilot/${feedbackPilotId}/feedback`, {
      rating: 6,
      device_hash: deviceHash,
    });
    assert.equal(status, 400);
  });

  test('23. rejects malformed device_hash', async () => {
    const { status } = await req('POST', `/api/pilot/${feedbackPilotId}/feedback`, {
      rating: 3,
      device_hash: 'not-hex',
    });
    assert.equal(status, 400);
  });
});

describe('GET /api/pilot/:id/export.csv — CSV injection guard', () => {
  let csvPilotId;

  before(async () => {
    const { body } = await req('POST', '/api/pilot/enrollments',
      validPilotPayload({ name: 'CSV Export Pilot', target_size: 25 }), adminHeaders);
    csvPilotId = body.pilot_id;
    // Enroll 20 devices directly in DB to avoid triggering rate limiter
    const insertEnroll = db.prepare(
      'INSERT OR IGNORE INTO pilot_enrollments (pilot_id, device_pub_key, enrolled_at) VALUES (?, ?, ?)',
    );
    for (let i = 0; i < 20; i++) {
      const key = crypto.randomBytes(32).toString('hex');
      insertEnroll.run(csvPilotId, key, Date.now());
    }
    // Seed some aggregated_daily rows with a formula-injection metric name
    db.prepare(
      "INSERT OR IGNORE INTO aggregated_daily (date, metric, total, device_count) VALUES ('2025-01-15', '=CMD|'' /C calc''!A0', 1, 5)"
    ).run();
  });

  test('24. CSV fields starting with = are prefixed with single quote (injection guard)', async () => {
    const { status, rawBody, headers } = await req('GET', `/api/pilot/${csvPilotId}/export.csv`);
    assert.equal(status, 200);
    assert.ok(headers['content-type'].includes('text/csv'), 'content-type is text/csv');
    // The injected metric name starts with = so it must be prefixed with '
    if (rawBody.includes('=CMD')) {
      assert.ok(rawBody.includes("'=CMD"), "formula starting with = is prefixed with '");
    }
    // Verify header row is correct
    assert.ok(rawBody.startsWith('date,metric,total_noised,device_count'), 'CSV header present');
  });

  test('25. gated response (403) when enrolled_count < 20', async () => {
    // Create a new pilot with no enrollments
    const { body: pb } = await req('POST', '/api/pilot/enrollments',
      validPilotPayload({ name: 'CSV Gated Pilot' }), adminHeaders);
    const { status, body } = await req('GET', `/api/pilot/${pb.pilot_id}/export.csv`);
    assert.equal(status, 403);
    assert.equal(body.error, 'gated');
  });
});

describe('Admin token constant-time compare', () => {
  test('26. empty token is rejected', async () => {
    const { status } = await req('POST', '/api/pilot/enrollments', validPilotPayload(),
      { Authorization: 'Bearer ' });
    assert.equal(status, 401);
  });

  test('27. token with correct prefix but extra chars is rejected', async () => {
    const { status } = await req('POST', '/api/pilot/enrollments', validPilotPayload(),
      { Authorization: `Bearer ${TEST_ADMIN_TOKEN}X` });
    assert.equal(status, 401);
  });

  test('28. correct token is accepted (timing-safe path confirms no crash)', async () => {
    const { status } = await req('POST', '/api/pilot/enrollments', validPilotPayload(), adminHeaders);
    assert.equal(status, 201, 'correct admin token accepted');
  });
});

describe('GET /api/pilot/:id/feedback/aggregate — k-anon gate', () => {
  let aggPilotId;

  before(async () => {
    const { body } = await req('POST', '/api/pilot/enrollments',
      validPilotPayload({ name: 'Aggregate Feedback Pilot' }), adminHeaders);
    aggPilotId = body.pilot_id;
  });

  test('29. returns gated when fewer than 5 feedback rows', async () => {
    // Submit 4 feedback entries (below K_ANON_MIN=5)
    for (let i = 0; i < 4; i++) {
      await req('POST', `/api/pilot/${aggPilotId}/feedback`, {
        rating: 3,
        comment: `test feedback word1 word2 feature accessibility`,
        device_hash: crypto.randomBytes(32).toString('hex'),
      });
    }
    const { status, body } = await req('GET', `/api/pilot/${aggPilotId}/feedback/aggregate`);
    assert.equal(status, 200);
    assert.equal(body.status, 'gated');
    assert.ok(body.reason.includes(`N=${K_ANON_MIN}`));
  });

  test('30. returns aggregate with word_frequency when >= 5 feedback rows', async () => {
    // Add a 5th feedback entry to cross the threshold
    await req('POST', `/api/pilot/${aggPilotId}/feedback`, {
      rating: 5,
      comment: 'excellent accessibility feature keyboard navigation',
      device_hash: crypto.randomBytes(32).toString('hex'),
    });
    const { status, body } = await req('GET', `/api/pilot/${aggPilotId}/feedback/aggregate`);
    assert.equal(status, 200);
    assert.ok(typeof body.feedback_count === 'number' && body.feedback_count >= 5, 'feedback_count >= 5');
    assert.ok(Array.isArray(body.rating_by_day), 'rating_by_day is array');
    assert.ok(Array.isArray(body.word_frequency), 'word_frequency is array');
    // Stopwords must not appear in word_frequency
    for (const { word } of body.word_frequency) {
      assert.ok(!STOPWORDS.has(word), `stopword "${word}" must not appear in word_frequency`);
    }
    // word_frequency should be capped at 50
    assert.ok(body.word_frequency.length <= 50, 'word_frequency capped at 50');
  });
});
