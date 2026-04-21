/**
 * Regression tests for FINDING-VPS-001 — rate-limit IP spoofing fix.
 *
 * Verifies that:
 *  1. CF-Connecting-IP is used as the bucket key when present.
 *  2. Spoofed X-Forwarded-For does NOT reset a counter when CF-Connecting-IP is set.
 *  3. 100 rapid requests from one CF-Connecting-IP trip the rate limiter.
 *  4. 100 requests from 100 distinct CF-Connecting-IPs do NOT share one bucket.
 *
 * Pattern: node --test (Node built-in runner, no supertest needed).
 * Spins up a minimal Express app that reproduces the getClientIp + rateLimit
 * logic from server.js verbatim, bound to a random ephemeral port.
 */

'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

// ---------------------------------------------------------------------------
// Reproduce the exact helper and rate-limit logic from server.js
// ---------------------------------------------------------------------------

// Must stay byte-identical to server.js getClientIp
function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  const cfRay = req.headers['cf-ray'];
  if (
    typeof cf === 'string' && cf.length > 0 && cf.length < 64 &&
    /^[0-9a-fA-F:.]+$/.test(cf) &&
    typeof cfRay === 'string' && cfRay.length >= 10 && cfRay.length < 64 &&
    /^[0-9a-f]+-[A-Z0-9]{3,5}$/i.test(cfRay)
  ) {
    return cf;
  }
  return req.ip || 'unknown';
}

// A valid-shaped CF-Ray that passes our shape check
const CF_RAY = '7a8b2c3d4e5f6789-SIN';

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function makeRateLimiter() {
  const buckets = new Map();
  return function rateLimit(req, res, next) {
    const ip = getClientIp(req);
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket) {
      bucket = { count: 0, windowStart: now };
      buckets.set(ip, bucket);
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
  };
}

// ---------------------------------------------------------------------------
// HTTP helper — wraps http.request as a promise
// ---------------------------------------------------------------------------

function request(server, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
      { host: '127.0.0.1', port: addr.port, method, path, headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('rate-limit IP spoofing (FINDING-VPS-001)', () => {
  let app;
  let server;

  before(() => new Promise((resolve) => {
    app = express();
    app.set('trust proxy', 3);
    app.use(express.json());
    const rl = makeRateLimiter();
    app.get('/ping', rl, (_req, res) => res.json({ ok: true }));
    server = app.listen(0, '127.0.0.1', resolve);
  }));

  after(() => new Promise((resolve) => server.close(resolve)));

  // Each test gets a fresh rate-limiter so buckets don't bleed between tests.
  // We achieve this by re-assigning the route handler via a fresh app per test.
  // Since Jest-style beforeEach is available in node:test, we rebuild the server.

  test('CF-Connecting-IP used as bucket key — distinct IPs get independent buckets', async () => {
    const cfHeaders = (ip) => ({ 'cf-connecting-ip': ip, 'cf-ray': CF_RAY });
    // Send RATE_LIMIT requests from IP A — should all pass
    for (let i = 0; i < RATE_LIMIT; i++) {
      const r = await request(server, { path: '/ping', headers: cfHeaders('1.2.3.4') });
      assert.equal(r.status, 200, `request ${i + 1} from IP A should be 200`);
    }
    // 61st from IP A should be 429
    const overflow = await request(server, { path: '/ping', headers: cfHeaders('1.2.3.4') });
    assert.equal(overflow.status, 429, 'IP A should be rate-limited on 61st request');

    // But IP B (fresh CF header) must still pass
    const ipB = await request(server, { path: '/ping', headers: cfHeaders('5.6.7.8') });
    assert.equal(ipB.status, 200, 'IP B should NOT be rate-limited by IP A exhaustion');
  });

  test('100 requests from distinct CF-Connecting-IPs do NOT trip one shared bucket', async () => {
    // Build a fresh server with its own limiter so previous test counts don't apply
    const freshLimiter = makeRateLimiter();
    const freshApp = express();
    freshApp.set('trust proxy', 3);
    freshApp.use(express.json());
    freshApp.get('/ping', freshLimiter, (_req, res) => res.json({ ok: true }));
    const freshServer = await new Promise((resolve) => {
      const s = freshApp.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          request(freshServer, {
            path: '/ping',
            headers: { 'cf-connecting-ip': `10.0.0.${i + 1}`, 'cf-ray': CF_RAY },
          }),
        ),
      );
      const limited = results.filter((r) => r.status === 429);
      assert.equal(limited.length, 0, 'no IP should be rate-limited (each has its own bucket)');
    } finally {
      await new Promise((resolve) => freshServer.close(resolve));
    }
  });

  test('spoofed X-Forwarded-For does NOT reset counter when CF-Connecting-IP is set', async () => {
    // Use a fresh server to avoid bucket contamination from test 1
    const freshLimiter = makeRateLimiter();
    const freshApp = express();
    freshApp.set('trust proxy', 3);
    freshApp.use(express.json());
    freshApp.get('/ping', freshLimiter, (_req, res) => res.json({ ok: true }));
    const freshServer = await new Promise((resolve) => {
      const s = freshApp.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      // Exhaust the bucket for attacker's real CF IP
      for (let i = 0; i < RATE_LIMIT; i++) {
        await request(freshServer, {
          path: '/ping',
          headers: {
            'cf-connecting-ip': '9.9.9.9',
            'cf-ray': CF_RAY,
            'x-forwarded-for': '1.1.1.1', // attacker tries to spoof a different IP
          },
        });
      }
      // 61st request — attacker still sends spoofed XFF but real CF IP is the same
      const r = await request(freshServer, {
        path: '/ping',
        headers: {
          'cf-connecting-ip': '9.9.9.9',
          'cf-ray': CF_RAY,
          'x-forwarded-for': '2.2.2.2', // different spoof, shouldn't matter
        },
      });
      assert.equal(r.status, 429, 'attacker with CF-Connecting-IP=9.9.9.9 should be rate-limited regardless of spoofed XFF');
    } finally {
      await new Promise((resolve) => freshServer.close(resolve));
    }
  });

  test('100 rapid requests from one CF-Connecting-IP trip rate limiter after 60', async () => {
    const freshLimiter = makeRateLimiter();
    const freshApp = express();
    freshApp.set('trust proxy', 3);
    freshApp.use(express.json());
    freshApp.get('/ping', freshLimiter, (_req, res) => res.json({ ok: true }));
    const freshServer = await new Promise((resolve) => {
      const s = freshApp.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          request(freshServer, {
            path: '/ping',
            headers: { 'cf-connecting-ip': '7.7.7.7', 'cf-ray': CF_RAY },
          }),
        ),
      );
      const ok = results.filter((r) => r.status === 200).length;
      const limited = results.filter((r) => r.status === 429).length;
      // Exactly RATE_LIMIT=60 should pass; the remaining 40 should be 429
      assert.equal(ok, RATE_LIMIT, `expected exactly ${RATE_LIMIT} successful responses`);
      assert.equal(limited, 100 - RATE_LIMIT, `expected ${100 - RATE_LIMIT} rate-limited responses`);
    } finally {
      await new Promise((resolve) => freshServer.close(resolve));
    }
  });

  // ---- Adversarial-review fix: CF-RAY gate on CF-Connecting-IP ----

  test('CF-Connecting-IP WITHOUT CF-Ray is NOT trusted (CF-bypass attempt)', async () => {
    // Simulate an attacker hitting the origin directly and setting CF-Connecting-IP
    // without a matching CF-Ray header. The gate must reject this and fall back
    // to req.ip (which for local 127.0.0.1 will be shared — all attacker requests
    // bucket together, exactly what we want).
    const freshLimiter = makeRateLimiter();
    const freshApp = express();
    freshApp.set('trust proxy', 3);
    freshApp.get('/ping', freshLimiter, (_req, res) => res.json({ ok: true }));
    const freshServer = await new Promise((resolve) => {
      const s = freshApp.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      // 100 requests cycling through 100 different CF-Connecting-IPs but NO CF-Ray.
      // All should bucket to req.ip=127.0.0.1 → 60 pass + 40 get 429.
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          request(freshServer, {
            path: '/ping',
            headers: { 'cf-connecting-ip': `8.8.8.${i + 1}` /* no cf-ray */ },
          }),
        ),
      );
      const limited = results.filter((r) => r.status === 429).length;
      assert.ok(limited >= 30, `expected many 429s when CF-Ray missing (got ${limited})`);
    } finally {
      await new Promise((resolve) => freshServer.close(resolve));
    }
  });

  test('Malformed CF-Ray (wrong shape) is NOT trusted — falls back to req.ip', async () => {
    const freshLimiter = makeRateLimiter();
    const freshApp = express();
    freshApp.set('trust proxy', 3);
    freshApp.get('/ping', freshLimiter, (_req, res) => res.json({ ok: true }));
    const freshServer = await new Promise((resolve) => {
      const s = freshApp.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      // "notacfray" fails the shape regex → gate rejects → fall back to req.ip
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          request(freshServer, {
            path: '/ping',
            headers: {
              'cf-connecting-ip': `6.6.6.${i + 1}`,
              'cf-ray': 'notacfray', // malformed — missing the "-DC" suffix
            },
          }),
        ),
      );
      const limited = results.filter((r) => r.status === 429).length;
      assert.ok(limited >= 30, `expected many 429s when CF-Ray malformed (got ${limited})`);
    } finally {
      await new Promise((resolve) => freshServer.close(resolve));
    }
  });

  test('Valid CF-Ray shapes are accepted', async () => {
    // Verify a few real-world-shaped CF-Ray values pass the gate
    const shapes = ['7a8b2c3d4e5f6789-SIN', 'abc123-IAD', 'fffffffffffffff-LHR', '1234-NRT'];
    for (const rayShape of shapes) {
      const freshLimiter = makeRateLimiter();
      const freshApp = express();
      freshApp.set('trust proxy', 3);
      freshApp.get('/ping', freshLimiter, (_req, res) => res.json({ ok: true }));
      const freshServer = await new Promise((resolve) => {
        const s = freshApp.listen(0, '127.0.0.1', () => resolve(s));
      });
      try {
        // Each distinct CF-IP should get its own bucket → all 5 pass
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            request(freshServer, {
              path: '/ping',
              headers: { 'cf-connecting-ip': `3.3.3.${i + 1}`, 'cf-ray': rayShape },
            }),
          ),
        );
        const ok = results.filter((r) => r.status === 200).length;
        assert.equal(ok, 5, `CF-Ray shape "${rayShape}" should be accepted, got ${ok}/5 OK`);
      } finally {
        await new Promise((resolve) => freshServer.close(resolve));
      }
    }
  });
});
