/**
 * Priority 4 — Domain deepening helpers
 *
 * These tests only exercise the pure helpers. DOM side-effects in each
 * connector's new method are covered indirectly by the existing connector
 * smoke tests; here we lock down the detector contracts.
 */

import { describe, it, expect } from 'vitest';
import {
  lookupIFSC,
  analyzeCoverageGaps,
  detectDrugInteractions,
  detectBillShockLanguage,
  computeSavings,
  detectHazardKeywords,
} from '../deepenings.js';

// ---------------------------------------------------------------------------
// Banking — lookupIFSC
// ---------------------------------------------------------------------------

describe('lookupIFSC', () => {
  it('identifies SBI via SBIN prefix', () => {
    expect(lookupIFSC('SBIN0001234')).toEqual({
      valid: true,
      bankName: 'State Bank of India',
    });
  });

  it('identifies HDFC', () => {
    expect(lookupIFSC('HDFC0000042').bankName).toBe('HDFC Bank');
  });

  it('identifies Axis (UTIB)', () => {
    expect(lookupIFSC('UTIB0000123').bankName).toBe('Axis Bank');
  });

  it('accepts lowercase and trims whitespace', () => {
    expect(lookupIFSC('  icic0000999 ').bankName).toBe('ICICI Bank');
  });

  it('rejects malformed IFSC', () => {
    expect(lookupIFSC('123INVALID').valid).toBe(false);
    expect(lookupIFSC('SBIN12345').valid).toBe(false);
    expect(lookupIFSC('').valid).toBe(false);
  });

  it('returns valid=true, bankName=null for unknown-but-formatted IFSC', () => {
    const result = lookupIFSC('ZZZZ0000001');
    expect(result.valid).toBe(true);
    expect(result.bankName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Insurance — analyzeCoverageGaps
// ---------------------------------------------------------------------------

describe('analyzeCoverageGaps', () => {
  it('finds coverages that are explicitly mentioned', () => {
    const text =
      'This policy covers hospitalisation, day care, maternity benefits, and ambulance costs. Dental and optical are excluded.';
    const report = analyzeCoverageGaps(text);
    expect(report.covered).toContain('hospitalisation');
    expect(report.covered).toContain('maternity');
    expect(report.covered).toContain('ambulance');
    expect(report.covered).toContain('dental'); // keyword is present even though excluded
    expect(report.ratio).toBeGreaterThan(0);
    expect(report.ratio).toBeLessThanOrEqual(1);
  });

  it('marks unmentioned items as missing', () => {
    const text = 'This policy covers hospitalisation.';
    const report = analyzeCoverageGaps(text);
    expect(report.missing).toContain('maternity');
    expect(report.missing).toContain('mental health');
    expect(report.missing.length).toBeGreaterThan(report.covered.length);
  });

  it('treats empty input as all-missing', () => {
    const report = analyzeCoverageGaps('');
    expect(report.covered).toHaveLength(0);
    expect(report.missing.length).toBeGreaterThan(0);
    expect(report.ratio).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Healthcare — detectDrugInteractions
// ---------------------------------------------------------------------------

describe('detectDrugInteractions', () => {
  it('flags warfarin + aspirin', () => {
    const findings = detectDrugInteractions(
      'Patient is prescribed warfarin 5mg daily and aspirin 75mg.',
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].drugs).toEqual(['warfarin', 'aspirin']);
    expect(findings[0].warning).toMatch(/bleeding/i);
  });

  it('returns empty when only one drug is mentioned', () => {
    expect(detectDrugInteractions('Prescribed warfarin 5mg')).toEqual([]);
  });

  it('returns empty for unrelated text', () => {
    expect(detectDrugInteractions('Take the dog for a walk.')).toEqual([]);
  });

  it('is case-insensitive', () => {
    const findings = detectDrugInteractions('METFORMIN and some ALCOHOL');
    expect(findings.length).toBe(1);
    expect(findings[0].drugs).toEqual(['metformin', 'alcohol']);
  });
});

// ---------------------------------------------------------------------------
// Telecom — detectBillShockLanguage
// ---------------------------------------------------------------------------

describe('detectBillShockLanguage', () => {
  it('flags common extra-charge phrases as warning', () => {
    const findings = detectBillShockLanguage('Additional charges may apply for roaming.');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.phrase === 'additional charges')).toBe(true);
    expect(findings[0].severity).toBe('warning');
  });

  it('escalates to danger when ₹ amount is nearby', () => {
    const findings = detectBillShockLanguage('Overage: ₹199 per GB after FUP.');
    const overage = findings.find((f) => f.phrase === 'overage');
    expect(overage?.severity).toBe('danger');
  });

  it('returns empty when no shock language present', () => {
    expect(detectBillShockLanguage('All calls are free within our network.')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Retail — computeSavings
// ---------------------------------------------------------------------------

describe('computeSavings', () => {
  it('computes amount + percent off', () => {
    expect(computeSavings(1000, 800)).toEqual({
      amount: 200,
      percentOff: 20,
      label: 'Save ₹200 (20% off)',
    });
  });

  it('handles fractional percentages', () => {
    const result = computeSavings(300, 250);
    expect(result?.percentOff).toBeCloseTo(16.7, 1);
  });

  it('returns null when sale >= original', () => {
    expect(computeSavings(100, 100)).toBeNull();
    expect(computeSavings(100, 150)).toBeNull();
  });

  it('returns null for invalid inputs', () => {
    expect(computeSavings(0, 0)).toBeNull();
    expect(computeSavings(-10, 5)).toBeNull();
    expect(computeSavings(NaN, 10)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Manufacturing — detectHazardKeywords
// ---------------------------------------------------------------------------

describe('detectHazardKeywords', () => {
  it('flags danger-level keywords', () => {
    const findings = detectHazardKeywords('WARNING: flammable materials in area.');
    expect(findings.some((f) => f.keyword === 'flammable' && f.level === 'danger')).toBe(true);
  });

  it('flags warning-level keywords', () => {
    const findings = detectHazardKeywords('Use lockout/tagout procedure before service.');
    expect(findings.some((f) => f.keyword === 'lockout' && f.level === 'warning')).toBe(true);
    expect(findings.some((f) => f.keyword === 'tagout' && f.level === 'warning')).toBe(true);
  });

  it('dedupes repeated keywords', () => {
    const findings = detectHazardKeywords('toxic toxic toxic material');
    const count = findings.filter((f) => f.keyword === 'toxic').length;
    expect(count).toBe(1);
  });

  it('returns empty for safe text', () => {
    expect(detectHazardKeywords('The conveyor runs at constant speed.')).toEqual([]);
  });
});
