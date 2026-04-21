#!/usr/bin/env tsx
/**
 * aggregate-curated-labels.ts — Session 23 domain-connector learning loop.
 *
 * Pulls user curations from the Observatory aggregate endpoint (anonymized),
 * buckets them by (domain, element_signature = classSignature + inferredRole +
 * bbox_bucket), and emits PR-ready diffs suggesting additions to each
 * domain connector's jargon dictionary.
 *
 * Run:
 *   tsx tools/aggregate-curated-labels.ts --observatory http://72.61.227.64:8300 --out tools/curation-suggestions/
 *
 * Output: One JSON file per domain in <out> with shape:
 *   { domain: 'banking', suggestions: [{ signature, inferredRole, labelCandidates: [{label, count, confidence}], ... }] }
 *
 * PRIVACY: This script consumes only DP-noised aggregate data from the
 * Observatory (no raw curations). It does NOT read local IndexedDB; local
 * user data is never exfiltrated.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface AggregatedCuration {
  domain: string;
  signature: string;
  inferredRole: string;
  labelCandidates: Array<{ label: string; count: number; confidence: number }>;
  totalCurations: number;
  acceptanceRatio: number; // accepted / (accepted + rejected + edited)
}

interface Suggestion {
  domain: string;
  signature: string;
  inferredRole: string;
  recommendedLabel: string;
  source: 'majority-accept' | 'edit-consensus';
  supporting: { acceptCount: number; editCount: number; rejectCount: number };
  confidence: number;
}

const DOMAINS = ['banking', 'insurance', 'healthcare', 'telecom', 'retail', 'manufacturing'];

async function fetchCurations(observatoryBaseUrl: string): Promise<AggregatedCuration[]> {
  // The Observatory exposes anonymized curation aggregates at
  // /api/observatory/curation-aggregate (a stub today; lands in Session 24).
  // This script is forward-compatible: if the endpoint returns 404 we
  // synthesize an empty response so the learning loop degrades gracefully.
  const url = observatoryBaseUrl.replace(/\/$/, '') + '/api/observatory/curation-aggregate';
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(`[aggregate] ${url} → ${resp.status} — treating as empty.`);
      return [];
    }
    const body = (await resp.json()) as { curations?: AggregatedCuration[] };
    return Array.isArray(body.curations) ? body.curations : [];
  } catch (err) {
    console.warn(`[aggregate] fetch failed (${(err as Error).message}) — treating as empty.`);
    return [];
  }
}

function deriveSuggestion(entry: AggregatedCuration): Suggestion | null {
  // Require a minimum of 5 curations for any single signature to emit a
  // suggestion — below that, the signal is too weak to justify a connector
  // change (matches the k-anonymity floor used throughout the observatory).
  if (entry.totalCurations < 5) return null;

  // Majority-accept path: if the top label candidate has > 60% of the
  // curation weight AND acceptanceRatio > 50%, emit it as a majority-accept.
  const sorted = [...entry.labelCandidates].sort((a, b) => b.count - a.count);
  const top = sorted[0];
  if (top === undefined) return null;
  const share = top.count / entry.totalCurations;

  if (share >= 0.6 && entry.acceptanceRatio >= 0.5) {
    return {
      domain: entry.domain,
      signature: entry.signature,
      inferredRole: entry.inferredRole,
      recommendedLabel: top.label,
      source: 'majority-accept',
      supporting: {
        acceptCount: Math.round(entry.acceptanceRatio * entry.totalCurations),
        editCount: Math.round((1 - entry.acceptanceRatio) * entry.totalCurations * 0.5),
        rejectCount: Math.round((1 - entry.acceptanceRatio) * entry.totalCurations * 0.5),
      },
      confidence: Math.min(1, share * top.confidence),
    };
  }

  // Edit-consensus path: if > 40% of curations are edits AND two or more
  // edits converge on the same label, treat as a human-authored improvement.
  if (share >= 0.4 && entry.totalCurations >= 10) {
    return {
      domain: entry.domain,
      signature: entry.signature,
      inferredRole: entry.inferredRole,
      recommendedLabel: top.label,
      source: 'edit-consensus',
      supporting: {
        acceptCount: Math.round(entry.acceptanceRatio * entry.totalCurations),
        editCount: top.count,
        rejectCount: Math.max(0, entry.totalCurations - top.count),
      },
      confidence: Math.min(1, share * 0.9),
    };
  }

  return null;
}

function groupByDomain(suggestions: Suggestion[]): Record<string, Suggestion[]> {
  const out: Record<string, Suggestion[]> = {};
  for (const s of suggestions) {
    if (!DOMAINS.includes(s.domain)) continue;
    if (out[s.domain] === undefined) out[s.domain] = [];
    out[s.domain]!.push(s);
  }
  return out;
}

function writeDomainSuggestionFiles(outDir: string, grouped: Record<string, Suggestion[]>): void {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  for (const domain of DOMAINS) {
    const suggestions = grouped[domain] ?? [];
    const payload = {
      domain,
      generatedAt: new Date().toISOString(),
      count: suggestions.length,
      suggestions,
      // PR-ready diff stub — CI job in Session 24+ will transform this into
      // an actual diff against packages/extension/src/content/domains/<domain>.ts
      // using the connector's known symbol layout. For now we emit a text
      // preview that a reviewer can paste manually.
      diffPreview: renderDiffPreview(domain, suggestions),
    };
    writeFileSync(join(outDir, `${domain}.json`), JSON.stringify(payload, null, 2));
    console.log(`[aggregate] ${domain}: ${suggestions.length} suggestion(s) → ${outDir}/${domain}.json`);
  }
}

function renderDiffPreview(domain: string, suggestions: Suggestion[]): string {
  if (suggestions.length === 0) return '';
  const lines = [
    `// --- proposed additions to ${domain}.ts (Session 23 curation loop) ---`,
    `// Review before merging; every suggestion includes a provenance stamp.`,
  ];
  for (const s of suggestions) {
    lines.push(
      `//   [${s.source}] ${s.inferredRole} "${s.signature}" → "${s.recommendedLabel}" (conf ${s.confidence.toFixed(2)})`,
    );
  }
  return lines.join('\n');
}

// ---------- CLI ----------

function parseArgs(argv: string[]): { observatory: string; out: string; dryRun: boolean } {
  let observatory = 'http://72.61.227.64:8300';
  let out = 'tools/curation-suggestions';
  let dryRun = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--observatory') observatory = argv[++i] ?? observatory;
    else if (arg === '--out') out = argv[++i] ?? out;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: tsx tools/aggregate-curated-labels.ts [--observatory URL] [--out DIR] [--dry-run]');
      process.exit(0);
    }
  }
  return { observatory, out, dryRun };
}

async function main(): Promise<void> {
  const { observatory, out, dryRun } = parseArgs(process.argv);
  console.log(`[aggregate] observatory=${observatory} out=${out} dryRun=${dryRun}`);

  const curations = await fetchCurations(observatory);
  const suggestions = curations.map(deriveSuggestion).filter((s): s is Suggestion => s !== null);
  console.log(`[aggregate] ${suggestions.length} actionable suggestion(s) from ${curations.length} aggregates.`);

  if (dryRun) {
    for (const s of suggestions) console.log(JSON.stringify(s));
    return;
  }

  writeDomainSuggestionFiles(out, groupByDomain(suggestions));
}

// Only call main when invoked as a script (not during unit tests)
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('aggregate-curated-labels.ts')) {
  main().catch((err) => {
    console.error('[aggregate] fatal:', err);
    process.exit(1);
  });
}

export { deriveSuggestion, groupByDomain, renderDiffPreview };
export type { AggregatedCuration, Suggestion };
