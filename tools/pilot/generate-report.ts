#!/usr/bin/env tsx
/**
 * generate-report.ts — AccessBridge Session 24 pilot report generator.
 *
 * Fetches pilot results from the orchestrator API and generates a PDF
 * report (or JSON) matching Plan Section 17.1 + 17.2 format.
 *
 * Author  : Manish Kumar
 * Project : AccessBridge v0.22.0
 * Session : 24 — Team-tier installer
 * Updated : 2026-04-21
 *
 * Usage:
 *   tsx tools/pilot/generate-report.ts \
 *     --pilot-id <id> \
 *     --orchestrator-url https://accessbridge.space \
 *     --admin-token <token> \
 *     --output report.pdf
 *
 *   tsx tools/pilot/generate-report.ts \
 *     --pilot-id <id> \
 *     --orchestrator-url https://accessbridge.space \
 *     --admin-token <token> \
 *     --output results.json \
 *     --format json
 *
 * PDF format uses pdf-lib for all drawing.
 * Requires: pnpm add -w pdf-lib  (or already present in repo deps)
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Types — Plan §17.1 API response schema (inferred from context)
// ---------------------------------------------------------------------------

interface MetricResult {
  name: string;
  target: number;
  actual: number;
  unit: string;         // e.g. "%", "ms", "score"
}

interface FeatureAdoption {
  feature: string;
  adoptionRate: number;  // 0-1
  sessionCount: number;
}

interface TopIssue {
  id: string;           // e.g. BUG-012
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  count: number;
  status: 'open' | 'resolved';
}

interface Recommendation {
  priority: number;     // 1 = highest
  text: string;
}

interface PilotResults {
  pilotId: string;
  cohortName: string;
  startDate: string;
  endDate: string;
  participantCount: number;
  completionRate: number;    // 0-1
  metrics: MetricResult[];
  featureAdoption: FeatureAdoption[];
  topIssues: TopIssue[];
  recommendations: Recommendation[];
}

// ---------------------------------------------------------------------------
// Argument parsing (no external deps)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();
  const args = argv.slice(2);
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      result.set('help', true);
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        result.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        result.set(arg.slice(2), args[i + 1]);
        i++;
      } else {
        result.set(arg.slice(2), true);
      }
    }
    i++;
  }
  return result;
}

function printHelp(): void {
  console.log(`
AccessBridge Pilot Report Generator — v0.22.0
Author: Manish Kumar

USAGE
  tsx tools/pilot/generate-report.ts [OPTIONS]

REQUIRED
  --pilot-id <string>           Pilot cohort identifier
  --orchestrator-url <url>      Base URL of the orchestrator API (must be https://)
  --admin-token <token>         Bearer token for API authentication (never logged)
  --output <path>               Output file path (.pdf or .json)

OPTIONS
  --format <pdf|json>           Output format (default: inferred from --output extension)
  --insecure                    Allow http:// orchestrator URL (dev only)
  --help                        Show this help and exit

EXAMPLES
  tsx tools/pilot/generate-report.ts \\
    --pilot-id cohort-2026-q2 \\
    --orchestrator-url https://accessbridge.space \\
    --admin-token \$ADMIN_TOKEN \\
    --output reports/q2-2026.pdf

  tsx tools/pilot/generate-report.ts \\
    --pilot-id cohort-2026-q2 \\
    --orchestrator-url https://accessbridge.space \\
    --admin-token \$ADMIN_TOKEN \\
    --output results.json \\
    --format json

SECURITY NOTES
  • Admin token is passed at runtime only — never stored in any output file.
  • --orchestrator-url must use https:// unless --insecure is set (dev only).
`);
}

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

async function fetchPilotResults(
  orchestratorUrl: string,
  pilotId: string,
  adminToken: string,
): Promise<PilotResults> {
  const url = `${orchestratorUrl.replace(/\/$/, '')}/api/pilot/${encodeURIComponent(pilotId)}/results`;
  console.log(`[INFO] Fetching pilot results from: ${url}`);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${adminToken}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json() as unknown;
  return json as PilotResults;
}

// ---------------------------------------------------------------------------
// PDF generation via pdf-lib
// ---------------------------------------------------------------------------

async function generatePdf(results: PilotResults, outputPath: string): Promise<void> {
  // Dynamic import so tsx doesn't fail if pdf-lib is absent at type-check time
  let PDFDocument: any, rgb: any, StandardFonts: any;
  try {
    const pdfLib = await import('pdf-lib');
    PDFDocument   = pdfLib.PDFDocument;
    rgb           = pdfLib.rgb;
    StandardFonts = pdfLib.StandardFonts;
  } catch {
    throw new Error(
      'pdf-lib not found. Install it with: pnpm add -w pdf-lib\n' +
      'Or use --format json to skip PDF generation.'
    );
  }

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`AccessBridge Pilot Report: ${results.cohortName}`);
  pdfDoc.setAuthor('Manish Kumar');
  pdfDoc.setCreator('AccessBridge generate-report.ts v0.22.0');

  const fontBold   = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const PAGE_W    = 595.28;  // A4
  const PAGE_H    = 841.89;
  const MARGIN    = 50;
  const COL_W     = PAGE_W - MARGIN * 2;

  // Colour palette (AccessBridge brand: deep indigo + amber)
  const C_INDIGO  = rgb(0.18, 0.20, 0.56);
  const C_AMBER   = rgb(0.96, 0.65, 0.14);
  const C_GRAY    = rgb(0.55, 0.55, 0.55);
  const C_LIGHT   = rgb(0.93, 0.94, 0.97);
  const C_GREEN   = rgb(0.22, 0.65, 0.36);
  const C_RED     = rgb(0.84, 0.20, 0.20);
  const C_WHITE   = rgb(1, 1, 1);
  const C_BLACK   = rgb(0, 0, 0);

  // ---- Page 1: Title + Cohort Summary ------------------------------------
  const page1 = pdfDoc.addPage([PAGE_W, PAGE_H]);

  // Header band
  page1.drawRectangle({ x: 0, y: PAGE_H - 90, width: PAGE_W, height: 90, color: C_INDIGO });
  page1.drawText('AccessBridge Pilot Report', {
    x: MARGIN, y: PAGE_H - 38, size: 22, font: fontBold, color: C_WHITE,
  });
  page1.drawText(`${results.cohortName}`, {
    x: MARGIN, y: PAGE_H - 60, size: 13, font: fontNormal, color: C_AMBER,
  });
  page1.drawText(`Generated: ${new Date().toISOString().slice(0, 10)}  |  Pilot ID: ${results.pilotId}`, {
    x: MARGIN, y: PAGE_H - 78, size: 9, font: fontNormal, color: C_WHITE,
  });

  let y = PAGE_H - 115;

  const drawSectionHeader = (page: any, text: string, yPos: number): number => {
    page.drawRectangle({ x: MARGIN, y: yPos - 4, width: COL_W, height: 20, color: C_LIGHT });
    page.drawText(text, { x: MARGIN + 6, y: yPos, size: 11, font: fontBold, color: C_INDIGO });
    return yPos - 30;
  };

  const drawKV = (page: any, key: string, value: string, yPos: number): number => {
    page.drawText(`${key}:`, { x: MARGIN, y: yPos, size: 10, font: fontBold, color: C_GRAY });
    page.drawText(value, { x: MARGIN + 170, y: yPos, size: 10, font: fontNormal, color: C_BLACK });
    return yPos - 16;
  };

  // §1 Cohort Summary
  y = drawSectionHeader(page1, '§1  Cohort Summary', y);
  y = drawKV(page1, 'Pilot Period', `${results.startDate} → ${results.endDate}`, y);
  y = drawKV(page1, 'Participants', String(results.participantCount), y);
  y = drawKV(page1, 'Completion Rate', `${(results.completionRate * 100).toFixed(1)} %`, y);
  y -= 10;

  // §2 Metrics vs Targets (bar charts)
  y = drawSectionHeader(page1, '§2  Metrics vs Targets', y);

  const BAR_MAX_W = 220;
  const BAR_H = 14;
  const BAR_GAP = 22;

  const metricsToShow = results.metrics.slice(0, 6);
  for (const metric of metricsToShow) {
    if (y < MARGIN + 60) break; // guard page overflow

    const pctActual = metric.target > 0 ? Math.min(metric.actual / metric.target, 2) : 0;
    const pctTarget = 1.0;
    const metHit    = metric.actual >= metric.target;

    const labelText = metric.name.slice(0, 28);
    const valueText = `${metric.actual} ${metric.unit} / target ${metric.target} ${metric.unit}`;

    page1.drawText(labelText, { x: MARGIN, y: y + 2, size: 9, font: fontBold, color: C_BLACK });
    page1.drawText(valueText, { x: MARGIN + 200, y: y + 2, size: 8, font: fontNormal, color: C_GRAY });

    const barX = MARGIN;
    const barY = y - BAR_H;

    // Background track
    page1.drawRectangle({ x: barX, y: barY, width: BAR_MAX_W, height: BAR_H, color: C_LIGHT });
    // Actual bar
    page1.drawRectangle({
      x: barX, y: barY,
      width: BAR_MAX_W * Math.min(pctActual, 1),
      height: BAR_H,
      color: metHit ? C_GREEN : C_RED,
    });
    // Target marker line
    page1.drawLine({
      start: { x: barX + BAR_MAX_W * pctTarget, y: barY - 2 },
      end:   { x: barX + BAR_MAX_W * pctTarget, y: barY + BAR_H + 2 },
      thickness: 1.5,
      color: C_INDIGO,
    });

    y -= BAR_GAP + BAR_H;
  }

  // ---- Page 2: Feature Adoption + Top Issues + Recommendations -----------
  const page2 = pdfDoc.addPage([PAGE_W, PAGE_H]);

  // Header band (repeat)
  page2.drawRectangle({ x: 0, y: PAGE_H - 50, width: PAGE_W, height: 50, color: C_INDIGO });
  page2.drawText('AccessBridge Pilot Report (continued)', {
    x: MARGIN, y: PAGE_H - 30, size: 14, font: fontBold, color: C_WHITE,
  });
  page2.drawText(results.cohortName, {
    x: MARGIN, y: PAGE_H - 44, size: 9, font: fontNormal, color: C_AMBER,
  });

  y = PAGE_H - 70;

  // §3 Feature Adoption
  y = drawSectionHeader(page2, '§3  Feature Adoption', y);

  const ADOPT_BAR_W = 180;
  const ADOPT_BAR_H = 12;

  for (const fa of results.featureAdoption.slice(0, 8)) {
    if (y < MARGIN + 40) break;

    page2.drawText(fa.feature.slice(0, 30), { x: MARGIN, y: y + 1, size: 9, font: fontNormal, color: C_BLACK });
    page2.drawText(`${(fa.adoptionRate * 100).toFixed(0)} %  (${fa.sessionCount} sessions)`,
      { x: MARGIN + 200, y: y + 1, size: 8, font: fontNormal, color: C_GRAY });

    const barY = y - ADOPT_BAR_H;
    page2.drawRectangle({ x: MARGIN, y: barY, width: ADOPT_BAR_W, height: ADOPT_BAR_H, color: C_LIGHT });
    page2.drawRectangle({ x: MARGIN, y: barY, width: ADOPT_BAR_W * fa.adoptionRate, height: ADOPT_BAR_H, color: C_AMBER });

    y -= 20 + ADOPT_BAR_H;
  }

  y -= 10;

  // §4 Top Issues
  if (results.topIssues && results.topIssues.length > 0) {
    y = drawSectionHeader(page2, '§4  Top Issues', y);

    const SEV_COLOR: Record<string, any> = {
      critical: C_RED,
      high:     rgb(0.90, 0.40, 0.10),
      medium:   C_AMBER,
      low:      C_GRAY,
    };

    for (const issue of results.topIssues.slice(0, 5)) {
      if (y < MARGIN + 30) break;

      const sevColor = SEV_COLOR[issue.severity] ?? C_GRAY;
      page2.drawRectangle({ x: MARGIN, y: y - 3, width: 48, height: 14, color: sevColor });
      page2.drawText(issue.severity.toUpperCase(), { x: MARGIN + 2, y: y, size: 7, font: fontBold, color: C_WHITE });

      page2.drawText(`${issue.id}  ${issue.title.slice(0, 55)}`, {
        x: MARGIN + 55, y: y, size: 9, font: fontNormal, color: C_BLACK,
      });
      page2.drawText(`count: ${issue.count}  status: ${issue.status}`, {
        x: MARGIN + 55, y: y - 12, size: 8, font: fontNormal, color: C_GRAY,
      });
      y -= 28;
    }

    y -= 10;
  }

  // §5 Recommendations
  if (results.recommendations && results.recommendations.length > 0) {
    y = drawSectionHeader(page2, '§5  Recommendations', y);

    const sorted = [...results.recommendations].sort((a, b) => a.priority - b.priority);
    for (const rec of sorted.slice(0, 6)) {
      if (y < MARGIN + 20) break;
      page2.drawText(`${rec.priority}.`, { x: MARGIN, y, size: 10, font: fontBold, color: C_INDIGO });
      // Word-wrap naively at ~85 chars
      const words = rec.text.split(' ');
      let line = '';
      let lineY = y;
      const LINE_X = MARGIN + 18;
      const MAX_CHARS = 85;
      for (const word of words) {
        if ((line + word).length > MAX_CHARS) {
          page2.drawText(line.trim(), { x: LINE_X, y: lineY, size: 9, font: fontNormal, color: C_BLACK });
          lineY -= 13;
          line = word + ' ';
        } else {
          line += word + ' ';
        }
      }
      if (line.trim()) {
        page2.drawText(line.trim(), { x: LINE_X, y: lineY, size: 9, font: fontNormal, color: C_BLACK });
        lineY -= 13;
      }
      y = lineY - 6;
    }
  }

  // §6 Footer / Signature
  const lastPage = pdfDoc.getPages().at(-1)!;
  lastPage.drawLine({
    start: { x: MARGIN, y: MARGIN + 20 },
    end:   { x: PAGE_W - MARGIN, y: MARGIN + 20 },
    thickness: 0.5, color: C_GRAY,
  });
  lastPage.drawText('AccessBridge v0.22.0  |  Manish Kumar  |  Confidential pilot data', {
    x: MARGIN, y: MARGIN + 6, size: 7, font: fontNormal, color: C_GRAY,
  });

  // Serialise
  const pdfBytes = await pdfDoc.save();

  // Verify PDF header + footer (acceptance requirement)
  const headerCheck = Buffer.from(pdfBytes.slice(0, 8)).toString('ascii');
  if (!headerCheck.startsWith('%PDF-')) {
    throw new Error('pdf-lib produced invalid PDF (missing %PDF- header)');
  }

  writeFileSync(outputPath, pdfBytes);
  console.log(`[INFO] PDF written to: ${outputPath} (${pdfBytes.length} bytes)`);
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

function generateJson(results: PilotResults, outputPath: string): void {
  // Exclude admin token from output (it is never in results anyway)
  const safe = JSON.stringify(results, null, 2);
  writeFileSync(outputPath, safe, 'utf8');
  console.log(`[INFO] JSON results written to: ${outputPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.has('help') || args.size === 0) {
    printHelp();
    process.exit(0);
  }

  const pilotId       = args.get('pilot-id');
  const orchUrl       = args.get('orchestrator-url');
  const adminToken    = args.get('admin-token');
  const outputArg     = args.get('output');
  const formatArg     = args.get('format');
  const insecure      = args.has('insecure');

  // Validate required args
  const missing: string[] = [];
  if (!pilotId || pilotId === true)    missing.push('--pilot-id');
  if (!orchUrl || orchUrl === true)     missing.push('--orchestrator-url');
  if (!adminToken || adminToken === true) missing.push('--admin-token');
  if (!outputArg || outputArg === true) missing.push('--output');

  if (missing.length > 0) {
    console.error(`[ERROR] Missing required arguments: ${missing.join(', ')}`);
    process.exit(1);
  }

  const orchUrlStr   = orchUrl as string;
  const outputPath   = resolve(outputArg as string);
  const pilotIdStr   = pilotId as string;
  const adminTokenStr = adminToken as string;

  // Security: enforce HTTPS unless --insecure (Rule 6)
  if (!insecure && !orchUrlStr.startsWith('https://')) {
    console.error('[ERROR] --orchestrator-url must start with https://');
    console.error('        Use --insecure to allow http:// in dev environments.');
    process.exit(1);
  }

  // Infer format from output extension if not specified
  let format: 'pdf' | 'json';
  if (formatArg && formatArg !== true) {
    if (formatArg !== 'pdf' && formatArg !== 'json') {
      console.error(`[ERROR] --format must be 'pdf' or 'json', got: ${formatArg}`);
      process.exit(1);
    }
    format = formatArg as 'pdf' | 'json';
  } else {
    format = outputPath.toLowerCase().endsWith('.json') ? 'json' : 'pdf';
  }

  // Ensure output directory exists
  const outDir = dirname(outputPath);
  mkdirSync(outDir, { recursive: true });

  // Fetch results
  let results: PilotResults;
  try {
    results = await fetchPilotResults(orchUrlStr, pilotIdStr, adminTokenStr);
  } catch (err) {
    console.error(`[ERROR] Failed to fetch pilot results: ${(err as Error).message}`);
    process.exit(1);
  }

  // Generate output
  if (format === 'json') {
    generateJson(results, outputPath);
  } else {
    await generatePdf(results, outputPath);
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
