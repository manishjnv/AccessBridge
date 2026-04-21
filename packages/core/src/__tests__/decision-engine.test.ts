import { describe, it, expect, beforeEach } from 'vitest';
import { DecisionEngine } from '../decision/engine.js';
import { AdaptationType } from '../types/adaptation.js';
import { SignalType } from '../types/signals.js';
import type { AccessibilityProfile } from '../types/profile.js';
import type { StruggleScore, BehaviorSignal } from '../types/signals.js';
import type { AdaptationRule } from '../types/adaptation.js';
import {
  DEFAULT_SENSORY_PROFILE,
  DEFAULT_COGNITIVE_PROFILE,
  DEFAULT_MOTOR_PROFILE,
} from '../types/profile.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(
  overrides: Partial<AccessibilityProfile> = {},
): AccessibilityProfile {
  return {
    id: 'test',
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sensory: { ...DEFAULT_SENSORY_PROFILE },
    cognitive: { ...DEFAULT_COGNITIVE_PROFILE },
    motor: { ...DEFAULT_MOTOR_PROFILE },
    language: 'en',
    autoDetectLanguage: false,
    transliterationEnabled: false,
    transliterationScript: 'devanagari',
    adaptationMode: 'auto',
    confidenceThreshold: 0.0, // accept all confidence levels by default in tests
    shareAnonymousMetrics: false,
    environmentSensingEnabled: false,
    environmentLightSampling: true,
    environmentNoiseSampling: true,
    // --- Session 11: Multi-Modal Fusion ---
    fusionEnabled: true,
    fusionWindowMs: 3000,
    fusionCompensationEnabled: true,
    fusionIntentMinConfidence: 0.65,
    ...overrides,
  };
}

function makeSignal(type: SignalType, normalized: number): BehaviorSignal {
  return { type, value: normalized, normalized, timestamp: Date.now() };
}

function makeScore(
  score: number,
  confidence: number,
  signals: BehaviorSignal[] = [],
): StruggleScore {
  return { score, confidence, signals, timestamp: Date.now() };
}

// A minimal custom rule that fires when struggle > 10 only
const LOW_THRESHOLD_RULE: AdaptationRule = {
  condition: 'struggle > 10',
  adaptationType: AdaptationType.REDUCED_MOTION,
  value: true,
  priority: 1,
  minConfidence: 0.0,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DecisionEngine', () => {
  let engine: DecisionEngine;

  beforeEach(() => {
    engine = new DecisionEngine(makeProfile());
  });

  // -------------------------------------------------------------------------
  // evaluate() — mode / confidence gates
  // -------------------------------------------------------------------------

  describe('evaluate() mode and confidence gates', () => {
    it('returns empty array when adaptationMode is "manual"', () => {
      const e = new DecisionEngine(makeProfile({ adaptationMode: 'manual' }));
      const score = makeScore(90, 1.0, [
        makeSignal(SignalType.CLICK_ACCURACY, 0.1),
      ]);
      expect(e.evaluate(score)).toEqual([]);
    });

    it('returns empty array when confidence is below profile threshold', () => {
      const e = new DecisionEngine(
        makeProfile({ confidenceThreshold: 0.8, adaptationMode: 'auto' }),
        [LOW_THRESHOLD_RULE],
      );
      const score = makeScore(90, 0.5);
      expect(e.evaluate(score)).toEqual([]);
    });

    it('applies rules when confidence meets the threshold', () => {
      const e = new DecisionEngine(
        makeProfile({ confidenceThreshold: 0.5, adaptationMode: 'auto' }),
        [LOW_THRESHOLD_RULE],
      );
      const score = makeScore(50, 0.6);
      expect(e.evaluate(score).length).toBeGreaterThan(0);
    });

    it('applies rules in "suggest" mode (treated same as auto by applyRules path)', () => {
      const e = new DecisionEngine(
        makeProfile({ adaptationMode: 'suggest', confidenceThreshold: 0.0 }),
        [LOW_THRESHOLD_RULE],
      );
      const score = makeScore(50, 1.0);
      // evaluate() only short-circuits on 'manual'; suggest falls through
      expect(e.evaluate(score).length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // applyRules() — rule evaluation
  // -------------------------------------------------------------------------

  describe('applyRules()', () => {
    it('returns adaptations when rule conditions are satisfied', () => {
      const e = new DecisionEngine(makeProfile(), [LOW_THRESHOLD_RULE]);
      const score = makeScore(50, 1.0);
      const adaptations = e.applyRules(score);
      expect(adaptations.length).toBeGreaterThan(0);
    });

    it('does not return adaptations when rule conditions are not met', () => {
      const e = new DecisionEngine(makeProfile(), [LOW_THRESHOLD_RULE]);
      const score = makeScore(5, 1.0); // struggle <= 10
      const adaptations = e.applyRules(score);
      expect(adaptations).toEqual([]);
    });

    it('does not duplicate adaptation types already active', () => {
      const e = new DecisionEngine(makeProfile(), [LOW_THRESHOLD_RULE]);
      const score = makeScore(50, 1.0);
      e.applyRules(score); // first call activates REDUCED_MOTION
      const second = e.applyRules(score); // second call must not re-add it
      const reducedMotionCount = second.filter(
        (a) => a.type === AdaptationType.REDUCED_MOTION,
      ).length;
      expect(reducedMotionCount).toBe(0);
    });

    it('skips rules whose minConfidence is not met', () => {
      const strictRule: AdaptationRule = {
        condition: 'struggle > 10',
        adaptationType: AdaptationType.FOCUS_MODE,
        value: true,
        priority: 1,
        minConfidence: 0.9,
      };
      const e = new DecisionEngine(makeProfile(), [strictRule]);
      const score = makeScore(50, 0.5); // confidence below minConfidence
      expect(e.applyRules(score)).toEqual([]);
    });

    it('each returned adaptation has the expected shape', () => {
      const e = new DecisionEngine(makeProfile(), [LOW_THRESHOLD_RULE]);
      const score = makeScore(50, 0.8);
      const [adaptation] = e.applyRules(score);
      expect(adaptation).toMatchObject({
        type: AdaptationType.REDUCED_MOTION,
        value: true,
        applied: true,
        reversible: true,
        confidence: 0.8,
      });
      expect(typeof adaptation.id).toBe('string');
      expect(adaptation.id.startsWith('adapt-')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // High vs low struggle scores
  // -------------------------------------------------------------------------

  describe('high vs low struggle scores', () => {
    it('high score triggers CLICK_TARGET_ENLARGE when clickAccuracy is low', () => {
      const signals = [
        makeSignal(SignalType.CLICK_ACCURACY, 0.1), // < 0.3 threshold
      ];
      const score = makeScore(75, 0.9, signals); // > 60
      const adaptations = engine.applyRules(score);
      const types = adaptations.map((a) => a.type);
      expect(types).toContain(AdaptationType.CLICK_TARGET_ENLARGE);
    });

    it('low score does not trigger CLICK_TARGET_ENLARGE', () => {
      const signals = [makeSignal(SignalType.CLICK_ACCURACY, 0.1)];
      const score = makeScore(20, 0.9, signals); // struggle <= 60
      const adaptations = engine.applyRules(score);
      const types = adaptations.map((a) => a.type);
      expect(types).not.toContain(AdaptationType.CLICK_TARGET_ENLARGE);
    });

    it('high score triggers FONT_SCALE when readingSpeed is low', () => {
      const signals = [makeSignal(SignalType.READING_SPEED, 0.1)]; // < 0.3
      const score = makeScore(65, 0.9, signals); // > 40
      const adaptations = engine.applyRules(score);
      const types = adaptations.map((a) => a.type);
      expect(types).toContain(AdaptationType.FONT_SCALE);
    });

    it('low score does not fire any built-in rules', () => {
      const score = makeScore(5, 1.0, []);
      const adaptations = engine.applyRules(score);
      expect(adaptations).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getActiveAdaptations()
  // -------------------------------------------------------------------------

  describe('getActiveAdaptations()', () => {
    it('returns empty array when no rules have fired yet', () => {
      expect(engine.getActiveAdaptations()).toEqual([]);
    });

    it('returns applied adaptations after applyRules', () => {
      const e = new DecisionEngine(makeProfile(), [LOW_THRESHOLD_RULE]);
      e.applyRules(makeScore(50, 1.0));
      expect(e.getActiveAdaptations().length).toBeGreaterThan(0);
    });

    it('only returns adaptations where applied === true', () => {
      const e = new DecisionEngine(makeProfile(), [LOW_THRESHOLD_RULE]);
      const [adaptation] = e.applyRules(makeScore(50, 1.0));
      e.revertAdaptation(adaptation.id);
      expect(e.getActiveAdaptations()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // revertAdaptation()
  // -------------------------------------------------------------------------

  describe('revertAdaptation()', () => {
    it('marks the specified adaptation as not applied', () => {
      const e = new DecisionEngine(makeProfile(), [LOW_THRESHOLD_RULE]);
      const [adaptation] = e.applyRules(makeScore(50, 1.0));
      e.revertAdaptation(adaptation.id);
      expect(e.getActiveAdaptations()).toEqual([]);
    });

    it('does nothing for an unknown id', () => {
      const e = new DecisionEngine(makeProfile(), [LOW_THRESHOLD_RULE]);
      e.applyRules(makeScore(50, 1.0));
      const beforeCount = e.getActiveAdaptations().length;
      e.revertAdaptation('nonexistent-id');
      expect(e.getActiveAdaptations().length).toBe(beforeCount);
    });

    it('allows the same adaptation type to be re-applied after revert', () => {
      const e = new DecisionEngine(makeProfile(), [LOW_THRESHOLD_RULE]);
      const [adaptation] = e.applyRules(makeScore(50, 1.0));
      e.revertAdaptation(adaptation.id);
      // After revert, the same type is no longer in activeTypes, so it can fire again
      const second = e.applyRules(makeScore(50, 1.0));
      expect(second.some((a) => a.type === AdaptationType.REDUCED_MOTION)).toBe(
        true,
      );
    });
  });

  // -------------------------------------------------------------------------
  // revertAll()
  // -------------------------------------------------------------------------

  describe('revertAll()', () => {
    it('marks all active adaptations as not applied', () => {
      const rule1: AdaptationRule = {
        condition: 'struggle > 10',
        adaptationType: AdaptationType.FOCUS_MODE,
        value: true,
        priority: 2,
        minConfidence: 0.0,
      };
      const rule2: AdaptationRule = {
        condition: 'struggle > 10',
        adaptationType: AdaptationType.REDUCED_MOTION,
        value: true,
        priority: 1,
        minConfidence: 0.0,
      };
      const e = new DecisionEngine(makeProfile(), [rule1, rule2]);
      e.applyRules(makeScore(50, 1.0));
      expect(e.getActiveAdaptations().length).toBeGreaterThanOrEqual(2);

      e.revertAll();
      expect(e.getActiveAdaptations()).toEqual([]);
    });

    it('is a no-op when there are no active adaptations', () => {
      expect(() => engine.revertAll()).not.toThrow();
      expect(engine.getActiveAdaptations()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // updateProfile()
  // -------------------------------------------------------------------------

  describe('updateProfile()', () => {
    it('switching to "manual" mode prevents further adaptations', () => {
      const e = new DecisionEngine(makeProfile(), [LOW_THRESHOLD_RULE]);
      // First evaluate works
      expect(e.evaluate(makeScore(50, 1.0)).length).toBeGreaterThan(0);
      e.revertAll();

      // Now switch to manual
      e.updateProfile(makeProfile({ adaptationMode: 'manual' }));
      expect(e.evaluate(makeScore(50, 1.0))).toEqual([]);
    });

    it('raising confidenceThreshold blocks rules that were previously firing', () => {
      const e = new DecisionEngine(
        makeProfile({ confidenceThreshold: 0.0 }),
        [LOW_THRESHOLD_RULE],
      );
      expect(e.evaluate(makeScore(50, 0.3)).length).toBeGreaterThan(0);

      e.updateProfile(
        makeProfile({ confidenceThreshold: 0.9, adaptationMode: 'auto' }),
      );
      e.revertAll();
      expect(e.evaluate(makeScore(50, 0.3))).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Custom rules merged with built-in rules
  // -------------------------------------------------------------------------

  describe('custom rules', () => {
    it('custom rules are merged with built-in rules', () => {
      const customRule: AdaptationRule = {
        condition: 'struggle > 5',
        adaptationType: AdaptationType.LANGUAGE_SWITCH,
        value: 'simple',
        priority: 99,
        minConfidence: 0.0,
      };
      const e = new DecisionEngine(makeProfile(), [customRule]);
      const adaptations = e.applyRules(makeScore(10, 1.0));
      const types = adaptations.map((a) => a.type);
      expect(types).toContain(AdaptationType.LANGUAGE_SWITCH);
    });
  });
});
