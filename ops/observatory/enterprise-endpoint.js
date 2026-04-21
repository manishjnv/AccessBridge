/**
 * AccessBridge Compliance Observatory — Enterprise API (Session 20 stub).
 *
 * Status: SKELETON. Routes return 501 until the SQLite migration adding
 * `org_hash TEXT` columns to `attestations` and `aggregated_daily` lands
 * in Session 21. The extension-side pipeline already publishes org_hash
 * values; the server currently discards them on receipt (the POST /publish
 * handler doesn't have an allowlisted `org_hash` key yet — that's intentional
 * until the migration enables the column).
 *
 * Endpoints (planned):
 *   GET  /api/observatory/enterprise/summary?orgHash=<merkle-hash>
 *        → per-org aggregate stats filtered to that device ring
 *   GET  /api/observatory/enterprise/trends?orgHash=<merkle-hash>&from=<date>&to=<date>
 *        → time-series of aggregated metrics for one org
 *   GET  /api/observatory/enterprise/compliance?orgHash=<merkle-hash>
 *        → WCAG coverage report for one org
 *
 * Security notes (enforced when migration lands, NOT yet):
 *   - orgHash is treated as opaque; server never stores a reverse mapping
 *   - k-anonymity floor of 10 devices per orgHash before any per-org stat is returned
 *   - rate limit 10 req/min per orgHash per IP
 *   - UNIQUE-per-org indexes prevent merkle_root collisions across orgs
 */

const express = require('express');

function createEnterpriseRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    // Validation for all enterprise endpoints: orgHash must be 64 hex chars
    const { orgHash } = req.query;
    if (!orgHash || typeof orgHash !== 'string' || !/^[0-9a-f]{64}$/i.test(orgHash)) {
      return res.status(400).json({ ok: false, error: 'orgHash query param required (64 hex chars)' });
    }
    next();
  });

  router.get('/summary', (req, res) => {
    res.status(501).json({
      ok: false,
      error: 'enterprise telemetry not yet enabled',
      message: 'SQLite schema migration for org_hash columns ships in Session 21. Extension-side publication is already wired.',
      session: 20,
      orgHash: req.query.orgHash,
    });
  });

  router.get('/trends', (req, res) => {
    res.status(501).json({
      ok: false,
      error: 'enterprise telemetry not yet enabled',
      session: 20,
    });
  });

  router.get('/compliance', (req, res) => {
    res.status(501).json({
      ok: false,
      error: 'enterprise telemetry not yet enabled',
      session: 20,
    });
  });

  return router;
}

module.exports = { createEnterpriseRouter };
