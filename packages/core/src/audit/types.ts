export type WCAGLevel = 'A' | 'AA' | 'AAA';
export type AuditSeverity = 'critical' | 'serious' | 'moderate' | 'minor' | 'info';
export type WCAGPrinciple = 'perceivable' | 'operable' | 'understandable' | 'robust';

export interface BBox { x: number; y: number; w: number; h: number }

export interface ComputedStyleSummary {
  color: string;
  backgroundColor: string;
  fontSize: number;
  fontWeight: number;
  display: string;
  visibility: string;
  opacity: number;
  outlineStyle: string;
  outlineWidth: string;
}

export interface AuditNode {
  index: number;
  tag: string;
  id: string | null;
  classes: string[];
  role: string | null;
  ariaLabel: string | null;
  ariaLabelledBy: string | null;
  ariaDescribedBy: string | null;
  ariaHidden: boolean;
  ariaLive: string | null;
  alt: string | null;
  src: string | null;
  href: string | null;
  title: string | null;
  type: string | null;
  name: string | null;
  value: string | null;
  placeholder: string | null;
  text: string;
  tabIndex: number | null;
  autoplay: boolean;
  muted: boolean;
  controls: boolean;
  lang: string | null;
  hasLabelElement: boolean;
  hasFieldsetLabel: boolean;
  parentTag: string | null;
  bbox: BBox;
  style: ComputedStyleSummary;
  htmlSnippet: string;
}

export interface TableSummary {
  nodeIndex: number;
  hasHeaders: boolean;
  hasCaption: boolean;
  rowCount: number;
  colCount: number;
}

export interface HeadingInfo {
  nodeIndex: number;
  level: number;
  text: string;
}

export interface FrameInfo {
  nodeIndex: number;
  title: string | null;
  src: string | null;
}

export interface AuditInput {
  url: string;
  pageTitle: string;
  documentLang: string | null;
  scannedAt: number;
  viewport: { w: number; h: number };
  elements: AuditNode[];
  headings: HeadingInfo[];
  landmarks: number[];
  tables: TableSummary[];
  frames: FrameInfo[];
  forms: number[];
  skipLinks: number[];
  duplicateIds: string[];
  focusOrder: number[];
  autoplayMedia: number[];
  animatedElements: number[];
  totalElements: number;
}

export interface AuditFinding {
  id: string;
  ruleId: string;
  rule: string;
  wcagCriterion: string;
  wcagPrinciple: WCAGPrinciple;
  level: WCAGLevel;
  severity: AuditSeverity;
  nodeIndex: number | null;
  elementSelector: string;
  message: string;
  suggestion: string;
  htmlSnippet: string;
}

export interface AuditRule {
  id: string;
  name: string;
  wcagCriterion: string;
  wcagPrinciple: WCAGPrinciple;
  level: WCAGLevel;
  severity: AuditSeverity;
  check(input: AuditInput): AuditFinding[];
}

export interface AuditReport {
  url: string;
  pageTitle: string;
  scannedAt: number;
  durationMs: number;
  totalElements: number;
  findings: AuditFinding[];
  scoreByCategory: Record<WCAGPrinciple, number>;
  overallScore: number;
  wcagCompliance: { A: number; AA: number; AAA: number };
  summary: {
    critical: number; serious: number; moderate: number; minor: number; info: number;
  };
}
