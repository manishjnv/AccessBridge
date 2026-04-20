import type {
  AuditInput,
  AuditReport,
  AuditFinding,
  WCAGPrinciple,
  WCAGLevel,
  AuditRule,
} from './types.js';
import { AUDIT_RULES } from './rules.js';

export class AuditEngine {
  private rules: AuditRule[];

  constructor(rules: AuditRule[] = AUDIT_RULES) {
    this.rules = rules;
  }

  runAudit(input: AuditInput): AuditReport {
    const start =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const findings: AuditFinding[] = [];
    for (const rule of this.rules) {
      try {
        findings.push(...rule.check(input));
      } catch {
        /* one broken rule must not tank the audit */
      }
    }
    const durationMs = Math.max(
      0,
      Math.round(
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
          start,
      ),
    );

    const WEIGHTS: Record<AuditFinding['severity'], number> = {
      critical: 25,
      serious: 10,
      moderate: 5,
      minor: 2,
      info: 0,
    };

    let deduction = 0;
    for (const f of findings) deduction += WEIGHTS[f.severity];
    const overallScore = Math.max(0, Math.min(100, 100 - deduction));

    const principles: WCAGPrinciple[] = [
      'perceivable',
      'operable',
      'understandable',
      'robust',
    ];
    const scoreByCategory = Object.fromEntries(
      principles.map((p) => {
        const d = findings
          .filter((f) => f.wcagPrinciple === p)
          .reduce((s, f) => s + WEIGHTS[f.severity], 0);
        return [p, Math.max(0, Math.min(100, 100 - d))];
      }),
    ) as Record<WCAGPrinciple, number>;

    const levels: WCAGLevel[] = ['A', 'AA', 'AAA'];
    const firedRuleIds = new Set(findings.map((f) => f.ruleId));
    const wcagCompliance = { A: 100, AA: 100, AAA: 100 } as Record<
      WCAGLevel,
      number
    >;
    for (const lvl of levels) {
      const applicable = this.rules.filter((r) => r.level === lvl);
      if (applicable.length === 0) {
        wcagCompliance[lvl] = 100;
        continue;
      }
      const passed = applicable.filter((r) => !firedRuleIds.has(r.id)).length;
      wcagCompliance[lvl] = Math.round((passed / applicable.length) * 100);
    }

    const summary = {
      critical: findings.filter((f) => f.severity === 'critical').length,
      serious: findings.filter((f) => f.severity === 'serious').length,
      moderate: findings.filter((f) => f.severity === 'moderate').length,
      minor: findings.filter((f) => f.severity === 'minor').length,
      info: findings.filter((f) => f.severity === 'info').length,
    };

    return {
      url: input.url,
      pageTitle: input.pageTitle,
      scannedAt: input.scannedAt,
      durationMs,
      totalElements: input.totalElements,
      findings,
      scoreByCategory,
      overallScore,
      wcagCompliance,
      summary,
    };
  }
}
