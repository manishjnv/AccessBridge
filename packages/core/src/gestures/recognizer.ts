import type { GestureStroke, RecognizedGesture, GestureType } from './types.js';

const MIN_SWIPE_DISTANCE = 50;
const SWIPE_AXIS_DOMINANCE = 1.8;
const CIRCLE_MIN_ARC = (3 * Math.PI) / 2;
const CIRCLE_MIN_POINTS = 8;
const ZIGZAG_DEAD_ZONE = 2;
const ZIGZAG_MIN_REVERSALS = 3;
const TAP_MAX_DURATION = 200;
const TAP_MAX_TRAVEL = 15;
const LONG_PRESS_MAX_TRAVEL = 10;
const PINCH_MIN_DELTA = 20;

function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

function strokeTravel(stroke: GestureStroke): number {
  if (stroke.points.length < 2) return 0;
  const a = stroke.points[0];
  const b = stroke.points[stroke.points.length - 1];
  return distance(a.x, a.y, b.x, b.y);
}

function strokePathLength(stroke: GestureStroke): number {
  let total = 0;
  for (let i = 1; i < stroke.points.length; i++) {
    total += distance(
      stroke.points[i - 1].x,
      stroke.points[i - 1].y,
      stroke.points[i].x,
      stroke.points[i].y,
    );
  }
  return total;
}

export function detectSwipeDirection(
  stroke: GestureStroke,
): 'left' | 'right' | 'up' | 'down' | null {
  if (stroke.points.length < 2) return null;
  const a = stroke.points[0];
  const b = stroke.points[stroke.points.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const total = Math.hypot(dx, dy);
  if (total < MIN_SWIPE_DISTANCE) return null;

  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX >= absY) {
    if (absX < absY * SWIPE_AXIS_DOMINANCE) return null;
    return dx < 0 ? 'left' : 'right';
  }
  if (absY < absX * SWIPE_AXIS_DOMINANCE) return null;
  return dy < 0 ? 'up' : 'down';
}

export function detectCircle(stroke: GestureStroke): 'cw' | 'ccw' | null {
  if (stroke.points.length < CIRCLE_MIN_POINTS) return null;

  let cx = 0;
  let cy = 0;
  for (const p of stroke.points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= stroke.points.length;
  cy /= stroke.points.length;

  let radiusMin = Infinity;
  let radiusMax = 0;
  for (const p of stroke.points) {
    const r = distance(p.x, p.y, cx, cy);
    if (r < radiusMin) radiusMin = r;
    if (r > radiusMax) radiusMax = r;
  }
  if (radiusMax < 10) return null;

  let prevAngle = Math.atan2(stroke.points[0].y - cy, stroke.points[0].x - cx);
  let total = 0;
  for (let i = 1; i < stroke.points.length; i++) {
    const cur = Math.atan2(stroke.points[i].y - cy, stroke.points[i].x - cx);
    let delta = cur - prevAngle;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    total += delta;
    prevAngle = cur;
  }

  if (Math.abs(total) < CIRCLE_MIN_ARC) return null;
  // Screen coords: y grows downward, so atan2 integration reverses.
  // Positive integrated delta => counter-clockwise on screen.
  return total > 0 ? 'ccw' : 'cw';
}

export function detectZigzag(stroke: GestureStroke): boolean {
  if (stroke.points.length < 4) return false;

  let sumAbsX = 0;
  let sumAbsY = 0;
  for (let i = 1; i < stroke.points.length; i++) {
    sumAbsX += Math.abs(stroke.points[i].x - stroke.points[i - 1].x);
    sumAbsY += Math.abs(stroke.points[i].y - stroke.points[i - 1].y);
  }
  const axis: 'x' | 'y' = sumAbsX >= sumAbsY ? 'x' : 'y';

  let prevDir = 0;
  let reversals = 0;
  for (let i = 1; i < stroke.points.length; i++) {
    const delta =
      axis === 'x'
        ? stroke.points[i].x - stroke.points[i - 1].x
        : stroke.points[i].y - stroke.points[i - 1].y;
    if (Math.abs(delta) < ZIGZAG_DEAD_ZONE) continue;
    const dir = delta > 0 ? 1 : -1;
    if (prevDir !== 0 && dir !== prevDir) reversals++;
    prevDir = dir;
  }
  return reversals >= ZIGZAG_MIN_REVERSALS;
}

function isTapStroke(stroke: GestureStroke): boolean {
  return (
    stroke.durationMs <= TAP_MAX_DURATION && strokeTravel(stroke) <= TAP_MAX_TRAVEL
  );
}

export function detectTapCount(strokes: GestureStroke[], maxGapMs: number): number {
  if (strokes.length === 0) return 0;
  if (!isTapStroke(strokes[0])) return 0;
  let count = 1;
  for (let i = 1; i < strokes.length; i++) {
    if (!isTapStroke(strokes[i])) break;
    const prev = strokes[i - 1];
    const prevLast = prev.points[prev.points.length - 1];
    const nextFirst = strokes[i].points[0];
    const gap = nextFirst.t - prevLast.t;
    if (gap > maxGapMs) break;
    count++;
  }
  return count;
}

export function detectLongPress(stroke: GestureStroke, minDurationMs: number): boolean {
  return (
    stroke.durationMs >= minDurationMs && strokeTravel(stroke) <= LONG_PRESS_MAX_TRAVEL
  );
}

export function detectPinch(
  strokeA: GestureStroke,
  strokeB: GestureStroke,
): 'in' | 'out' | null {
  if (strokeA.points.length === 0 || strokeB.points.length === 0) return null;
  const a0 = strokeA.points[0];
  const b0 = strokeB.points[0];
  const a1 = strokeA.points[strokeA.points.length - 1];
  const b1 = strokeB.points[strokeB.points.length - 1];
  const startDist = distance(a0.x, a0.y, b0.x, b0.y);
  const endDist = distance(a1.x, a1.y, b1.x, b1.y);
  if (Math.abs(endDist - startDist) < PINCH_MIN_DELTA) return null;
  return endDist < startDist ? 'in' : 'out';
}

export function detectTwoFingerSwipe(
  strokes: GestureStroke[],
): 'two-finger-swipe-left' | 'two-finger-swipe-right' | null {
  if (strokes.length !== 2) return null;
  const dirA = detectSwipeDirection(strokes[0]);
  const dirB = detectSwipeDirection(strokes[1]);
  if (!dirA || !dirB) return null;
  if (dirA === 'left' && dirB === 'left') return 'two-finger-swipe-left';
  if (dirA === 'right' && dirB === 'right') return 'two-finger-swipe-right';
  return null;
}

function buildResult(
  type: GestureType,
  confidence: number,
  stroke: GestureStroke,
): RecognizedGesture {
  return { type, confidence, stroke };
}

function mergedStroke(strokes: GestureStroke[]): GestureStroke {
  const points = strokes.flatMap((s) => s.points);
  const duration = strokes.reduce((m, s) => Math.max(m, s.durationMs), 0);
  return {
    points,
    durationMs: duration,
    fingerCount: strokes.length,
  };
}

export function recognize(strokes: GestureStroke[]): RecognizedGesture | null {
  if (strokes.length === 0) return null;

  // Two-stroke gestures first: pinch beats swipe (distance change is more specific).
  if (strokes.length === 2) {
    const pinch = detectPinch(strokes[0], strokes[1]);
    if (pinch) {
      const type: GestureType = pinch === 'in' ? 'pinch-in' : 'pinch-out';
      return buildResult(type, 0.85, mergedStroke(strokes));
    }
    const twoFinger = detectTwoFingerSwipe(strokes);
    if (twoFinger) return buildResult(twoFinger, 0.85, mergedStroke(strokes));
    // Both short? two-finger tap.
    if (strokes.every((s) => isTapStroke(s))) {
      return buildResult('two-finger-tap', 0.9, mergedStroke(strokes));
    }
  }

  if (strokes.length === 3) {
    if (strokes.every((s) => isTapStroke(s))) {
      return buildResult('three-finger-tap', 0.9, mergedStroke(strokes));
    }
  }

  if (strokes.length === 1) {
    const stroke = strokes[0];

    if (detectLongPress(stroke, 600)) {
      return buildResult('long-press', 0.9, stroke);
    }

    const tapCount = detectTapCount([stroke], 300);
    if (tapCount === 1 && strokePathLength(stroke) <= TAP_MAX_TRAVEL + 1) {
      // A single lone tap is rarely a useful gesture on its own.
      // Fall through to allow swipe / zigzag / circle if applicable; otherwise none.
    }

    const circle = detectCircle(stroke);
    if (circle) {
      return buildResult(circle === 'cw' ? 'circle-cw' : 'circle-ccw', 0.8, stroke);
    }

    if (detectZigzag(stroke)) {
      return buildResult('zigzag', 0.75, stroke);
    }

    const dir = detectSwipeDirection(stroke);
    if (dir) {
      const type: GestureType =
        dir === 'left'
          ? 'swipe-left'
          : dir === 'right'
            ? 'swipe-right'
            : dir === 'up'
              ? 'swipe-up'
              : 'swipe-down';
      return buildResult(type, 0.85, stroke);
    }
  }

  // Tap sequences (e.g. double-tap / triple-tap spread across several single-pointer strokes).
  const tapCount = detectTapCount(strokes, 300);
  if (tapCount === 2) return buildResult('double-tap', 0.9, mergedStroke(strokes));
  if (tapCount >= 3) return buildResult('triple-tap', 0.9, mergedStroke(strokes));

  return null;
}
