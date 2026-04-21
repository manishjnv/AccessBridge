/**
 * AccessBridge Auditor Verifier — client-side ring signature re-verification.
 *
 * All cryptography is performed in this browser tab. The server provides raw
 * attestation data + ring public keys; it cannot influence the outcome of the
 * verification math. A compromised server can withhold data but cannot forge a
 * valid signature that this code accepts.
 *
 * Algorithm: SAG linkable ring signature over Ristretto255 (Abe-Ohkubo-Suzuki),
 * identical to the signing path in packages/core/src/crypto/ring-signature/ed25519-ring.ts.
 *
 * CDN imports (3 max):
 *   @noble/curves  — Ristretto255 / ed25519
 *   @noble/hashes  — sha256, sha512, encoding helpers
 *   jsPDF          — PDF export (loaded via <script> in the HTML, window.jspdf)
 */

import { ed25519, RistrettoPoint } from 'https://esm.sh/@noble/curves@1.9.7/ed25519';
import { sha256 } from 'https://esm.sh/@noble/hashes@1.5.0/sha256';
import { sha512 } from 'https://esm.sh/@noble/hashes@1.5.0/sha512';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from 'https://esm.sh/@noble/hashes@1.5.0/utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURVE_L = ed25519.CURVE.n;  // bigint subgroup order
const SCALAR_BYTES = 32;
const DOMAIN_SCALAR_PREFIX = utf8ToBytes('accessbridge-scalar-v1:');
const DOMAIN_HTP_PREFIX = 'accessbridge-htp-v1:';

// ---------------------------------------------------------------------------
// Scalar encoding — 32-byte little-endian, reduced mod L
// (mirrors ed25519-ring.ts scalarToBytes / bytesToScalar)
// ---------------------------------------------------------------------------

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
  let x = 0n;
  for (let i = SCALAR_BYTES - 1; i >= 0; i--) {
    x = (x << 8n) | BigInt(b[i]);
  }
  return ((x % CURVE_L) + CURVE_L) % CURVE_L;
}

// ---------------------------------------------------------------------------
// hashToScalar — sha256(domain_prefix || input) → LE bigint mod L
// ---------------------------------------------------------------------------

function hashToScalar(input) {
  const digest = sha256(concatBytes(DOMAIN_SCALAR_PREFIX, input));
  return bytesToScalar(digest);
}

// ---------------------------------------------------------------------------
// hashToPoint — try-and-increment over sha512, domain-tagged
// ---------------------------------------------------------------------------

function hashToPoint(domain) {
  const domainBytes = utf8ToBytes(DOMAIN_HTP_PREFIX + domain + ':');
  for (let ctr = 0; ctr < 256; ctr++) {
    const ctrBytes = utf8ToBytes(String(ctr));
    const digest = sha512(concatBytes(domainBytes, ctrBytes));
    const candidate = digest.slice(0, SCALAR_BYTES);
    try {
      const point = RistrettoPoint.fromHex(candidate);
      if (point.equals(RistrettoPoint.ZERO)) continue;
      return point;
    } catch {
      // Invalid Ristretto encoding — try next counter.
    }
  }
  throw new Error('hashToPoint: exhausted counter without a valid Ristretto point');
}

// ---------------------------------------------------------------------------
// safeMultiply — guard against scalar=0
// ---------------------------------------------------------------------------

function safeMultiply(point, scalar) {
  const s = ((scalar % CURVE_L) + CURVE_L) % CURVE_L;
  if (s === 0n) return RistrettoPoint.ZERO;
  return point.multiply(s);
}

// ---------------------------------------------------------------------------
// hashRing — sha256 over concatenation of all 32-byte pubkeys → hex
// ---------------------------------------------------------------------------

function hashRing(ring) {
  if (ring.length === 0) return bytesToHex(sha256(new Uint8Array(0)));
  const buf = new Uint8Array(ring.length * SCALAR_BYTES);
  for (let i = 0; i < ring.length; i++) {
    buf.set(ring[i], i * SCALAR_BYTES);
  }
  return bytesToHex(sha256(buf));
}

// ---------------------------------------------------------------------------
// SAG ring-signature verify (mirrors ed25519-ring.ts verify())
// ---------------------------------------------------------------------------

function verifySAG(message, ring, sig, domain) {
  try {
    const n = ring.length;
    if (n < 2) return false;
    if (sig.s.length !== n) return false;
    if (sig.c0.length !== SCALAR_BYTES) return false;
    if (sig.keyImage.length !== SCALAR_BYTES) return false;

    // Decode ring public keys
    const P = ring.map((pk, idx) => {
      if (pk.length !== SCALAR_BYTES) throw new Error(`ring[${idx}] bad length`);
      return RistrettoPoint.fromHex(pk);
    });

    const G = RistrettoPoint.BASE;
    const Hp = hashToPoint(domain);

    let I;
    try {
      I = RistrettoPoint.fromHex(sig.keyImage);
    } catch {
      return false;
    }
    const Ibytes = I.toRawBytes();

    const c = new Array(n + 1).fill(0n);
    c[0] = bytesToScalar(sig.c0);

    for (let i = 0; i < n; i++) {
      const s_i = bytesToScalar(sig.s[i]);
      const Li = safeMultiply(G, s_i).add(safeMultiply(P[i], c[i]));
      const Ri = safeMultiply(Hp, s_i).add(safeMultiply(I, c[i]));
      c[i + 1] = hashToScalar(concatBytes(message, Li.toRawBytes(), Ri.toRawBytes(), Ibytes));
    }

    return c[n] === c[0];
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// attestationMessageBytes — mirrors commitment.ts
// ---------------------------------------------------------------------------

function attestationMessageBytes({ date, ringHash, merkleRoot, ringVersion }) {
  const s = `accessbridge-attest-v1:${date}:${ringVersion}:${ringHash}:${merkleRoot}`;
  return utf8ToBytes(s);
}

// ---------------------------------------------------------------------------
// attestationKeyImageDomain — mirrors commitment.ts
// ---------------------------------------------------------------------------

function attestationKeyImageDomain(date, _ringHash) {
  // Scoped by date only — mirrors commitment.ts. See that file for why.
  return `accessbridge-obs-v1:${date}`;
}

// ---------------------------------------------------------------------------
// canonicalLines + merkleRoot (mirrors observatory-publisher.ts)
// ---------------------------------------------------------------------------

function canonicalLines(counters) {
  const lines = [];
  for (const [k, v] of Object.entries(counters.adaptations_applied ?? {})) {
    lines.push(`adaptations_applied:${k}=${v}`);
  }
  lines.push(`struggle_events_triggered:=${counters.struggle_events_triggered ?? 0}`);
  for (const [k, v] of Object.entries(counters.features_enabled ?? {})) {
    lines.push(`features_enabled:${k}=${v}`);
  }
  for (const [k, v] of Object.entries(counters.domain_connectors_activated ?? {})) {
    lines.push(`domain_connectors_activated:${k}=${v}`);
  }
  for (const [k, v] of Object.entries(counters.onnx_inferences ?? {})) {
    lines.push(`onnx_inferences:${k}=${v}`);
  }
  const langs = [...new Set(counters.languages_used ?? [])].sort();
  lines.push(`languages_used:=[${langs.join(',')}]`);
  lines.push(`estimated_accessibility_score_improvement:=${counters.estimated_accessibility_score_improvement ?? 0}`);
  lines.sort();
  return lines;
}

async function recomputeMerkleRoot(counters) {
  const enc = new TextEncoder();
  const items = canonicalLines(counters);
  if (items.length === 0) {
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(''));
    return bytesToHex(new Uint8Array(buf));
  }
  let layer = await Promise.all(items.map(async (item) => {
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(item));
    return new Uint8Array(buf);
  }));
  while (layer.length > 1) {
    if (layer.length % 2 !== 0) layer = [...layer, layer[layer.length - 1]];
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const combined = new Uint8Array(layer[i].length + layer[i + 1].length);
      combined.set(layer[i], 0);
      combined.set(layer[i + 1], layer[i].length);
      const buf = await crypto.subtle.digest('SHA-256', combined);
      next.push(new Uint8Array(buf));
    }
    layer = next;
  }
  return bytesToHex(layer[0]);
}

// ---------------------------------------------------------------------------
// verifyAttestation — full pipeline check
// ---------------------------------------------------------------------------

async function verifyAttestation(attestation, ringPubKeys) {
  // ringPubKeys: string[] (hex)
  if (attestation.format !== 1) {
    return { valid: false, reason: 'malformed: format !== 1' };
  }

  // Decode ring
  let ring;
  try {
    ring = ringPubKeys.map(hex => hexToBytes(hex));
  } catch {
    return { valid: false, reason: 'malformed: bad ring pubkey hex' };
  }

  // 1. Ring hash check
  let computedRingHash;
  try {
    computedRingHash = hashRing(ring);
  } catch {
    return { valid: false, reason: 'ring-hash-computation-failed' };
  }
  if (computedRingHash !== attestation.ringHash) {
    return { valid: false, reason: `ring-mismatch: expected ${computedRingHash.slice(0, 8)}… got ${(attestation.ringHash ?? '').slice(0, 8)}…` };
  }

  // 2. Ring size check
  if (!Array.isArray(attestation.signature?.s) || attestation.signature.s.length !== ring.length) {
    return { valid: false, reason: 'ring-size-mismatch' };
  }

  // 3. Merkle recomputation
  let recomputed;
  try {
    recomputed = await recomputeMerkleRoot(attestation.counters ?? {});
  } catch (e) {
    return { valid: false, reason: `merkle-computation-failed: ${e.message}` };
  }
  if (recomputed !== attestation.merkleRoot) {
    return { valid: false, reason: `merkle-mismatch: recomputed ${recomputed.slice(0, 8)}… attestation has ${(attestation.merkleRoot ?? '').slice(0, 8)}…` };
  }

  // 4. Signature decode
  let sig;
  try {
    if (typeof attestation.signature.c0 !== 'string' || attestation.signature.c0.length !== 64) {
      throw new Error('c0 must be 64-char hex');
    }
    if (typeof attestation.signature.keyImage !== 'string' || attestation.signature.keyImage.length !== 64) {
      throw new Error('keyImage must be 64-char hex');
    }
    sig = {
      c0: hexToBytes(attestation.signature.c0),
      s: attestation.signature.s.map((entry, idx) => {
        if (typeof entry !== 'string' || entry.length !== 64) throw new Error(`s[${idx}] bad`);
        return hexToBytes(entry);
      }),
      keyImage: hexToBytes(attestation.signature.keyImage),
    };
  } catch (e) {
    return { valid: false, reason: `malformed signature: ${e.message}` };
  }

  // 5. SAG verify loop
  const message = attestationMessageBytes({
    date: attestation.date,
    ringHash: attestation.ringHash,
    merkleRoot: attestation.merkleRoot,
    ringVersion: attestation.ringVersion,
  });
  const domain = attestationKeyImageDomain(attestation.date, attestation.ringHash);
  const ok = verifySAG(message, ring, sig, domain);

  if (!ok) {
    return { valid: false, reason: 'signature-invalid' };
  }
  return { valid: true, reason: '' };
}

// ---------------------------------------------------------------------------
// Audit Certificate Hash — sha256(date + ringHash + keyImages joined)
// Allows two independent auditors to cross-check their run produced identical results.
// ---------------------------------------------------------------------------

async function computeCertHash(date, ringHash, results) {
  const keyImages = results.map(r => r.keyImage ?? '').join('|');
  const payload = `${date}:${ringHash}:${keyImages}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return bytesToHex(new Uint8Array(buf));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastResults = null;   // { date, ringHash, ringVersion, ringSize, rows, certHash }

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function showSpinner(label) {
  document.getElementById('spinner').hidden = false;
  document.getElementById('spinner-label').textContent = label || 'Verifying…';
}

function hideSpinner() {
  document.getElementById('spinner').hidden = true;
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  banner.textContent = msg;
  banner.hidden = false;
  banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearError() {
  const banner = document.getElementById('error-banner');
  banner.hidden = true;
  banner.textContent = '';
}

function svgValid() {
  return `<svg class="icon-valid" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-label="Valid" role="img">
    <polyline points="20 6 9 17 4 12"/>
  </svg>`;
}

function svgInvalid() {
  return `<svg class="icon-invalid" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-label="Invalid" role="img">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Render results into the DOM
// ---------------------------------------------------------------------------

async function renderResults({ date, ringHash, ringVersion, ringSize, rows }) {
  const validCount = rows.filter(r => r.valid).length;
  const invalidCount = rows.length - validCount;

  const certHash = await computeCertHash(
    date,
    ringHash,
    rows.map(r => ({ keyImage: r.keyImage }))
  );

  // Stash for PDF
  lastResults = { date, ringHash, ringVersion, ringSize, rows, certHash, validCount, invalidCount };

  // Summary card
  document.getElementById('report-empty').hidden = true;
  document.getElementById('report-summary').hidden = false;
  document.getElementById('stat-total').textContent = String(rows.length);
  document.getElementById('stat-valid').textContent = String(validCount);
  document.getElementById('stat-invalid').textContent = String(invalidCount);
  document.getElementById('stat-ring-size').textContent = String(ringSize);
  document.getElementById('stat-ring-hash').textContent = ringHash;
  document.getElementById('stat-ring-version').textContent = String(ringVersion ?? '—');
  document.getElementById('stat-cert-hash').textContent = certHash;
  document.getElementById('btn-download-pdf').disabled = false;

  // Results table
  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${(row.keyImage ?? '—').slice(0, 16)}…</td>
      <td class="mono">${(row.merkleRoot ?? '—').slice(0, 16)}…</td>
      <td class="cell-valid">${row.valid ? svgValid() : svgInvalid()}</td>
      <td class="cell-reason">${row.valid ? '' : escapeHtml(row.reason ?? '')}</td>
    `;
    tbody.appendChild(tr);
  }

  document.getElementById('results-section').hidden = false;
  document.getElementById('report-summary').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Fetch + verify by date
// ---------------------------------------------------------------------------

async function verifyByDate(dateStr) {
  clearError();
  showSpinner('Fetching attestations…');
  try {
    const resp = await fetch(`/observatory/api/verify/${encodeURIComponent(dateStr)}`);
    if (!resp.ok) throw new Error(`Server returned HTTP ${resp.status} for /api/verify/${dateStr}`);
    const data = await resp.json();

    const attestations = data.attestations ?? [];
    const ring = data.ring ?? {};
    const ringPubKeys = ring.pubKeys ?? [];
    const ringHash = ring.ringHash ?? '';
    const ringVersion = ring.version ?? null;
    const ringSize = ringPubKeys.length;

    if (attestations.length === 0) {
      hideSpinner();
      showError(`No attestations found for ${dateStr}.`);
      return;
    }

    showSpinner(`Verifying ${attestations.length} attestation(s)…`);

    const rows = [];
    for (const att of attestations) {
      const result = await verifyAttestation(att, ringPubKeys);
      rows.push({
        keyImage: att.signature?.keyImage ?? '—',
        merkleRoot: att.merkleRoot ?? '—',
        valid: result.valid,
        reason: result.reason,
      });
    }

    hideSpinner();
    await renderResults({ date: dateStr, ringHash, ringVersion, ringSize, rows });

  } catch (err) {
    hideSpinner();
    showError(`Verification failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Fetch ring + verify pasted attestation
// ---------------------------------------------------------------------------

async function verifyPasted(jsonText) {
  clearError();

  let attestation;
  try {
    attestation = JSON.parse(jsonText);
  } catch {
    showError('Invalid JSON — could not parse attestation.');
    return;
  }

  showSpinner('Fetching current ring from server…');
  let ringData;
  try {
    const resp = await fetch('/observatory/api/ring');
    if (!resp.ok) throw new Error(`Server returned HTTP ${resp.status} for /api/ring`);
    ringData = await resp.json();
  } catch (err) {
    hideSpinner();
    showError(`Could not fetch ring: ${err.message}. Cannot verify without the public ring.`);
    return;
  }

  const ringPubKeys = ringData.pubKeys ?? [];
  const ringHash = ringData.ringHash ?? '';
  const ringVersion = ringData.version ?? null;
  const ringSize = ringPubKeys.length;

  // Warn if version mismatch
  if (typeof attestation.ringVersion === 'number' && attestation.ringVersion !== ringVersion) {
    showError(
      `Warning: attestation ringVersion=${attestation.ringVersion} but server ring version=${ringVersion}. ` +
      `The server only vends the current ring. Verification will use the current ring and may fail if the ring has rotated.`
    );
  }

  showSpinner('Verifying signature…');
  let result;
  try {
    result = await verifyAttestation(attestation, ringPubKeys);
  } catch (err) {
    hideSpinner();
    showError(`Verification error: ${err.message}`);
    return;
  }

  hideSpinner();

  const rows = [{
    keyImage: attestation.signature?.keyImage ?? '—',
    merkleRoot: attestation.merkleRoot ?? '—',
    valid: result.valid,
    reason: result.reason,
  }];

  const dateStr = attestation.date ?? '(unknown)';
  await renderResults({ date: dateStr, ringHash, ringVersion, ringSize, rows });
}

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------

function downloadPDF() {
  if (!lastResults) return;
  const { jspdf } = window;
  if (!jspdf) {
    showError('jsPDF not loaded. Check your network connection and reload the page.');
    return;
  }
  const { jsPDF } = jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const pageW = doc.internal.pageSize.getWidth();
  const margin = 18;
  let y = margin;

  // Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(123, 104, 238);
  doc.text('AccessBridge — Audit Report', margin, y);
  y += 10;

  // Subtitle
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(148, 163, 184);
  doc.text('Client-side SAG Ristretto255 ring signature re-verification', margin, y);
  y += 8;

  // Divider
  doc.setDrawColor(123, 104, 238);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageW - margin, y);
  y += 7;

  // Meta rows
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(226, 232, 240);

  const meta = [
    ['Date', lastResults.date],
    ['Ring Version', String(lastResults.ringVersion ?? '—')],
    ['Ring Size', String(lastResults.ringSize)],
    ['Ring Hash', lastResults.ringHash],
    ['Total Attestations', String(lastResults.rows.length)],
    ['Valid', String(lastResults.validCount)],
    ['Invalid', String(lastResults.invalidCount)],
    ['Audit Certificate Hash', lastResults.certHash],
  ];

  for (const [label, value] of meta) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(148, 163, 184);
    doc.text(label + ':', margin, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(226, 232, 240);
    const wrapped = doc.splitTextToSize(value, pageW - margin - 70);
    doc.text(wrapped, margin + 65, y);
    y += 6 * wrapped.length;
  }

  y += 4;
  doc.setDrawColor(123, 104, 238);
  doc.line(margin, y, pageW - margin, y);
  y += 7;

  // Table header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(187, 134, 252);
  doc.text('Key Image (prefix)', margin, y);
  doc.text('Merkle Root (prefix)', margin + 55, y);
  doc.text('Valid', margin + 115, y);
  doc.text('Reason', margin + 130, y);
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);

  for (const [i, row] of lastResults.rows.entries()) {
    if (y > 270) {
      doc.addPage();
      y = margin;
    }
    if (i % 2 === 1) {
      doc.setFillColor(26, 26, 46);
      doc.rect(margin - 2, y - 4, pageW - margin * 2 + 4, 6, 'F');
    }
    doc.setTextColor(226, 232, 240);
    doc.text((row.keyImage ?? '—').slice(0, 16) + '…', margin, y);
    doc.text((row.merkleRoot ?? '—').slice(0, 16) + '…', margin + 55, y);
    if (row.valid) {
      doc.setTextColor(16, 185, 129);
      doc.text('YES', margin + 115, y);
    } else {
      doc.setTextColor(239, 68, 68);
      doc.text('NO', margin + 115, y);
    }
    doc.setTextColor(226, 232, 240);
    const reasonText = row.valid ? '' : (row.reason ?? '').slice(0, 40);
    doc.text(reasonText, margin + 130, y);
    y += 6;
  }

  y += 8;
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text(
    'All metrics include Laplace noise (ε=1.0). Ring signatures prove someone in the ring attested, not which device.',
    margin, y, { maxWidth: pageW - margin * 2 }
  );

  const filename = `accessbridge-audit-${lastResults.date ?? 'export'}.pdf`;
  doc.save(filename);
}

// ---------------------------------------------------------------------------
// Wire up event listeners — no inline onclick
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  const btnDate = document.getElementById('btn-verify-date');
  const btnPaste = document.getElementById('btn-verify-paste');
  const btnPDF = document.getElementById('btn-download-pdf');
  const dateInput = document.getElementById('date-input');
  const pasteInput = document.getElementById('paste-input');

  // Pre-fill today's date
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  dateInput.value = `${yyyy}-${mm}-${dd}`;

  btnDate.addEventListener('click', () => {
    const dateStr = dateInput.value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      showError('Date must be in YYYY-MM-DD format.');
      dateInput.focus();
      return;
    }
    verifyByDate(dateStr);
  });

  dateInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnDate.click();
  });

  btnPaste.addEventListener('click', () => {
    const text = pasteInput.value.trim();
    if (!text) {
      showError('Paste an attestation JSON first.');
      pasteInput.focus();
      return;
    }
    verifyPasted(text);
  });

  btnPDF.addEventListener('click', downloadPDF);
});
