# Gesture Shortcuts (Task C — Module C Motor Assistor)

Recognize mouse, touch, and trackpad gestures; dispatch bound actions with a
visible hint. Designed to complement the existing voice-navigation and
keyboard-only motor modes, not replace them.

## Why gestures

Voice fails in silent/noisy rooms. Keyboard fails when one hand is unavailable
(pen, phone, coffee, RSI). Gestures are the "third hand" — they work without
speaking, without two-handed typing, and without training the user on a
command vocabulary. A single swipe beats four keypresses for back-navigation;
a pinch-out is faster than Ctrl+= for zoom-in.

## Gesture library (defaults)

| Gesture | Visual | Default action | Category |
|---------|--------|----------------|----------|
| Swipe left | → | Back | navigation |
| Swipe right | ← | Forward | navigation |
| Swipe up | ↑ | Scroll to top | navigation |
| Swipe down | ↓ | Scroll to bottom | navigation |
| Circle CW | ↻ | Increase font size | accessibility |
| Circle CCW | ↺ | Decrease font size | accessibility |
| Two-finger tap | ∵ | Read selection aloud | ai |
| Three-finger tap | ∴ | Toggle focus mode | accessibility |
| Double-tap | •• | Click | custom |
| Triple-tap | ••• | Triple-click (select paragraph) | custom |
| Long-press | ⬤ | Right-click | custom |
| Pinch in | →← | Zoom out | custom |
| Pinch out | ←→ | Zoom in | custom |
| Two-finger swipe left | ⇐ | Previous tab | navigation |
| Two-finger swipe right | ⇒ | Next tab | navigation |
| Zigzag | ⤸ | Cancel / Escape | custom |

## How to customize

1. Open the extension popup.
2. Switch to the **Motor** tab.
3. Toggle **Enable gesture shortcuts**.
4. Click **View Gesture Library** to see all bindings.
5. (Programmatic, for now) Call `GestureBindingStore.setBinding(gesture, actionId)`
   from DevTools on any page — bindings persist in `localStorage` under
   `accessbridge.gesture.bindings`. A full rebind UI ships in a later pass; the
   defaults cover the common cases.
6. Use `GestureBindingStore.resetToDefaults()` to wipe custom bindings.

## Input support

| Input | How it works | Notes |
|-------|--------------|-------|
| Touchscreen | `pointerdown` / `pointermove` / `pointerup` events | Multi-touch strokes grouped by `pointerId` |
| Trackpad 2-finger | `wheel` with `ctrlKey` (pinch) or horizontal delta accumulator (swipe) | Chrome exposes pinch-zoom as `wheel + ctrlKey`; two-finger scroll is plain `wheel` — we discriminate via delta direction and magnitude |
| Mouse | Shift+drag (configurable) | Shift gate is ON by default to prevent accidental activation during normal clicks and drags |
| Pen | Same as touch (pointer events) | Pressure data recorded; not yet used for gesture differentiation |

## Accessibility benefits

- **Reduced motor effort** — one stroke replaces many keypresses.
- **One-handed operation** — swipes work with thumb only.
- **RSI recovery** — rotates load off fingers onto the whole arm.
- **Assistive-device friendly** — works with head-pointers, foot mice, sip-and-puff
  (any device that emits pointer events).
- **No hardware needed** — works with any stock trackpad, touchscreen, or mouse.

## When gestures win vs voice / keyboard

| Situation | Best input |
|-----------|------------|
| Silent office | Gestures, keyboard |
| Coffee in one hand | Gestures (swipe), voice |
| Noisy open-plan | Gestures, keyboard |
| Screen reader user | Keyboard (gestures are visual-first) |
| Touch-only tablet | Gestures, voice |
| RSI, sore wrists | Gestures (whole-arm motion), voice |
| Privacy-sensitive | Gestures, keyboard (voice audible) |

Gestures are a complement, not a replacement: every gesture action is also
reachable via keyboard or voice.

## Technical details

### Recognition pipeline

1. **Capture** — `pointerdown/move/up`, `wheel`, `keydown` on `document`. Each
   `pointerId` accumulates points in a per-stroke buffer.
2. **Finalize** — on all-up or 500 ms of idle (no new points from any pointer),
   package strokes into a `GestureStroke[]` and pass to `recognize()`.
3. **Dispatch** — `recognize()` runs specific-first checks (pinch → 2-finger
   swipe → multi-finger tap → long-press → tap-count → circle → zigzag → swipe).
   Each branch returns `{ type, confidence, stroke }`; confidence ≥ 0.7 proceeds
   to dispatch.
4. **Bind** — `GestureBindingStore.getBinding(type)` resolves to an `actionId`;
   the controller maps that id to concrete action (history.back, scrollTo,
   `chrome.runtime.sendMessage`, etc.).
5. **Feedback** — a `.a11y-gesture-indicator` pill slides in at bottom-right for
   1.5 s showing the gesture + action.

### Thresholds

| Parameter | Default | Why |
|-----------|---------|-----|
| `minSwipeDistance` | 50 px | Below this a "swipe" is indistinguishable from a sloppy click |
| Swipe axis-dominance ratio | 1.8× | Diagonal strokes should not register as swipes |
| Circle arc | ≥ 270° | A partial arc is often an accidental stroke on a curved path |
| Tap travel | ≤ 15 px | Above this the stroke is a micro-drag, not a tap |
| Tap duration | ≤ 200 ms | Longer holds are long-press candidates |
| Long-press duration | ≥ 600 ms (configurable) | Balances feel vs accidental activation |
| Long-press travel | ≤ 10 px | Any drift and it's a drag |
| Pinch delta | ≥ 20 px | Sub-pixel wobble during a static two-finger hold is not a pinch |
| Zigzag reversals | ≥ 3 | Two reversals happen in any scribble; 3+ is intentional |
| Idle timeout | 500 ms | Time to accumulate multi-tap sequences without swallowing slow two-finger taps |
| Dispatch confidence | ≥ 0.7 | Cuts false positives on noisy strokes |

### False-positive mitigation

- Mouse mode requires Shift by default.
- Swipes need a minimum distance AND an axis-dominance ratio — slow drags
  don't register.
- Tap detection discriminates from long-press by duration (≤ 200 ms).
- Circle detection integrates signed angle around a centroid — short arcs fail.
- The `wheel` path only triggers on `ctrlKey` (pinch) or strong horizontal
  flow — normal vertical scroll passes through untouched.
- Focus-in-input (`<input>`, `<textarea>`, `[contenteditable]`) suppresses the
  `?` help-overlay shortcut.

### Files

| File | Role |
|------|------|
| `packages/core/src/gestures/types.ts` | Public types + default bindings |
| `packages/core/src/gestures/recognizer.ts` | Pure recognition functions |
| `packages/core/src/gestures/actions.ts` | Action registry + `getActionById` |
| `packages/core/src/gestures/bindings.ts` | `GestureBindingStore` with localStorage persistence |
| `packages/extension/src/content/motor/gestures.ts` | `GestureController` class — DOM wiring + dispatch |
| `packages/extension/src/content/motor/gesture-hints.ts` | `GestureHintOverlay` — indicator pill + help overlay |
| `packages/extension/src/popup/components/GestureLibrary.tsx` | Popup modal: visual cheat sheet |
| `packages/extension/src/content/styles.css` | `.a11y-gesture-*` styles |

### Tests

- `packages/core/src/gestures/__tests__/recognizer.test.ts` — 27+ unit tests.
- `packages/core/src/gestures/__tests__/bindings.test.ts` — 6 unit tests with
  in-memory localStorage mock.
- `packages/extension/src/content/motor/__tests__/gestures.test.ts` — 6 unit
  tests with stubbed `document` and `chrome.runtime`.
