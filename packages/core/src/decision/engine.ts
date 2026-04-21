import type { AccessibilityProfile } from '../types/profile.js';
import { AdaptationType } from '../types/adaptation.js';
import type { Adaptation, AdaptationRule } from '../types/adaptation.js';
import { SignalType } from '../types/signals.js';
import type { StruggleScore, BehaviorSignal } from '../types/signals.js';
// --- Session 11: Intent-Driven Adaptations ---
import type { IntentHypothesis, IntentType } from '../fusion/types.js';

let adaptationIdCounter = 0;

function generateId(): string {
  adaptationIdCounter += 1;
  return `adapt-${Date.now()}-${adaptationIdCounter}`;
}

function averageNormalizedForType(
  signals: BehaviorSignal[],
  type: SignalType,
): number | null {
  const matching = signals.filter((s) => s.type === type);
  if (matching.length === 0) return null;
  return matching.reduce((sum, s) => sum + s.normalized, 0) / matching.length;
}

const BUILT_IN_RULES: AdaptationRule[] = [
  {
    condition: 'struggle > 60 && clickAccuracy < 0.3',
    adaptationType: AdaptationType.CLICK_TARGET_ENLARGE,
    value: 1.5,
    priority: 10,
    minConfidence: 0.5,
  },
  {
    condition: 'struggle > 40 && readingSpeed < 0.3',
    adaptationType: AdaptationType.FONT_SCALE,
    value: 1.25,
    priority: 8,
    minConfidence: 0.4,
  },
  {
    condition: 'struggle > 50 && readingSpeed < 0.3',
    adaptationType: AdaptationType.LINE_HEIGHT,
    value: 1.8,
    priority: 7,
    minConfidence: 0.4,
  },
  {
    condition: 'struggle > 70 && cursorPath > 0.7',
    adaptationType: AdaptationType.CURSOR_SIZE,
    value: 1.5,
    priority: 6,
    minConfidence: 0.5,
  },
  {
    condition: 'struggle > 50 && scrollVelocity > 0.7',
    adaptationType: AdaptationType.LAYOUT_SIMPLIFY,
    value: true,
    priority: 5,
    minConfidence: 0.5,
  },
  {
    condition: 'struggle > 60 && backspaceRate > 0.6',
    adaptationType: AdaptationType.TEXT_SIMPLIFY,
    value: 'mild',
    priority: 7,
    minConfidence: 0.5,
  },
  {
    condition: 'struggle > 55 && hesitation > 0.6',
    adaptationType: AdaptationType.FOCUS_MODE,
    value: true,
    priority: 6,
    minConfidence: 0.5,
  },
  {
    condition: 'struggle > 45 && zoomEvents > 0.5',
    adaptationType: AdaptationType.CONTRAST,
    value: 1.3,
    priority: 7,
    minConfidence: 0.4,
  },
  {
    condition: 'struggle > 65 && errorRate > 0.6',
    adaptationType: AdaptationType.READING_MODE,
    value: true,
    priority: 8,
    minConfidence: 0.5,
  },
  {
    condition: 'struggle > 70 && dwellTime > 0.7',
    adaptationType: AdaptationType.AUTO_SUMMARIZE,
    value: true,
    priority: 5,
    minConfidence: 0.6,
  },
  {
    condition: 'struggle > 50 && scrollVelocity > 0.6',
    adaptationType: AdaptationType.REDUCED_MOTION,
    value: true,
    priority: 4,
    minConfidence: 0.4,
  },
];

interface SignalAverages {
  clickAccuracy: number | null;
  readingSpeed: number | null;
  cursorPath: number | null;
  scrollVelocity: number | null;
  backspaceRate: number | null;
  hesitation: number | null;
  zoomEvents: number | null;
  errorRate: number | null;
  dwellTime: number | null;
  typingRhythm: number | null;
}

function computeSignalAverages(signals: BehaviorSignal[]): SignalAverages {
  return {
    clickAccuracy: averageNormalizedForType(signals, SignalType.CLICK_ACCURACY),
    readingSpeed: averageNormalizedForType(signals, SignalType.READING_SPEED),
    cursorPath: averageNormalizedForType(signals, SignalType.CURSOR_PATH),
    scrollVelocity: averageNormalizedForType(
      signals,
      SignalType.SCROLL_VELOCITY,
    ),
    backspaceRate: averageNormalizedForType(signals, SignalType.BACKSPACE_RATE),
    hesitation: averageNormalizedForType(signals, SignalType.HESITATION),
    zoomEvents: averageNormalizedForType(signals, SignalType.ZOOM_EVENTS),
    errorRate: averageNormalizedForType(signals, SignalType.ERROR_RATE),
    dwellTime: averageNormalizedForType(signals, SignalType.DWELL_TIME),
    typingRhythm: averageNormalizedForType(signals, SignalType.TYPING_RHYTHM),
  };
}

function evaluateCondition(
  rule: AdaptationRule,
  score: number,
  averages: SignalAverages,
): boolean {
  const condition = rule.condition;

  // Parse simple conditions like "struggle > 60 && clickAccuracy < 0.3"
  const parts = condition.split('&&').map((p) => p.trim());

  return parts.every((part) => {
    const match = part.match(/^(\w+)\s*(>|<|>=|<=|==)\s*([\d.]+)$/);
    if (!match) return false;

    const [, variable, operator, thresholdStr] = match;
    const threshold = parseFloat(thresholdStr);

    let value: number | null;
    if (variable === 'struggle') {
      value = score;
    } else {
      value = averages[variable as keyof SignalAverages] ?? null;
    }

    if (value === null) return false;

    switch (operator) {
      case '>':
        return value > threshold;
      case '<':
        return value < threshold;
      case '>=':
        return value >= threshold;
      case '<=':
        return value <= threshold;
      case '==':
        return Math.abs(value - threshold) < 0.001;
      default:
        return false;
    }
  });
}

export class DecisionEngine {
  private profile: AccessibilityProfile;
  private activeAdaptations: Map<string, Adaptation> = new Map();
  private rules: AdaptationRule[];

  constructor(
    profile: AccessibilityProfile,
    customRules?: AdaptationRule[],
  ) {
    this.profile = profile;
    this.rules = customRules
      ? [...BUILT_IN_RULES, ...customRules]
      : [...BUILT_IN_RULES];
    // Sort rules by priority descending so higher-priority rules are applied first
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  evaluate(struggleScore: StruggleScore): Adaptation[] {
    if (this.profile.adaptationMode === 'manual') {
      return [];
    }

    if (struggleScore.confidence < this.profile.confidenceThreshold) {
      return [];
    }

    return this.applyRules(struggleScore);
  }

  applyRules(score: StruggleScore): Adaptation[] {
    const averages = computeSignalAverages(score.signals);
    const newAdaptations: Adaptation[] = [];

    // Track which adaptation types are already active to avoid duplicates
    const activeTypes = new Set<AdaptationType>();
    for (const adaptation of this.activeAdaptations.values()) {
      if (adaptation.applied) {
        activeTypes.add(adaptation.type);
      }
    }

    for (const rule of this.rules) {
      if (activeTypes.has(rule.adaptationType)) {
        continue;
      }

      if (score.confidence < rule.minConfidence) {
        continue;
      }

      if (evaluateCondition(rule, score.score, averages)) {
        const adaptation: Adaptation = {
          id: generateId(),
          type: rule.adaptationType,
          value: rule.value,
          confidence: score.confidence,
          applied: true,
          timestamp: Date.now(),
          reversible: true,
        };

        this.activeAdaptations.set(adaptation.id, adaptation);
        activeTypes.add(adaptation.type);
        newAdaptations.push(adaptation);
      }
    }

    return newAdaptations;
  }

  getActiveAdaptations(): Adaptation[] {
    return Array.from(this.activeAdaptations.values()).filter((a) => a.applied);
  }

  revertAdaptation(id: string): void {
    const adaptation = this.activeAdaptations.get(id);
    if (adaptation && adaptation.reversible) {
      adaptation.applied = false;
    }
  }

  revertAll(): void {
    for (const adaptation of this.activeAdaptations.values()) {
      if (adaptation.reversible) {
        adaptation.applied = false;
      }
    }
  }

  updateProfile(profile: AccessibilityProfile): void {
    this.profile = profile;
  }

  // --- Session 11: Intent-Driven Adaptations ---
  /**
   * Map a Layer-5 intent hypothesis to zero or more Adaptation objects.
   * Separate from `evaluate()` (which consumes StruggleScore) — intent is a
   * higher-level inference fed by the fusion engine. Manual mode returns [].
   * Confidence gate: only fires when `hypothesis.confidence` ≥
   * `profile.fusionIntentMinConfidence` (fallback 0.65).
   */
  evaluateIntent(hypothesis: IntentHypothesis): Adaptation[] {
    if (this.profile.adaptationMode === 'manual') return [];
    const minConf = this.profile.fusionIntentMinConfidence ?? 0.65;
    if (hypothesis.confidence < minConf) return [];
    return buildIntentAdaptations(hypothesis, hypothesis.confidence);
  }
}

// --- Session 11: Intent-Driven Adaptations ---

const INTENT_ADAPTATION_MAP: Record<IntentType, Array<{ kind: string; value: unknown }>> = {
  'click-imminent': [{ kind: 'preview-tooltip', value: { subtle: true } }],
  'scroll-continuation': [{ kind: 'smooth-scroll-hint', value: true }],
  reading: [{ kind: 'reading-mode-offer', value: true }],
  hesitation: [
    { kind: 'confirmation-widget', value: true },
    { kind: 'inline-help', value: true },
  ],
  searching: [{ kind: 'find-in-page-helper', value: true }],
  typing: [{ kind: 'suppress-interruptions', value: true }],
  abandoning: [{ kind: 'auto-save-form-draft', value: true }],
  'help-seeking': [{ kind: 'contextual-help-panel', value: true }],
};

let intentAdaptationCounter = 0;

export function buildIntentAdaptations(
  hypothesis: IntentHypothesis,
  confidence: number,
): Adaptation[] {
  const specs = INTENT_ADAPTATION_MAP[hypothesis.intent] ?? [];
  const out: Adaptation[] = [];
  for (const spec of specs) {
    intentAdaptationCounter += 1;
    out.push({
      id: `intent-${hypothesis.intent}-${Date.now()}-${intentAdaptationCounter}`,
      type: AdaptationType.INTENT_HINT,
      value: { kind: spec.kind, intent: hypothesis.intent, detail: spec.value },
      confidence,
      applied: true,
      timestamp: Date.now(),
      reversible: true,
    });
  }
  return out;
}
