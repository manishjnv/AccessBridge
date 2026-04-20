# Decision Engine

**Status:** Implemented  
**Package:** `@accessbridge/core`  
**Source:** `packages/core/src/decision/engine.ts`

## Overview

The Decision Engine is the brain of AccessBridge. It takes a struggle score from the Struggle Detector and determines which accessibility adaptations to apply. It uses a rule-based approach with confidence gating, priority ordering, and full reversibility guarantees.

## How Adaptations Are Chosen

```
StruggleScore ──> Confidence Check ──> Rule Evaluation ──> Deduplication ──> Adaptation[]
```

1. **Mode check:** If the user's profile is set to `manual` mode, the engine returns no adaptations (the user controls everything).
2. **Confidence gate:** If the struggle score's confidence is below the user's `confidenceThreshold` (default: 0.6), no adaptations are produced.
3. **Rule evaluation:** Each rule is tested against the struggle score and individual signal averages. Rules are evaluated in priority order (highest first).
4. **Deduplication:** If an adaptation of the same type is already active, the rule is skipped. This prevents stacking (e.g., applying font scaling twice).
5. **Output:** Matching rules produce `Adaptation` objects that are dispatched to the appropriate adapter.

## Rule-Based + ML Hybrid Approach

The current implementation is purely rule-based, designed for deterministic, explainable behavior. Each rule is a human-readable condition string that maps specific signal patterns to specific adaptations.

The architecture is designed to support a future ML layer:
- Rules handle the common, well-understood cases with guaranteed behavior
- An ML model (planned) would handle ambiguous situations where multiple signals weakly suggest different adaptations
- The ML layer would propose adaptations with its own confidence score, and the rule engine would arbitrate conflicts

For the ideathon, the rule-based approach provides full coverage of the target scenarios with zero training data required.

## Built-In Rules (11 Rules)

| # | Condition | Adaptation | Value | Priority | Min Confidence |
|---|-----------|-----------|-------|----------|----------------|
| 1 | `struggle > 60 && clickAccuracy < 0.3` | Click Target Enlarge | 1.5x | 10 | 0.5 |
| 2 | `struggle > 40 && readingSpeed < 0.3` | Font Scale | 1.25x | 8 | 0.4 |
| 3 | `struggle > 65 && errorRate > 0.6` | Reading Mode | on | 8 | 0.5 |
| 4 | `struggle > 50 && readingSpeed < 0.3` | Line Height | 1.8 | 7 | 0.4 |
| 5 | `struggle > 45 && zoomEvents > 0.5` | Contrast | 1.3x | 7 | 0.4 |
| 6 | `struggle > 60 && backspaceRate > 0.6` | Text Simplify | mild | 7 | 0.5 |
| 7 | `struggle > 70 && cursorPath > 0.7` | Cursor Size | 1.5x | 6 | 0.5 |
| 8 | `struggle > 55 && hesitation > 0.6` | Focus Mode | on | 6 | 0.5 |
| 9 | `struggle > 50 && scrollVelocity > 0.7` | Layout Simplify | on | 5 | 0.5 |
| 10 | `struggle > 70 && dwellTime > 0.7` | Auto Summarize | on | 5 | 0.6 |
| 11 | `struggle > 50 && scrollVelocity > 0.6` | Reduced Motion | on | 4 | 0.4 |

### Rule Priority

Rules are sorted by priority descending. Higher-priority rules are evaluated first and their adaptation types are claimed, preventing lower-priority rules from overriding them. For example, Click Target Enlarge (priority 10) will always be applied before Layout Simplify (priority 5) if both conditions match.

### Condition Syntax

Conditions use a simple expression format: `variable operator threshold`, joined by `&&`. Supported operators are `>`, `<`, `>=`, `<=`, `==`.

Variables available:
- `struggle` -- the overall struggle score (0-100)
- `clickAccuracy`, `readingSpeed`, `cursorPath`, `scrollVelocity`, `backspaceRate`, `hesitation`, `zoomEvents`, `errorRate`, `dwellTime`, `typingRhythm` -- normalized signal averages (0-1)

## Confidence Threshold and Auto-Apply vs Suggest

The user's profile has two relevant settings:

- **`adaptationMode`**: `auto` | `suggest` | `manual`
  - `auto`: Adaptations are applied immediately when rules match
  - `suggest`: Adaptations are proposed to the user via the popup/sidepanel UI; the user confirms or dismisses
  - `manual`: The Decision Engine is disabled; users adjust settings themselves
- **`confidenceThreshold`**: A number from 0 to 1 (default: 0.6). The engine will not produce any adaptations if the struggle score's confidence is below this value. Individual rules also have their own `minConfidence` -- both thresholds must be met.

This two-level confidence gating prevents the system from making changes based on insufficient data. A newly installed extension with few signals will naturally have low confidence, so it will observe quietly until it accumulates enough data to act reliably.

## Reversibility Guarantees

Every adaptation produced by the Decision Engine has `reversible: true`. This is a core design principle:

- **Individual revert:** `engine.revertAdaptation(id)` marks a specific adaptation as no longer applied.
- **Revert all:** `engine.revertAll()` reverts every active adaptation in one call.
- **No permanent changes:** The engine never modifies the underlying page structure. All adaptations operate through CSS classes, custom properties, and SVG filters that can be cleanly removed.
- **User override:** If a user manually adjusts a setting in the popup, their choice takes precedence. The engine will not re-apply an adaptation the user has dismissed (tracked via the active adaptations deduplication set).

## Custom Rules

The `DecisionEngine` constructor accepts an optional `customRules` array:

```typescript
const engine = new DecisionEngine(profile, [
  {
    condition: 'struggle > 30 && readingSpeed < 0.4',
    adaptationType: AdaptationType.FONT_SCALE,
    value: 1.15,
    priority: 9,
    minConfidence: 0.3,
  },
]);
```

Custom rules are merged with the 11 built-in rules and sorted by priority. This allows site-specific or user-specific rule customization without modifying core logic.

## API Reference

```typescript
class DecisionEngine {
  constructor(profile: AccessibilityProfile, customRules?: AdaptationRule[]);

  // Evaluate struggle score and return new adaptations to apply
  evaluate(struggleScore: StruggleScore): Adaptation[];

  // Get all currently active (applied) adaptations
  getActiveAdaptations(): Adaptation[];

  // Revert a single adaptation by ID
  revertAdaptation(id: string): void;

  // Revert all active adaptations
  revertAll(): void;

  // Update the user profile (e.g., when settings change)
  updateProfile(profile: AccessibilityProfile): void;
}
```
