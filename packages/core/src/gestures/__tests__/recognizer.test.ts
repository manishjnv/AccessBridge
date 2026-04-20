import { describe, it, expect } from 'vitest';
import {
  detectSwipeDirection,
  detectCircle,
  detectZigzag,
  detectTapCount,
  detectLongPress,
  detectPinch,
  detectTwoFingerSwipe,
  recognize,
} from '../recognizer.js';
import type { GestureStroke, PointerEvent2D } from '../types.js';

function makePoint(x: number, y: number, t: number, id = 0): PointerEvent2D {
  return { x, y, t, pointerId: id };
}

function makeStroke(
  points: PointerEvent2D[],
  fingerCount = 1,
): GestureStroke {
  const duration =
    points.length > 0 ? points[points.length - 1].t - points[0].t : 0;
  return { points, durationMs: duration, fingerCount };
}

function linearStroke(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  steps = 10,
  startT = 0,
  stepMs = 20,
  pointerId = 0,
): GestureStroke {
  const pts: PointerEvent2D[] = [];
  for (let i = 0; i <= steps; i++) {
    const r = i / steps;
    pts.push(makePoint(x1 + (x2 - x1) * r, y1 + (y2 - y1) * r, startT + i * stepMs, pointerId));
  }
  return makeStroke(pts);
}

function circleStroke(
  cx: number,
  cy: number,
  r: number,
  clockwiseOnScreen: boolean,
  points = 24,
  noise = 0,
): GestureStroke {
  const pts: PointerEvent2D[] = [];
  const sign = clockwiseOnScreen ? -1 : 1;
  for (let i = 0; i <= points; i++) {
    const theta = sign * (i / points) * 2 * Math.PI;
    const nx = noise ? (Math.random() - 0.5) * noise : 0;
    const ny = noise ? (Math.random() - 0.5) * noise : 0;
    pts.push(makePoint(cx + r * Math.cos(theta) + nx, cy + r * Math.sin(theta) + ny, i * 15));
  }
  return makeStroke(pts);
}

describe('detectSwipeDirection', () => {
  it('detects a left swipe', () => {
    expect(detectSwipeDirection(linearStroke(300, 100, 100, 100))).toBe('left');
  });
  it('detects a right swipe', () => {
    expect(detectSwipeDirection(linearStroke(100, 100, 300, 100))).toBe('right');
  });
  it('detects an up swipe', () => {
    expect(detectSwipeDirection(linearStroke(100, 300, 100, 100))).toBe('up');
  });
  it('detects a down swipe', () => {
    expect(detectSwipeDirection(linearStroke(100, 100, 100, 300))).toBe('down');
  });
  it('returns null for too-short strokes', () => {
    expect(detectSwipeDirection(linearStroke(100, 100, 120, 100))).toBeNull();
  });
  it('returns null for diagonal strokes without axis dominance', () => {
    expect(detectSwipeDirection(linearStroke(100, 100, 200, 200))).toBeNull();
  });
});

describe('detectCircle', () => {
  it('detects a clockwise loop on screen', () => {
    expect(detectCircle(circleStroke(200, 200, 80, true))).toBe('cw');
  });
  it('detects a counter-clockwise loop on screen', () => {
    expect(detectCircle(circleStroke(200, 200, 80, false))).toBe('ccw');
  });
  it('returns null for a partial 180-degree arc', () => {
    const pts: PointerEvent2D[] = [];
    for (let i = 0; i <= 12; i++) {
      const theta = (i / 12) * Math.PI;
      pts.push(makePoint(200 + 80 * Math.cos(theta), 200 + 80 * Math.sin(theta), i * 15));
    }
    expect(detectCircle(makeStroke(pts))).toBeNull();
  });
  it('tolerates small noise on a full loop', () => {
    const result = detectCircle(circleStroke(200, 200, 80, true, 36, 3));
    expect(result === 'cw' || result === 'ccw').toBe(true);
  });
});

describe('detectZigzag', () => {
  it('returns true when there are at least three direction reversals', () => {
    const pts: PointerEvent2D[] = [
      makePoint(100, 100, 0),
      makePoint(140, 100, 20),
      makePoint(110, 100, 40),
      makePoint(150, 100, 60),
      makePoint(120, 100, 80),
      makePoint(160, 100, 100),
    ];
    expect(detectZigzag(makeStroke(pts))).toBe(true);
  });
  it('returns false for only one reversal', () => {
    const pts: PointerEvent2D[] = [
      makePoint(100, 100, 0),
      makePoint(140, 100, 20),
      makePoint(100, 100, 40),
    ];
    expect(detectZigzag(makeStroke(pts))).toBe(false);
  });
  it('returns false for a smooth curve', () => {
    expect(detectZigzag(circleStroke(200, 200, 80, true, 24, 0))).toBe(false);
  });
});

describe('detectTapCount', () => {
  it('returns 1 for a single short stroke', () => {
    const tap = makeStroke([makePoint(100, 100, 0), makePoint(102, 101, 50)]);
    expect(detectTapCount([tap], 300)).toBe(1);
  });
  it('counts a double tap within the gap', () => {
    const t1 = makeStroke([makePoint(100, 100, 0), makePoint(102, 101, 60)]);
    const t2 = makeStroke([makePoint(101, 100, 200), makePoint(103, 102, 250)]);
    expect(detectTapCount([t1, t2], 300)).toBe(2);
  });
  it('counts a triple tap within the gap', () => {
    const t1 = makeStroke([makePoint(100, 100, 0), makePoint(102, 101, 60)]);
    const t2 = makeStroke([makePoint(101, 100, 200), makePoint(103, 102, 250)]);
    const t3 = makeStroke([makePoint(100, 101, 400), makePoint(102, 102, 440)]);
    expect(detectTapCount([t1, t2, t3], 300)).toBe(3);
  });
  it('stops counting when the gap is exceeded', () => {
    const t1 = makeStroke([makePoint(100, 100, 0), makePoint(102, 101, 60)]);
    const t2 = makeStroke([makePoint(101, 100, 200), makePoint(103, 102, 250)]);
    const t3 = makeStroke([makePoint(100, 101, 900), makePoint(102, 102, 950)]);
    expect(detectTapCount([t1, t2, t3], 300)).toBe(2);
  });
});

describe('detectLongPress', () => {
  it('returns true for long duration with minimal travel', () => {
    const s = makeStroke([
      makePoint(100, 100, 0),
      makePoint(101, 100, 400),
      makePoint(102, 100, 800),
    ]);
    expect(detectLongPress(s, 600)).toBe(true);
  });
  it('returns false when duration is too short', () => {
    const s = makeStroke([makePoint(100, 100, 0), makePoint(101, 100, 200)]);
    expect(detectLongPress(s, 600)).toBe(false);
  });
  it('returns false when travel is too large', () => {
    const s = makeStroke([makePoint(100, 100, 0), makePoint(160, 100, 800)]);
    expect(detectLongPress(s, 600)).toBe(false);
  });
});

describe('detectPinch', () => {
  it('returns "in" when fingers start wide and end narrow', () => {
    const a = linearStroke(100, 200, 180, 200, 5, 0, 20, 1);
    const b = linearStroke(300, 200, 220, 200, 5, 0, 20, 2);
    expect(detectPinch(a, b)).toBe('in');
  });
  it('returns "out" when fingers start narrow and end wide', () => {
    const a = linearStroke(180, 200, 100, 200, 5, 0, 20, 1);
    const b = linearStroke(220, 200, 300, 200, 5, 0, 20, 2);
    expect(detectPinch(a, b)).toBe('out');
  });
  it('returns null for a near-static two-finger hold', () => {
    const a = linearStroke(100, 200, 105, 200, 5, 0, 20, 1);
    const b = linearStroke(200, 200, 198, 200, 5, 0, 20, 2);
    expect(detectPinch(a, b)).toBeNull();
  });
});

describe('detectTwoFingerSwipe', () => {
  it('detects two fingers swiping left', () => {
    const a = linearStroke(300, 100, 100, 100, 10, 0, 20, 1);
    const b = linearStroke(300, 200, 100, 200, 10, 0, 20, 2);
    expect(detectTwoFingerSwipe([a, b])).toBe('two-finger-swipe-left');
  });
  it('detects two fingers swiping right', () => {
    const a = linearStroke(100, 100, 300, 100, 10, 0, 20, 1);
    const b = linearStroke(100, 200, 300, 200, 10, 0, 20, 2);
    expect(detectTwoFingerSwipe([a, b])).toBe('two-finger-swipe-right');
  });
  it('returns null when directions mismatch', () => {
    const a = linearStroke(300, 100, 100, 100, 10, 0, 20, 1);
    const b = linearStroke(100, 200, 300, 200, 10, 0, 20, 2);
    expect(detectTwoFingerSwipe([a, b])).toBeNull();
  });
});

describe('recognize', () => {
  it('dispatches a single swipe with confidence >= 0.7', () => {
    const r = recognize([linearStroke(300, 100, 100, 100)]);
    expect(r).not.toBeNull();
    expect(r?.type).toBe('swipe-left');
    expect(r?.confidence).toBeGreaterThanOrEqual(0.7);
  });
  it('dispatches a double-tap with confidence >= 0.85', () => {
    const t1 = makeStroke([makePoint(100, 100, 0), makePoint(102, 101, 60)]);
    const t2 = makeStroke([makePoint(101, 100, 200), makePoint(103, 102, 250)]);
    const r = recognize([t1, t2]);
    expect(r?.type === 'two-finger-tap' || r?.type === 'double-tap').toBe(true);
    expect(r?.confidence).toBeGreaterThanOrEqual(0.85);
  });
  it('prefers two-finger-swipe over a single swipe when two synced strokes are given', () => {
    const a = linearStroke(300, 100, 100, 100, 10, 0, 20, 1);
    const b = linearStroke(300, 200, 100, 200, 10, 0, 20, 2);
    expect(recognize([a, b])?.type).toBe('two-finger-swipe-left');
  });
  it('returns null for an empty stroke list', () => {
    expect(recognize([])).toBeNull();
  });
});
