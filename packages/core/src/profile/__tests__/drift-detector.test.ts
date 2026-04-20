import { describe, it, expect } from 'vitest';
import { detectDrift, DEFAULT_METRICS } from '../drift-detector.js';
import type { ProfileVersion } from '../versioning.js';
import { DEFAULT_PROFILE } from '../../types/profile.js';

function makeVersion(
  savedAt: number,
  overrides: {
    sensory?: Partial<typeof DEFAULT_PROFILE.sensory>;
    motor?: Partial<typeof DEFAULT_PROFILE.motor>;
    confidenceThreshold?: number;
  },
): ProfileVersion {
  const profile = structuredClone(DEFAULT_PROFILE);
  if (overrides.sensory) Object.assign(profile.sensory, overrides.sensory);
  if (overrides.motor) Object.assign(profile.motor, overrides.motor);
  if (typeof overrides.confidenceThreshold === 'number') {
    profile.confidenceThreshold = overrides.confidenceThreshold;
  }
  return {
    id: String(savedAt),
    savedAt,
    source: 'manual',
    profile,
  };
}

const NOW = Date.now();
const day = 24 * 60 * 60 * 1000;

describe('detectDrift', () => {
  it('returns empty findings when fewer than 3 versions', () => {
    const vs = [makeVersion(NOW - 5 * day, { sensory: { fontScale: 1.0 } })];
    const report = detectDrift(vs, { now: NOW });
    expect(report.findings).toEqual([]);
    expect(report.versionsInWindow).toBe(1);
  });

  it('flags an upward monotonic font-scale trend', () => {
    const vs = [
      makeVersion(NOW - 10 * day, { sensory: { fontScale: 1.0 } }),
      makeVersion(NOW - 7 * day, { sensory: { fontScale: 1.1 } }),
      makeVersion(NOW - 5 * day, { sensory: { fontScale: 1.2 } }),
      makeVersion(NOW - 2 * day, { sensory: { fontScale: 1.3 } }),
    ];
    const report = detectDrift(vs, { now: NOW });
    const fs = report.findings.find((f) => f.path === 'sensory.fontScale');
    expect(fs).toBeDefined();
    expect(fs?.direction).toBe('up');
    expect(fs?.delta).toBeCloseTo(0.3, 2);
    expect(fs?.sampleCount).toBe(4);
    expect(fs?.recommendation).toMatch(/creep/i);
  });

  it('does not flag if delta is below threshold', () => {
    const vs = [
      makeVersion(NOW - 10 * day, { sensory: { fontScale: 1.0 } }),
      makeVersion(NOW - 7 * day, { sensory: { fontScale: 1.02 } }),
      makeVersion(NOW - 5 * day, { sensory: { fontScale: 1.04 } }),
      makeVersion(NOW - 2 * day, { sensory: { fontScale: 1.05 } }),
    ];
    const report = detectDrift(vs, { now: NOW });
    expect(report.findings.find((f) => f.path === 'sensory.fontScale')).toBeUndefined();
  });

  it('does not flag non-monotonic changes', () => {
    const vs = [
      makeVersion(NOW - 10 * day, { sensory: { fontScale: 1.0 } }),
      makeVersion(NOW - 7 * day, { sensory: { fontScale: 1.3 } }),
      makeVersion(NOW - 5 * day, { sensory: { fontScale: 1.0 } }),
      makeVersion(NOW - 2 * day, { sensory: { fontScale: 1.3 } }),
    ];
    const report = detectDrift(vs, { now: NOW });
    expect(report.findings.find((f) => f.path === 'sensory.fontScale')).toBeUndefined();
  });

  it('flags a downward dwell-click-delay trend with correct message', () => {
    const vs = [
      makeVersion(NOW - 10 * day, { motor: { dwellClickDelay: 1500 } }),
      makeVersion(NOW - 7 * day, { motor: { dwellClickDelay: 1300 } }),
      makeVersion(NOW - 5 * day, { motor: { dwellClickDelay: 1100 } }),
      makeVersion(NOW - 2 * day, { motor: { dwellClickDelay: 1000 } }),
    ];
    const report = detectDrift(vs, { now: NOW });
    const dd = report.findings.find((f) => f.path === 'motor.dwellClickDelay');
    expect(dd?.direction).toBe('down');
    expect(dd?.recommendation).toMatch(/voice/i);
  });

  it('ignores versions outside the window', () => {
    const vs = [
      makeVersion(NOW - 40 * day, { sensory: { fontScale: 1.0 } }),
      makeVersion(NOW - 35 * day, { sensory: { fontScale: 1.5 } }),
      makeVersion(NOW - 2 * day, { sensory: { fontScale: 1.0 } }),
    ];
    const report = detectDrift(vs, { now: NOW });
    expect(report.versionsInWindow).toBe(1);
    expect(report.findings).toEqual([]);
  });

  it('accepts a custom window', () => {
    const vs = [
      makeVersion(NOW - 3 * day, { sensory: { fontScale: 1.0 } }),
      makeVersion(NOW - 2 * day, { sensory: { fontScale: 1.1 } }),
      makeVersion(NOW - 1 * day, { sensory: { fontScale: 1.3 } }),
    ];
    const report = detectDrift(vs, { now: NOW, windowMs: 5 * day });
    expect(report.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('exports metric configs with non-empty recommendations', () => {
    for (const m of DEFAULT_METRICS) {
      expect(m.upTrendMessage.length).toBeGreaterThan(10);
      expect(m.downTrendMessage.length).toBeGreaterThan(10);
      expect(m.threshold).toBeGreaterThan(0);
    }
  });
});
