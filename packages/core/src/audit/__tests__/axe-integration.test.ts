import { describe, it, expect } from 'vitest';
import {
  mapAxeViolationsToFindings,
  mergeAuditFindings,
  rebuildReportWithMergedFindings,
  extractWcagCriterion,
  extractWcagLevel,
  dedupKey,
} from '../axe-integration.js';
import type { AuditFinding, AuditReport } from '../types.js';
import type { AxeResults } from '../axe-integration.js';

// ---------------------------------------------------------------------------
// extractWcagCriterion / extractWcagLevel
// ---------------------------------------------------------------------------

describe('extractWcagCriterion', () => {
  it('parses wcag111 as 1.1.1', () => {
    expect(extractWcagCriterion(['wcag111', 'cat.text-alternatives'])).toBe('1.1.1');
  });

  it('parses multi-digit criteria like wcag143 as 1.4.3', () => {
    expect(extractWcagCriterion(['wcag143'])).toBe('1.4.3');
  });

  it('BUG-guard — parses WCAG 2.1 2-digit criterion wcag1410 as 1.4.10 (not 1.41.0)', () => {
    // Regression guard: greedy `(\d+)(\d+)` in the initial impl mapped this
    // to "1.41.0" silently. Principle + guideline are always 1 digit each;
    // only the criterion component can be 2 digits.
    expect(extractWcagCriterion(['wcag1410'])).toBe('1.4.10');
    expect(extractWcagCriterion(['wcag1411'])).toBe('1.4.11');
    expect(extractWcagCriterion(['wcag1413'])).toBe('1.4.13');
    expect(extractWcagCriterion(['wcag255'])).toBe('2.5.5');
    expect(extractWcagCriterion(['wcag324'])).toBe('3.2.4');
  });

  it('returns 0.0.0 when no wcag tag present', () => {
    expect(extractWcagCriterion(['best-practice', 'cat.keyboard'])).toBe('0.0.0');
  });

  it('returns 0.0.0 when tags is undefined', () => {
    expect(extractWcagCriterion(undefined)).toBe('0.0.0');
  });

  it('returns 0.0.0 safely on non-array tags (proto-pollution / malformed input)', () => {
    expect(extractWcagCriterion({} as unknown)).toBe('0.0.0');
    expect(extractWcagCriterion('wcag111' as unknown)).toBe('0.0.0');
    expect(extractWcagCriterion(null)).toBe('0.0.0');
  });

  it('skips non-string tag entries without throwing', () => {
    expect(extractWcagCriterion([123, null, 'wcag111'] as unknown)).toBe('1.1.1');
  });
});

describe('extractWcagLevel', () => {
  it('detects AAA', () => {
    expect(extractWcagLevel(['wcag111', 'wcag2aaa'])).toBe('AAA');
  });

  it('detects AA', () => {
    expect(extractWcagLevel(['wcag111', 'wcag2aa'])).toBe('AA');
  });

  it('defaults to A when only the level-A tag is present', () => {
    expect(extractWcagLevel(['wcag111'])).toBe('A');
  });

  it('defaults to A when undefined', () => {
    expect(extractWcagLevel(undefined)).toBe('A');
  });

  it('defaults to A safely on non-array tags', () => {
    expect(extractWcagLevel({} as unknown)).toBe('A');
    expect(extractWcagLevel(null)).toBe('A');
  });
});

// ---------------------------------------------------------------------------
// mapAxeViolationsToFindings
// ---------------------------------------------------------------------------

describe('mapAxeViolationsToFindings', () => {
  it('emits one finding per (violation, node) pair', () => {
    const axe: AxeResults = {
      violations: [
        {
          id: 'image-alt',
          impact: 'critical',
          tags: ['wcag111', 'wcag2a'],
          help: 'Images must have alt text',
          helpUrl: 'https://axe.example/image-alt',
          nodes: [
            { target: ['img.hero'], html: '<img class="hero">' },
            { target: ['img#banner'], html: '<img id="banner">' },
          ],
        },
      ],
    };
    const findings = mapAxeViolationsToFindings(axe);
    expect(findings).toHaveLength(2);
    expect(findings[0].elementSelector).toBe('img.hero');
    expect(findings[1].elementSelector).toBe('img#banner');
    expect(findings[0].wcagCriterion).toBe('1.1.1');
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].source).toBe('axe');
  });

  it('falls back to violation.impact when node impact is missing', () => {
    const axe: AxeResults = {
      violations: [
        {
          id: 'color-contrast',
          impact: 'serious',
          tags: ['wcag143', 'wcag2aa'],
          nodes: [{ target: ['p'] }],
        },
      ],
    };
    const [finding] = mapAxeViolationsToFindings(axe);
    expect(finding.severity).toBe('serious');
    expect(finding.level).toBe('AA');
    expect(finding.wcagPrinciple).toBe('perceivable');
  });

  it('maps unknown/missing impact to "moderate"', () => {
    const axe: AxeResults = {
      violations: [
        { id: 'x', tags: ['wcag111'], nodes: [{ target: ['div'] }] },
      ],
    };
    const [finding] = mapAxeViolationsToFindings(axe);
    expect(finding.severity).toBe('moderate');
  });

  it('preserves the raw axe node under rawAxe', () => {
    const node = { target: ['span'], html: '<span>x</span>', failureSummary: 'bad' };
    const axe: AxeResults = {
      violations: [{ id: 'r', tags: ['wcag111'], nodes: [node] }],
    };
    const [finding] = mapAxeViolationsToFindings(axe);
    expect(finding.rawAxe).toEqual(node);
  });

  it('returns empty array for null / undefined / missing violations', () => {
    expect(mapAxeViolationsToFindings(null)).toEqual([]);
    expect(mapAxeViolationsToFindings(undefined)).toEqual([]);
    expect(mapAxeViolationsToFindings({})).toEqual([]);
    expect(mapAxeViolationsToFindings({ violations: [] })).toEqual([]);
  });

  it('handles violations with zero nodes by emitting a single global-selector finding', () => {
    const axe: AxeResults = {
      violations: [{ id: 'no-nodes', tags: ['wcag111'], nodes: [] }],
    };
    const findings = mapAxeViolationsToFindings(axe);
    expect(findings).toHaveLength(1);
    expect(findings[0].elementSelector).toBe('(unknown)');
  });
});

// ---------------------------------------------------------------------------
// dedupKey
// ---------------------------------------------------------------------------

describe('dedupKey', () => {
  it('is stable across selector whitespace/case drift', () => {
    const a = dedupKey({ wcagCriterion: '1.1.1', elementSelector: 'IMG.Hero' });
    const b = dedupKey({ wcagCriterion: '1.1.1', elementSelector: '  img.hero  ' });
    expect(a).toBe(b);
  });

  it('differentiates by criterion even for the same selector', () => {
    const a = dedupKey({ wcagCriterion: '1.1.1', elementSelector: 'img' });
    const b = dedupKey({ wcagCriterion: '1.4.3', elementSelector: 'img' });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// mergeAuditFindings
// ---------------------------------------------------------------------------

function mkFinding(partial: Partial<AuditFinding>): AuditFinding {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    ruleId: partial.ruleId ?? 'r',
    rule: partial.rule ?? 'rule',
    wcagCriterion: partial.wcagCriterion ?? '1.1.1',
    wcagPrinciple: partial.wcagPrinciple ?? 'perceivable',
    level: partial.level ?? 'A',
    severity: partial.severity ?? 'serious',
    nodeIndex: partial.nodeIndex ?? null,
    elementSelector: partial.elementSelector ?? 'img',
    message: partial.message ?? 'msg',
    suggestion: partial.suggestion ?? 'sug',
    htmlSnippet: partial.htmlSnippet ?? '<img>',
    source: partial.source,
    rawAxe: partial.rawAxe,
  };
}

describe('mergeAuditFindings', () => {
  it('upgrades custom finding to source:both when axe corroborates', () => {
    const custom = [mkFinding({ id: 'c1', wcagCriterion: '1.1.1', elementSelector: 'img.hero' })];
    const axe = [mkFinding({ id: 'a1', wcagCriterion: '1.1.1', elementSelector: 'img.hero', rawAxe: { t: 1 } })];
    const res = mergeAuditFindings(custom, axe);
    expect(res.merged).toHaveLength(1);
    expect(res.merged[0].source).toBe('both');
    expect(res.merged[0].id).toBe('c1');
    expect(res.merged[0].rawAxe).toEqual({ t: 1 });
    expect(res.overlaps).toBe(1);
    expect(res.both).toBe(1);
  });

  it('preserves custom-only findings', () => {
    const custom = [mkFinding({ id: 'c1', wcagCriterion: '1.1.1', elementSelector: 'img' })];
    const axe: AuditFinding[] = [];
    const res = mergeAuditFindings(custom, axe);
    expect(res.merged).toHaveLength(1);
    expect(res.merged[0].source).toBe('custom');
    expect(res.custom).toBe(1);
  });

  it('appends axe-only findings', () => {
    const custom: AuditFinding[] = [];
    const axe = [mkFinding({ id: 'a1', wcagCriterion: '1.4.3', elementSelector: 'p', source: 'axe' })];
    const res = mergeAuditFindings(custom, axe);
    expect(res.merged).toHaveLength(1);
    expect(res.merged[0].source).toBe('axe');
    expect(res.axe).toBe(1);
  });

  it('handles the mixed case correctly (1 overlap + 1 custom-only + 1 axe-only)', () => {
    const custom = [
      mkFinding({ id: 'c1', wcagCriterion: '1.1.1', elementSelector: 'img' }),
      mkFinding({ id: 'c2', wcagCriterion: '2.4.1', elementSelector: 'a.skip' }),
    ];
    const axe = [
      mkFinding({ id: 'a1', wcagCriterion: '1.1.1', elementSelector: 'img' }), // overlap
      mkFinding({ id: 'a2', wcagCriterion: '1.4.3', elementSelector: 'p.low-contrast' }), // axe-only
    ];
    const res = mergeAuditFindings(custom, axe);
    expect(res.merged).toHaveLength(3);
    expect(res.custom).toBe(1);
    expect(res.axe).toBe(1);
    expect(res.both).toBe(1);
    expect(res.overlaps).toBe(1);
  });

  it('is idempotent — calling twice with the same input yields the same merged output shape', () => {
    const custom = [mkFinding({ id: 'c1', wcagCriterion: '1.1.1', elementSelector: 'img' })];
    const axe = [mkFinding({ id: 'a1', wcagCriterion: '1.4.3', elementSelector: 'p' })];
    const first = mergeAuditFindings(custom, axe);
    const second = mergeAuditFindings(custom, axe);
    expect(second.merged.length).toBe(first.merged.length);
    expect(second.custom).toBe(first.custom);
    expect(second.axe).toBe(first.axe);
    expect(second.both).toBe(first.both);
  });

  it('does not double-count duplicate axe entries for the same selector+criterion', () => {
    const custom: AuditFinding[] = [];
    const axe = [
      mkFinding({ id: 'a1', wcagCriterion: '1.1.1', elementSelector: 'img' }),
      mkFinding({ id: 'a2', wcagCriterion: '1.1.1', elementSelector: 'img' }),
    ];
    const res = mergeAuditFindings(custom, axe);
    expect(res.merged).toHaveLength(1);
    expect(res.axe).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// rebuildReportWithMergedFindings
// ---------------------------------------------------------------------------

describe('rebuildReportWithMergedFindings', () => {
  const baseReport: AuditReport = {
    url: 'https://example.com',
    pageTitle: 'Test',
    scannedAt: 0,
    durationMs: 10,
    totalElements: 100,
    findings: [],
    scoreByCategory: { perceivable: 100, operable: 100, understandable: 100, robust: 100 },
    overallScore: 100,
    wcagCompliance: { A: 100, AA: 100, AAA: 100 },
    summary: { critical: 0, serious: 0, moderate: 0, minor: 0, info: 0 },
  };

  it('deducts 25 for a critical finding', () => {
    const merged = [mkFinding({ severity: 'critical', wcagPrinciple: 'perceivable' })];
    const rebuilt = rebuildReportWithMergedFindings(baseReport, merged, { custom: 1, axe: 0, both: 0 });
    expect(rebuilt.overallScore).toBe(75);
    expect(rebuilt.summary.critical).toBe(1);
    expect(rebuilt.scoreByCategory.perceivable).toBe(75);
    expect(rebuilt.scoreByCategory.operable).toBe(100);
  });

  it('preserves url/pageTitle/totalElements from original', () => {
    const merged: AuditFinding[] = [];
    const rebuilt = rebuildReportWithMergedFindings(baseReport, merged, { custom: 0, axe: 0, both: 0 });
    expect(rebuilt.url).toBe('https://example.com');
    expect(rebuilt.pageTitle).toBe('Test');
    expect(rebuilt.totalElements).toBe(100);
  });

  it('clamps score at 0 for many criticals', () => {
    const merged = Array.from({ length: 10 }, (_, i) =>
      mkFinding({ id: `c${i}`, severity: 'critical' }),
    );
    const rebuilt = rebuildReportWithMergedFindings(baseReport, merged, { custom: 10, axe: 0, both: 0 });
    expect(rebuilt.overallScore).toBe(0);
  });

  it('attaches the sources object to the rebuilt report', () => {
    const rebuilt = rebuildReportWithMergedFindings(baseReport, [], { custom: 3, axe: 5, both: 2 });
    expect(rebuilt.sources).toEqual({ custom: 3, axe: 5, both: 2 });
  });
});
