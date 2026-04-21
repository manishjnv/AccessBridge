export type {
  WCAGLevel,
  AuditSeverity,
  WCAGPrinciple,
  BBox,
  ComputedStyleSummary,
  AuditNode,
  TableSummary,
  HeadingInfo,
  FrameInfo,
  AuditInput,
  AuditFinding,
  AuditFindingSource,
  AuditRule,
  AuditReport,
} from './types.js';

export { AuditEngine } from './engine.js';

export {
  AUDIT_RULES,
  parseRgb,
  relativeLuminance,
  contrastRatio,
  buildElementSelector,
  principleForCriterion,
} from './rules.js';

export type {
  AxeViolationNode,
  AxeViolation,
  AxeResults,
  MergeResult,
} from './axe-integration.js';

export {
  mapAxeViolationsToFindings,
  mergeAuditFindings,
  rebuildReportWithMergedFindings,
  extractWcagCriterion,
  extractWcagLevel,
  dedupKey,
} from './axe-integration.js';
