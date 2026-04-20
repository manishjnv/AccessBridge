/**
 * AccessBridge — Domain Connector Deepenings (v1)
 *
 * Priority 4: one advanced capability per connector. Pure, testable helpers
 * that each connector's scanAndEnhance() pipeline calls after its existing
 * v0 enhancements. No DOM mutation in this file — helpers return data or
 * decisions; the connector owns insertion.
 */

// ---------------------------------------------------------------------------
// Banking — IFSC → bank-name lookup
// ---------------------------------------------------------------------------

/**
 * First 4 letters of an IFSC code identify the bank. Covers the top ~30 Indian
 * banks; unknown codes return null and the caller should fall back to the
 * generic "IFSC Code" hint.
 */
const IFSC_BANK_MAP: Record<string, string> = {
  SBIN: 'State Bank of India',
  HDFC: 'HDFC Bank',
  ICIC: 'ICICI Bank',
  UTIB: 'Axis Bank',
  KKBK: 'Kotak Mahindra Bank',
  PUNB: 'Punjab National Bank',
  BARB: 'Bank of Baroda',
  BKID: 'Bank of India',
  CNRB: 'Canara Bank',
  UBIN: 'Union Bank of India',
  IBKL: 'IDBI Bank',
  YESB: 'Yes Bank',
  INDB: 'IndusInd Bank',
  FDRL: 'Federal Bank',
  RATN: 'RBL Bank',
  CITI: 'Citibank',
  SCBL: 'Standard Chartered',
  HSBC: 'HSBC',
  DBSS: 'DBS Bank',
  IDFB: 'IDFC First Bank',
  IOBA: 'Indian Overseas Bank',
  MAHB: 'Bank of Maharashtra',
  ANDB: 'Andhra Bank',
  ORBC: 'Oriental Bank of Commerce',
  CBIN: 'Central Bank of India',
  UCBA: 'UCO Bank',
  SYNB: 'Syndicate Bank',
  VIJB: 'Vijaya Bank',
  CIUB: 'City Union Bank',
  KARB: 'Karnataka Bank',
  SIBL: 'South Indian Bank',
  TMBL: 'Tamilnad Mercantile Bank',
};

const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function lookupIFSC(ifsc: string): { valid: boolean; bankName: string | null } {
  const normalized = (ifsc || '').trim().toUpperCase();
  if (!IFSC_PATTERN.test(normalized)) return { valid: false, bankName: null };
  const prefix = normalized.slice(0, 4);
  return { valid: true, bankName: IFSC_BANK_MAP[prefix] ?? null };
}

// ---------------------------------------------------------------------------
// Insurance — coverage gap analyzer
// ---------------------------------------------------------------------------

const COMMON_HEALTH_COVERAGES = [
  'hospitalisation',
  'hospitalization',
  'day care',
  'ambulance',
  'maternity',
  'newborn',
  'pre-existing',
  'mental health',
  'dental',
  'optical',
  'ayush',
  'cashless',
  'critical illness',
  'organ donor',
  'domiciliary',
];

export interface CoverageGapReport {
  covered: string[];
  missing: string[];
  ratio: number;
}

/**
 * Scan policy text for coverage keywords. Items in COMMON_HEALTH_COVERAGES
 * that are NOT mentioned are flagged as potential gaps. The caller shows this
 * as a non-alarming "worth checking" panel.
 */
export function analyzeCoverageGaps(policyText: string): CoverageGapReport {
  const lower = (policyText || '').toLowerCase();
  const covered: string[] = [];
  const missing: string[] = [];
  for (const coverage of COMMON_HEALTH_COVERAGES) {
    if (lower.includes(coverage)) covered.push(coverage);
    else missing.push(coverage);
  }
  const total = COMMON_HEALTH_COVERAGES.length;
  return {
    covered,
    missing,
    ratio: total === 0 ? 0 : covered.length / total,
  };
}

// ---------------------------------------------------------------------------
// Healthcare — drug interaction detector
// ---------------------------------------------------------------------------

const KNOWN_DRUG_INTERACTIONS: Array<{ drugs: [string, string]; warning: string }> = [
  {
    drugs: ['warfarin', 'aspirin'],
    warning: 'Increased bleeding risk — consult doctor before combining.',
  },
  {
    drugs: ['warfarin', 'ibuprofen'],
    warning: 'Increased bleeding risk. NSAID should be avoided with warfarin.',
  },
  {
    drugs: ['metformin', 'alcohol'],
    warning: 'Risk of lactic acidosis. Avoid heavy alcohol while on metformin.',
  },
  {
    drugs: ['lisinopril', 'potassium'],
    warning: 'Risk of hyperkalemia (high potassium). Monitor potassium levels.',
  },
  {
    drugs: ['simvastatin', 'clarithromycin'],
    warning: 'Increased statin toxicity — muscle damage possible.',
  },
  {
    drugs: ['ssri', 'maoi'],
    warning: 'Serious serotonin syndrome risk. Do not combine.',
  },
  {
    drugs: ['paracetamol', 'alcohol'],
    warning: 'Increased liver toxicity. Limit alcohol use.',
  },
  {
    drugs: ['ciprofloxacin', 'antacid'],
    warning: 'Antacids reduce absorption. Space doses at least 2 hours apart.',
  },
];

export interface DrugInteractionFinding {
  drugs: [string, string];
  warning: string;
}

export function detectDrugInteractions(text: string): DrugInteractionFinding[] {
  const lower = (text || '').toLowerCase();
  const findings: DrugInteractionFinding[] = [];
  for (const entry of KNOWN_DRUG_INTERACTIONS) {
    const [a, b] = entry.drugs;
    if (lower.includes(a) && lower.includes(b)) {
      findings.push({ drugs: entry.drugs, warning: entry.warning });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Telecom — bill-shock language detector
// ---------------------------------------------------------------------------

const BILL_SHOCK_PHRASES = [
  'overage',
  'additional charges',
  'extra charges',
  'exceeded limit',
  'fair usage',
  'beyond fup',
  'roaming charges',
  'premium rate',
  'international rate',
  'auto-renewal',
  'subscription fee',
];

export interface BillShockFinding {
  phrase: string;
  severity: 'warning' | 'danger';
}

/**
 * Returns the phrases from the page that commonly precede a surprise
 * charge. Severity escalates to 'danger' when multiple signals appear
 * or an explicit rupee amount is present near the phrase.
 */
export function detectBillShockLanguage(text: string): BillShockFinding[] {
  const lower = (text || '').toLowerCase();
  const findings: BillShockFinding[] = [];
  for (const phrase of BILL_SHOCK_PHRASES) {
    if (!lower.includes(phrase)) continue;
    // proximity of ₹ symbol to the phrase → danger
    const idx = lower.indexOf(phrase);
    const window = text.slice(Math.max(0, idx - 40), idx + phrase.length + 40);
    const severity: 'warning' | 'danger' = /₹\s?\d/.test(window) ? 'danger' : 'warning';
    findings.push({ phrase, severity });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Retail — savings percentage calculator
// ---------------------------------------------------------------------------

export interface SavingsBreakdown {
  /** Absolute savings in rupees. */
  amount: number;
  /** Percentage off the original price (0-100, rounded to 1dp). */
  percentOff: number;
  /** Short human-readable label, e.g. "Save ₹500 (20% off)". */
  label: string;
}

export function computeSavings(originalPrice: number, salePrice: number): SavingsBreakdown | null {
  if (
    !Number.isFinite(originalPrice) ||
    !Number.isFinite(salePrice) ||
    originalPrice <= 0 ||
    salePrice < 0 ||
    salePrice >= originalPrice
  ) {
    return null;
  }
  const amount = originalPrice - salePrice;
  const percentOff = Math.round((amount / originalPrice) * 1000) / 10;
  const formattedAmt = amount.toLocaleString('en-IN');
  return {
    amount,
    percentOff,
    label: `Save ₹${formattedAmt} (${percentOff}% off)`,
  };
}

// ---------------------------------------------------------------------------
// Manufacturing — safety hazard highlighter
// ---------------------------------------------------------------------------

const HAZARD_KEYWORDS: Array<{ keyword: string; level: 'warning' | 'danger' }> = [
  { keyword: 'explosive', level: 'danger' },
  { keyword: 'flammable', level: 'danger' },
  { keyword: 'toxic', level: 'danger' },
  { keyword: 'corrosive', level: 'danger' },
  { keyword: 'radioactive', level: 'danger' },
  { keyword: 'lockout', level: 'warning' },
  { keyword: 'tagout', level: 'warning' },
  { keyword: 'high voltage', level: 'danger' },
  { keyword: 'confined space', level: 'warning' },
  { keyword: 'ppe required', level: 'warning' },
  { keyword: 'wear safety', level: 'warning' },
  { keyword: 'hot surface', level: 'warning' },
  { keyword: 'do not operate', level: 'danger' },
  { keyword: 'hazardous', level: 'warning' },
  { keyword: 'caution', level: 'warning' },
];

export interface HazardFinding {
  keyword: string;
  level: 'warning' | 'danger';
}

export function detectHazardKeywords(text: string): HazardFinding[] {
  const lower = (text || '').toLowerCase();
  const found: HazardFinding[] = [];
  const seen = new Set<string>();
  for (const entry of HAZARD_KEYWORDS) {
    if (lower.includes(entry.keyword) && !seen.has(entry.keyword)) {
      found.push({ keyword: entry.keyword, level: entry.level });
      seen.add(entry.keyword);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Shared stylesheet for the injected deepening panels.
//
// We inject a <style> tag once on first activation rather than touching the
// bundled content/styles.css — that file is shared by every content-script
// feature and keeping domain CSS separate avoids chunk-order collisions
// during the vite IIFE wrap (RCA BUG-008).
// ---------------------------------------------------------------------------

const DEEPENING_STYLE_ID = 'ab-domain-deepenings-style';

const DEEPENING_CSS = `
  .ab-domain-ifsc-bank {
    margin-top: 4px; padding: 4px 8px; border-radius: 4px;
    background: rgba(123,104,238,0.12); color: #7b68ee;
    font-size: 12px; font-weight: 600;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .ab-domain-coverage-gap, .ab-domain-drug-interactions,
  .ab-domain-bill-shock, .ab-domain-hazard-banner {
    display: block; margin: 12px 0; padding: 12px 16px;
    border: 1px solid rgba(123,104,238,0.4);
    border-left: 4px solid #7b68ee;
    border-radius: 8px;
    background: rgba(26,26,46,0.05);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px; line-height: 1.5; color: inherit;
  }
  .ab-domain-drug-interactions, .ab-domain-hazard-banner-danger,
  .ab-domain-bill-shock-danger {
    border-color: rgba(239,68,68,0.45);
    border-left-color: #ef4444;
    background: rgba(239,68,68,0.06);
  }
  .ab-domain-coverage-gap-title, .ab-domain-drug-interactions-title,
  .ab-domain-bill-shock-title, .ab-domain-hazard-title {
    font-weight: 700; margin-bottom: 6px; color: #7b68ee;
  }
  .ab-domain-drug-interactions-title, .ab-domain-hazard-banner-danger .ab-domain-hazard-title,
  .ab-domain-bill-shock-danger .ab-domain-bill-shock-title {
    color: #ef4444;
  }
  .ab-domain-coverage-gap-list, .ab-domain-drug-interactions-list,
  .ab-domain-bill-shock-list, .ab-domain-hazard-list {
    margin: 4px 0 6px 18px; padding: 0;
  }
  .ab-domain-coverage-gap-list li, .ab-domain-drug-interactions-list li,
  .ab-domain-bill-shock-list li {
    margin: 2px 0;
  }
  .ab-domain-hazard-list {
    list-style: none; margin-left: 0; display: flex;
    flex-wrap: wrap; gap: 6px;
  }
  .ab-domain-hazard-list li {
    padding: 2px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.5px;
    background: rgba(245,158,11,0.16); color: #f59e0b;
  }
  .ab-domain-hazard-list li[data-level="danger"] {
    background: rgba(239,68,68,0.2); color: #ef4444;
  }
  .ab-domain-coverage-gap-hint, .ab-domain-drug-interactions-hint {
    font-size: 11px; opacity: 0.75; margin-top: 6px; font-style: italic;
  }
  .ab-domain-savings-badge {
    display: inline-block; margin-left: 8px; padding: 2px 8px;
    border-radius: 999px; background: #10b981; color: white;
    font-size: 11px; font-weight: 700; line-height: 1.4;
    vertical-align: middle;
    font-family: system-ui, -apple-system, sans-serif;
  }
`;

export function ensureDeepeningStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(DEEPENING_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = DEEPENING_STYLE_ID;
  style.textContent = DEEPENING_CSS;
  (document.head || document.documentElement).appendChild(style);
}
