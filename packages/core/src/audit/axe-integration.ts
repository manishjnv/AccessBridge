import type {
  AuditFinding,
  AuditFindingSource,
  AuditReport,
  AuditSeverity,
  WCAGLevel,
} from './types.js';
import { principleForCriterion } from './rules.js';

// ---------------------------------------------------------------------------
// Minimal structural types for axe-core output — avoids a runtime dep on axe
// in @accessbridge/core. Any field we don't map stays as the rawAxe escape hatch.
// ---------------------------------------------------------------------------

export interface AxeViolationNode {
  target?: string[];
  html?: string;
  failureSummary?: string;
  impact?: string | null;
}

export interface AxeViolation {
  id: string;
  impact?: string | null;
  tags?: string[];
  description?: string;
  help?: string;
  helpUrl?: string;
  nodes?: AxeViolationNode[];
}

export interface AxeResults {
  violations?: AxeViolation[];
}

// ---------------------------------------------------------------------------
// axe → AccessBridge finding mapping
// ---------------------------------------------------------------------------

const SEVERITY_MAP: Record<string, AuditSeverity> = {
  critical: 'critical',
  serious: 'serious',
  moderate: 'moderate',
  minor: 'minor',
};

function mapAxeImpact(impact: string | null | undefined): AuditSeverity {
  if (!impact) return 'moderate';
  return SEVERITY_MAP[impact] ?? 'moderate';
}

/** Extract the first WCAG success-criterion tag from axe-core's tag list.
 *  axe encodes criteria as `wcag<principle><guideline><criterion>`:
 *    - `wcag111` → 1.1.1
 *    - `wcag143` → 1.4.3
 *    - `wcag1410` → 1.4.10   (2-digit criterion — common for WCAG 2.1 AA)
 *
 *  Principle and guideline are ALWAYS single digits (WCAG has 4 principles
 *  with ≤5 guidelines each), so only the criterion component can exceed one
 *  digit. A greedy `(\d+)(\d+)` backtracks to give "wcag1410" → "1.41.0",
 *  which silently misreports the criterion — hence the `(\d)(\d)(\d+)` shape.
 *
 *  Returns `'0.0.0'` if none matches — the caller should treat this as
 *  "uncategorized" rather than silently dropping the finding. */
export function extractWcagCriterion(tags: unknown): string {
  if (!Array.isArray(tags)) return '0.0.0';
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const m = tag.match(/^wcag(\d)(\d)(\d+)$/i);
    if (m) return `${m[1]}.${parseInt(m[2], 10)}.${parseInt(m[3], 10)}`;
  }
  return '0.0.0';
}

export function extractWcagLevel(tags: unknown): WCAGLevel {
  if (!Array.isArray(tags)) return 'A';
  if (tags.some((t) => typeof t === 'string' && /^wcag2?aaa$/i.test(t))) return 'AAA';
  if (tags.some((t) => typeof t === 'string' && /^wcag2?aa$/i.test(t))) return 'AA';
  return 'A';
}

/** Pure mapping from an axe-core results object to AccessBridge findings.
 *  Emits one finding per (violation, node) pair. Preserves the original node
 *  under `rawAxe` for power-user debugging + the Axe expansion panel. */
export function mapAxeViolationsToFindings(
  results: AxeResults | null | undefined,
): AuditFinding[] {
  if (!results || !Array.isArray(results.violations)) return [];
  const findings: AuditFinding[] = [];
  let seq = 0;
  for (const violation of results.violations) {
    const wcagCriterion = extractWcagCriterion(violation.tags);
    const level = extractWcagLevel(violation.tags);
    const wcagPrinciple = principleForCriterion(wcagCriterion);
    const nodesRaw = Array.isArray(violation.nodes) ? violation.nodes : [];
    const nodes = nodesRaw.length > 0 ? nodesRaw : [{}];
    for (const node of nodes) {
      const severity = mapAxeImpact(node.impact ?? violation.impact);
      const elementSelector = Array.isArray(node.target) && node.target.length > 0
        ? String(node.target[0])
        : '(unknown)';
      const message = violation.help || violation.description || 'axe-core violation';
      const suggestion = violation.helpUrl
        ? `See axe-core docs: ${violation.helpUrl}`
        : (node.failureSummary ?? '');
      findings.push({
        id: `axe-${violation.id}-${seq++}`,
        ruleId: `axe:${violation.id}`,
        rule: violation.id,
        wcagCriterion,
        wcagPrinciple,
        level,
        severity,
        nodeIndex: null,
        elementSelector,
        message,
        suggestion,
        htmlSnippet: (node.html ?? '').slice(0, 200),
        source: 'axe',
        rawAxe: node,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Merge / dedupe
// ---------------------------------------------------------------------------

/** Canonical dedup key: same criterion + same selector counts as the same bug.
 *  Normalizes selector whitespace + lowercases — selectors coming from axe vs.
 *  our own collector share the same DOM but may differ in formatting. */
export function dedupKey(finding: Pick<AuditFinding, 'wcagCriterion' | 'elementSelector'>): string {
  const selector = (finding.elementSelector ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${finding.wcagCriterion}::${selector}`;
}

export interface MergeResult {
  merged: AuditFinding[];
  overlaps: number;
  custom: number;
  axe: number;
  both: number;
}

/** Merge custom-engine findings with axe-core findings, deduplicating by
 *  (criterion, selector). When both sources fire on the same element, the
 *  custom finding wins (its message is domain-aware and aligned with our UI
 *  copy) but its `source` is upgraded to `'both'` and axe's raw node is
 *  preserved on the merged entry. Idempotent: calling twice with the same
 *  inputs yields a deterministic output. */
export function mergeAuditFindings(
  custom: AuditFinding[],
  axeFindings: AuditFinding[],
): MergeResult {
  const customByKey = new Map<string, AuditFinding>();
  for (const f of custom) {
    const key = dedupKey(f);
    if (!customByKey.has(key)) customByKey.set(key, { ...f, source: 'custom' });
  }

  const merged: AuditFinding[] = [];
  const seenAxeKeys = new Set<string>();
  let overlaps = 0;

  // Walk custom first (preserves their ordering + message text), upgrade to
  // 'both' if axe corroborates.
  for (const f of custom) {
    const key = dedupKey(f);
    const axeHit = axeFindings.find((a) => dedupKey(a) === key);
    if (axeHit) {
      merged.push({ ...f, source: 'both', rawAxe: axeHit.rawAxe });
      seenAxeKeys.add(key);
      overlaps++;
    } else {
      merged.push({ ...f, source: 'custom' });
    }
  }

  // Append axe-only findings the custom engine didn't catch.
  for (const a of axeFindings) {
    const key = dedupKey(a);
    if (customByKey.has(key)) continue;      // already handled above
    if (seenAxeKeys.has(key)) continue;      // duplicate within axe set
    merged.push({ ...a, source: 'axe' });
    seenAxeKeys.add(key);
  }

  const customOnly = merged.filter((f) => f.source === 'custom').length;
  const axeOnly = merged.filter((f) => f.source === 'axe').length;
  const both = merged.filter((f) => f.source === 'both').length;

  return { merged, overlaps, custom: customOnly, axe: axeOnly, both };
}

/** Rebuild an AuditReport from a merged finding list, preserving metadata from
 *  the original custom report. Used after axe results come back — the caller
 *  has already paid the cost of running both engines; this re-scores without
 *  re-walking rules. */
export function rebuildReportWithMergedFindings(
  original: AuditReport,
  merged: AuditFinding[],
  sources: { custom: number; axe: number; both: number },
): AuditReport {
  const WEIGHTS: Record<AuditSeverity, number> = {
    critical: 25,
    serious: 10,
    moderate: 5,
    minor: 2,
    info: 0,
  };

  let deduction = 0;
  for (const f of merged) deduction += WEIGHTS[f.severity];
  const overallScore = Math.max(0, Math.min(100, 100 - deduction));

  const principles = ['perceivable', 'operable', 'understandable', 'robust'] as const;
  const scoreByCategory = Object.fromEntries(
    principles.map((p) => {
      const d = merged
        .filter((f) => f.wcagPrinciple === p)
        .reduce((s, f) => s + WEIGHTS[f.severity], 0);
      return [p, Math.max(0, Math.min(100, 100 - d))];
    }),
  ) as AuditReport['scoreByCategory'];

  const summary = {
    critical: merged.filter((f) => f.severity === 'critical').length,
    serious: merged.filter((f) => f.severity === 'serious').length,
    moderate: merged.filter((f) => f.severity === 'moderate').length,
    minor: merged.filter((f) => f.severity === 'minor').length,
    info: merged.filter((f) => f.severity === 'info').length,
  };

  return {
    ...original,
    findings: merged,
    overallScore,
    scoreByCategory,
    summary,
    sources,
  };
}
