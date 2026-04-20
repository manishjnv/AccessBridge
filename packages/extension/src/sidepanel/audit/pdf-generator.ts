import jsPDF from 'jspdf';
import type { AuditReport, AuditFinding, WCAGPrinciple, AuditSeverity } from '@accessbridge/core/audit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

function severityColor(severity: AuditSeverity): RGB {
  switch (severity) {
    case 'critical':  return [192, 21,  21 ];
    case 'serious':   return [217, 97,  0  ];
    case 'moderate':  return [180, 140, 0  ];
    case 'minor':     return [60,  120, 200];
    case 'info':      return [100, 100, 100];
  }
}

function scoreColor(score: number): RGB {
  if (score >= 80) return [34, 139, 34];   // green
  if (score >= 50) return [200, 140, 0];   // amber
  return [192, 21, 21];                     // red
}

function scoreLabel(score: number): string {
  if (score >= 80) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Poor';
}

function wrapText(doc: jsPDF, text: string, maxWidth: number): string[] {
  return doc.splitTextToSize(text, maxWidth) as string[];
}

function drawBar(
  doc: jsPDF,
  x: number,
  y: number,
  totalWidth: number,
  height: number,
  percentage: number,
  color: RGB,
): void {
  // Background track
  doc.setFillColor(220, 220, 220);
  doc.rect(x, y, totalWidth, height, 'F');
  // Filled portion
  const filled = Math.max(0, Math.min(1, percentage / 100)) * totalWidth;
  if (filled > 0) {
    doc.setFillColor(color[0], color[1], color[2]);
    doc.rect(x, y, filled, height, 'F');
  }
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function yyyymmdd(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function principleLabel(p: WCAGPrinciple): string {
  return p.charAt(0).toUpperCase() + p.slice(1);
}

function principleColor(p: WCAGPrinciple): RGB {
  switch (p) {
    case 'perceivable':    return [52, 120, 180];
    case 'operable':       return [34, 139, 34];
    case 'understandable': return [180, 100, 0];
    case 'robust':         return [120, 60, 180];
  }
}

const PRINCIPLES_ORDER: WCAGPrinciple[] = ['perceivable', 'operable', 'understandable', 'robust'];

// ---------------------------------------------------------------------------
// Page 1 — Cover
// ---------------------------------------------------------------------------
function buildCoverPage(doc: jsPDF, report: AuditReport): void {
  const pageW = doc.internal.pageSize.getWidth();
  const cx = pageW / 2;

  // Header band
  doc.setFillColor(30, 60, 120);
  doc.rect(0, 0, pageW, 45, 'F');

  // Title
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.text('AccessBridge Accessibility Audit', cx, 22, { align: 'center' });

  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  const urlDisplay = report.url.length > 80 ? report.url.slice(0, 77) + '...' : report.url;
  doc.text(urlDisplay, cx, 35, { align: 'center' });

  // Date
  doc.setTextColor(80, 80, 80);
  doc.setFontSize(10);
  doc.text(`Scanned: ${formatDate(report.scannedAt)}`, cx, 57, { align: 'center' });

  // Page title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(30, 30, 30);
  const titleDisplay = report.pageTitle.length > 80 ? report.pageTitle.slice(0, 77) + '...' : report.pageTitle;
  doc.text(titleDisplay, cx, 70, { align: 'center' });

  // Divider
  doc.setDrawColor(200, 200, 200);
  doc.line(20, 78, pageW - 20, 78);

  // Score circle (drawn as filled circle)
  const score = Math.round(report.overallScore);
  const [cr, cg, cb] = scoreColor(score);
  doc.setFillColor(cr, cg, cb);
  doc.circle(cx, 115, 28, 'F');

  // Score text
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(36);
  doc.text(`${score}`, cx, 121, { align: 'center' });

  doc.setFontSize(11);
  doc.text('/100', cx, 132, { align: 'center' });

  // Score label below circle
  doc.setTextColor(cr, cg, cb);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(scoreLabel(score), cx, 152, { align: 'center' });

  // WCAG compliance strip
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(60, 60, 60);
  const { A, AA, AAA } = report.wcagCompliance;
  const strip = `A: ${A}%  ·  AA: ${AA}%  ·  AAA: ${AAA}%`;
  doc.text(strip, cx, 168, { align: 'center' });

  // Summary counts band
  doc.setFillColor(248, 248, 248);
  doc.rect(20, 178, pageW - 40, 32, 'F');
  doc.setDrawColor(220, 220, 220);
  doc.rect(20, 178, pageW - 40, 32, 'S');

  const summaryItems: [string, number, RGB][] = [
    ['Critical', report.summary.critical, [192, 21, 21]],
    ['Serious',  report.summary.serious,  [217, 97, 0]],
    ['Moderate', report.summary.moderate, [180, 140, 0]],
    ['Minor',    report.summary.minor,    [60, 120, 200]],
    ['Info',     report.summary.info,     [100, 100, 100]],
  ];
  const boxW = (pageW - 40) / 5;
  summaryItems.forEach(([label, count, rgb], i) => {
    const bx = 20 + i * boxW + boxW / 2;
    doc.setTextColor(rgb[0], rgb[1], rgb[2]);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text(String(count), bx, 192, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(80, 80, 80);
    doc.text(label, bx, 202, { align: 'center' });
  });

  // Total findings
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(100, 100, 100);
  doc.text(`${report.findings.length} total findings across ${report.totalElements} elements`, cx, 224, { align: 'center' });
}

// ---------------------------------------------------------------------------
// Page 2 — Executive Summary + Category Scores
// ---------------------------------------------------------------------------
function buildSummaryPage(doc: jsPDF, report: AuditReport): void {
  doc.addPage();
  const pageW = doc.internal.pageSize.getWidth();

  // Section header
  doc.setFillColor(30, 60, 120);
  doc.rect(0, 0, pageW, 18, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('Category Scores', 14, 12);

  let y = 30;

  PRINCIPLES_ORDER.forEach((principle) => {
    const pct = Math.round(report.scoreByCategory[principle] ?? 0);
    const color = principleColor(principle);
    const label = principleLabel(principle);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(30, 30, 30);
    doc.text(`${label}`, 14, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(color[0], color[1], color[2]);
    doc.text(`${pct}%`, pageW - 20, y, { align: 'right' });

    drawBar(doc, 14, y + 2, pageW - 28, 6, pct, color);
    y += 22;
  });

  // Divider
  doc.setDrawColor(200, 200, 200);
  doc.line(14, y, pageW - 14, y);
  y += 10;

  // Generated narrative paragraph
  const worstPrinciple = PRINCIPLES_ORDER.reduce((worst, p) =>
    (report.scoreByCategory[p] ?? 0) < (report.scoreByCategory[worst] ?? 0) ? p : worst
  );
  const { critical, serious, moderate, minor, info } = report.summary;
  const topSeverity = critical > 0 ? 'critical' : serious > 0 ? 'serious' : moderate > 0 ? 'moderate' : minor > 0 ? 'minor' : 'info';

  const narrative = [
    `This audit identified ${report.findings.length} potential accessibility issues across ${report.totalElements} `,
    `DOM elements on "${report.pageTitle}". The lowest-scoring WCAG principle is `,
    `${principleLabel(worstPrinciple)} (${Math.round(report.scoreByCategory[worstPrinciple] ?? 0)}%), `,
    `which warrants immediate attention. The most prevalent severity category is `,
    `${topSeverity}, with ${critical} critical, ${serious} serious, ${moderate} moderate, `,
    `${minor} minor, and ${info} informational findings. `,
    `Overall accessibility score: ${Math.round(report.overallScore)}/100.`,
  ].join('');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(40, 40, 40);
  const lines = wrapText(doc, narrative, pageW - 28);
  doc.text(lines, 14, y);
}

// ---------------------------------------------------------------------------
// Pages 3+ — Findings
// ---------------------------------------------------------------------------
function buildFindingsPages(doc: jsPDF, report: AuditReport): void {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const Y_MAX = pageH - 18;

  // Group by principle
  const grouped = new Map<WCAGPrinciple, AuditFinding[]>();
  for (const p of PRINCIPLES_ORDER) grouped.set(p, []);
  for (const f of report.findings) {
    grouped.get(f.wcagPrinciple)?.push(f);
  }

  // Sort each group by severity
  const SEV_ORDER: Record<AuditSeverity, number> = {
    critical: 0, serious: 1, moderate: 2, minor: 3, info: 4,
  };
  grouped.forEach((arr) => arr.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]));

  let y = 0;

  function ensurePage(needed: number): void {
    if (y === 0 || y + needed > Y_MAX) {
      doc.addPage();
      y = 18;
      // Page header
      doc.setFillColor(30, 60, 120);
      doc.rect(0, 0, pageW, 14, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text('AccessBridge — Findings', 14, 10);
    }
  }

  PRINCIPLES_ORDER.forEach((principle) => {
    const findings = grouped.get(principle) ?? [];
    if (findings.length === 0) return;

    ensurePage(22);

    // Principle heading
    const pColor = principleColor(principle);
    doc.setFillColor(pColor[0], pColor[1], pColor[2]);
    doc.rect(14, y, pageW - 28, 10, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(`${principleLabel(principle)} (${findings.length} findings)`, 17, y + 7);
    y += 14;

    findings.forEach((finding) => {
      // Estimate height: title + selector + message + suggestion + snippet + padding
      ensurePage(52);

      const sColor = severityColor(finding.severity);

      // Severity badge + rule line
      doc.setFillColor(sColor[0], sColor[1], sColor[2]);
      doc.rect(14, y, 30, 6, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.text(finding.severity.toUpperCase(), 29, y + 4.2, { align: 'center' });

      doc.setTextColor(30, 30, 30);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      const ruleTitle = `WCAG ${finding.wcagCriterion} — ${finding.rule}`;
      doc.text(ruleTitle, 47, y + 4.5);
      y += 9;

      // Element selector
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(80, 80, 80);
      const selectorLines = wrapText(doc, `Element: ${finding.elementSelector}`, pageW - 28);
      if (y + selectorLines.length * 4.5 > Y_MAX) { ensurePage(selectorLines.length * 4.5 + 4); }
      doc.text(selectorLines, 14, y);
      y += selectorLines.length * 4.5;

      // Message
      doc.setTextColor(40, 40, 40);
      const msgLines = wrapText(doc, `Message: ${finding.message}`, pageW - 28);
      if (y + msgLines.length * 4.5 > Y_MAX) { ensurePage(msgLines.length * 4.5 + 4); }
      doc.text(msgLines, 14, y);
      y += msgLines.length * 4.5;

      // Suggestion
      doc.setTextColor(30, 100, 30);
      const sugLines = wrapText(doc, `Suggestion: ${finding.suggestion}`, pageW - 28);
      if (y + sugLines.length * 4.5 > Y_MAX) { ensurePage(sugLines.length * 4.5 + 4); }
      doc.text(sugLines, 14, y);
      y += sugLines.length * 4.5;

      // HTML snippet box
      const snippet = finding.htmlSnippet.slice(0, 120);
      if (snippet) {
        doc.setFillColor(245, 245, 245);
        doc.setDrawColor(200, 200, 200);
        const snippetLines = wrapText(doc, snippet, pageW - 36);
        const boxH = snippetLines.length * 4 + 4;
        if (y + boxH > Y_MAX) { ensurePage(boxH + 4); }
        doc.rect(14, y, pageW - 28, boxH, 'FD');
        doc.setFont('courier', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(60, 60, 60);
        doc.text(snippetLines, 16, y + 4);
        y += boxH + 3;
        doc.setFont('helvetica', 'normal');
      }

      // Separator
      doc.setDrawColor(230, 230, 230);
      doc.line(14, y, pageW - 14, y);
      y += 5;
    });
  });
}

// ---------------------------------------------------------------------------
// Last Page — Compliance Statement
// ---------------------------------------------------------------------------
function buildCompliancePage(doc: jsPDF, report: AuditReport, manifestVersion: string): void {
  doc.addPage();
  const pageW = doc.internal.pageSize.getWidth();

  doc.setFillColor(30, 60, 120);
  doc.rect(0, 0, pageW, 18, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Compliance Statement', 14, 12);

  let y = 36;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(40, 40, 40);

  const statements = [
    `Generated by AccessBridge v${manifestVersion} on ${formatDate(report.scannedAt)}.`,
    `This report identifies ${report.findings.length} potential accessibility issues based on WCAG 2.1 heuristics.`,
    `It is a developer aid and does not constitute formal certification.`,
  ];

  statements.forEach((s) => {
    const lines = wrapText(doc, s, pageW - 28);
    doc.text(lines, 14, y);
    y += lines.length * 6 + 4;
  });

  // Footer line
  doc.setDrawColor(200, 200, 200);
  doc.line(14, y + 10, pageW - 14, y + 10);
  doc.setFontSize(8);
  doc.setTextColor(140, 140, 140);
  doc.text('AccessBridge — Ambient Accessibility Operating Layer', pageW / 2, y + 16, { align: 'center' });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateAuditPDF(report: AuditReport, manifestVersion: string): Blob {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  buildCoverPage(doc, report);
  buildSummaryPage(doc, report);
  buildFindingsPages(doc, report);
  buildCompliancePage(doc, report, manifestVersion);

  return doc.output('blob');
}

export function downloadAuditPDF(report: AuditReport, manifestVersion: string): void {
  const blob = generateAuditPDF(report, manifestVersion);
  const url = URL.createObjectURL(blob);

  let hostname = 'page';
  try {
    hostname = new URL(report.url).hostname.replace(/[^a-zA-Z0-9-]/g, '-');
  } catch {
    // ignore
  }
  const date = yyyymmdd(report.scannedAt);
  const filename = `accessbridge-audit-${hostname}-${date}.pdf`;

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
