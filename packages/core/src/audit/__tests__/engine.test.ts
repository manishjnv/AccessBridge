import { describe, it, expect } from 'vitest';
import { AuditEngine } from '../engine.js';
import { AUDIT_RULES } from '../rules.js';
import type { AuditInput, AuditNode, AuditRule, AuditFinding, WCAGPrinciple, WCAGLevel, AuditSeverity } from '../types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeInput(partial: Partial<AuditInput> = {}): AuditInput {
  return {
    url: 'https://example.com',
    pageTitle: 'Test',
    documentLang: 'en',
    scannedAt: 1700000000000,
    viewport: { w: 1280, h: 800 },
    elements: [],
    headings: [],
    landmarks: [],
    tables: [],
    frames: [],
    forms: [],
    skipLinks: [],
    duplicateIds: [],
    focusOrder: [],
    autoplayMedia: [],
    animatedElements: [],
    totalElements: 0,
    ...partial,
  };
}

function makeNode(partial: Partial<AuditNode> = {}): AuditNode {
  return {
    index: 0,
    tag: 'div',
    id: null,
    classes: [],
    role: null,
    ariaLabel: null,
    ariaLabelledBy: null,
    ariaDescribedBy: null,
    ariaHidden: false,
    ariaLive: null,
    alt: null,
    src: null,
    href: null,
    title: null,
    type: null,
    name: null,
    value: null,
    placeholder: null,
    text: '',
    tabIndex: null,
    autoplay: false,
    muted: false,
    controls: false,
    lang: null,
    hasLabelElement: false,
    hasFieldsetLabel: false,
    parentTag: null,
    bbox: { x: 0, y: 0, w: 100, h: 50 },
    style: {
      color: 'rgb(0, 0, 0)',
      backgroundColor: 'rgb(255, 255, 255)',
      fontSize: 16,
      fontWeight: 400,
      display: 'block',
      visibility: 'visible',
      opacity: 1,
      outlineStyle: 'none',
      outlineWidth: '0px',
    },
    htmlSnippet: '<div></div>',
    ...partial,
  };
}

/** Build a stub rule that always fires N findings of a given severity. */
function stubRule(
  id: string,
  severity: AuditSeverity,
  count = 1,
  principle: WCAGPrinciple = 'perceivable',
  level: WCAGLevel = 'A',
): AuditRule {
  return {
    id,
    name: `Stub rule ${id}`,
    wcagCriterion: '1.1.1',
    wcagPrinciple: principle,
    level,
    severity,
    check(_input: AuditInput): AuditFinding[] {
      return Array.from({ length: count }, (_, i) => ({
        id: `${id}-global-${i}`,
        ruleId: id,
        rule: `Stub rule ${id}`,
        wcagCriterion: '1.1.1',
        wcagPrinciple: principle,
        level,
        severity,
        nodeIndex: null,
        elementSelector: 'document',
        message: 'Stub finding',
        suggestion: 'Stub suggestion',
        htmlSnippet: '',
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditEngine', () => {
  // 1. Empty input returns overallScore 100
  it('empty input returns overallScore 100', () => {
    const engine = new AuditEngine(AUDIT_RULES);
    const report = engine.runAudit(makeInput());
    expect(report.overallScore).toBe(100);
  });

  // 2. Critical finding deducts 25 from overallScore
  it('one critical finding deducts 25 from overallScore', () => {
    const engine = new AuditEngine([stubRule('critical-stub', 'critical')]);
    const report = engine.runAudit(makeInput());
    expect(report.overallScore).toBe(75);
  });

  // 3. Info-only findings keep overallScore at 100
  it('info-only findings keep overallScore at 100', () => {
    const engine = new AuditEngine([stubRule('info-stub', 'info', 5)]);
    const report = engine.runAudit(makeInput());
    expect(report.overallScore).toBe(100);
  });

  // 4. scoreByCategory sums per principle
  it('scoreByCategory reflects deductions per principle', () => {
    const rules = [
      stubRule('p1', 'critical', 1, 'perceivable', 'A'),
      stubRule('p2', 'serious', 1, 'operable', 'A'),
    ];
    const engine = new AuditEngine(rules);
    const report = engine.runAudit(makeInput());
    // perceivable: 100 - 25 = 75, operable: 100 - 10 = 90
    expect(report.scoreByCategory.perceivable).toBe(75);
    expect(report.scoreByCategory.operable).toBe(90);
    // unaffected principles stay at 100
    expect(report.scoreByCategory.understandable).toBe(100);
    expect(report.scoreByCategory.robust).toBe(100);
  });

  // 5. wcagCompliance reports A/AA/AAA as percentages
  it('wcagCompliance reports correct percentages', () => {
    // Use a subset: 1 A rule that fires, 1 A rule that doesn't
    const rules = [
      stubRule('a-fail', 'critical', 1, 'perceivable', 'A'),
      { ...stubRule('a-pass', 'critical', 0, 'perceivable', 'A'), check: () => [] },
    ];
    const engine = new AuditEngine(rules);
    const report = engine.runAudit(makeInput());
    // 1 of 2 A rules fired → 1/2 passed = 50%
    expect(report.wcagCompliance.A).toBe(50);
    // No AA or AAA rules → 100%
    expect(report.wcagCompliance.AA).toBe(100);
    expect(report.wcagCompliance.AAA).toBe(100);
  });

  // 6. Custom empty rules array → all scores 100
  it('empty rules array produces all-100 report', () => {
    const engine = new AuditEngine([]);
    const report = engine.runAudit(makeInput());
    expect(report.overallScore).toBe(100);
    expect(report.wcagCompliance.A).toBe(100);
    expect(report.wcagCompliance.AA).toBe(100);
    expect(report.wcagCompliance.AAA).toBe(100);
    expect(report.findings.length).toBe(0);
  });

  // 7. Same input → same findings count (determinism)
  it('same input produces same findings count on repeated calls', () => {
    const engine = new AuditEngine(AUDIT_RULES);
    const input = makeInput({
      elements: [makeNode({ tag: 'img', alt: null, index: 0 })],
      documentLang: null,
      duplicateIds: ['nav'],
    });
    const r1 = engine.runAudit(input);
    const r2 = engine.runAudit(input);
    expect(r1.findings.length).toBe(r2.findings.length);
  });

  // 8. summary counts match findings
  it('summary counts match findings array', () => {
    const rules = [
      stubRule('c1', 'critical', 2, 'perceivable', 'A'),
      stubRule('s1', 'serious', 3, 'operable', 'A'),
      stubRule('m1', 'moderate', 1, 'understandable', 'A'),
    ];
    const engine = new AuditEngine(rules);
    const report = engine.runAudit(makeInput());
    expect(report.summary.critical).toBe(2);
    expect(report.summary.serious).toBe(3);
    expect(report.summary.moderate).toBe(1);
    expect(report.summary.minor).toBe(0);
    expect(report.summary.info).toBe(0);
    expect(report.findings.length).toBe(6);
  });

  // 9. Score clamped to 0 when many criticals
  it('overallScore is clamped to 0 with many criticals', () => {
    const rules = Array.from({ length: 10 }, (_, i) =>
      stubRule(`c${i}`, 'critical', 1, 'perceivable', 'A'),
    );
    const engine = new AuditEngine(rules);
    const report = engine.runAudit(makeInput());
    // 10 × 25 = 250 deduction → clamped to 0
    expect(report.overallScore).toBe(0);
  });

  // 10. durationMs is a non-negative number
  it('durationMs is a non-negative number', () => {
    const engine = new AuditEngine(AUDIT_RULES);
    const report = engine.runAudit(makeInput());
    expect(typeof report.durationMs).toBe('number');
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});
