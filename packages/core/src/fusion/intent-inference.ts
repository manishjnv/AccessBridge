/**
 * Multi-Modal Fusion Layer 5 — Intent Inference
 *
 * Pure function: no DOM, no I/O.
 * Accepts a FusedContext and returns all fired IntentHypotheses (confidence > 0)
 * sorted by confidence descending.
 */

import type { FusedContext, IntentHypothesis, UnifiedEvent } from './types.js';

// ─── Geometry helpers ──────────────────────────────────────────────────────────

function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function coordStddev(events: UnifiedEvent[]): number {
  const xs = events.map(e => Number(e.data.x ?? 0));
  const ys = events.map(e => Number(e.data.y ?? 0));
  return Math.sqrt(stddev(xs) ** 2 + stddev(ys) ** 2);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ─── Window-relative time helpers ─────────────────────────────────────────────

function eventsInLast(events: UnifiedEvent[], endT: number, ms: number): UnifiedEvent[] {
  return events.filter(e => e.t >= endT - ms);
}

// ─── 1. click-imminent ────────────────────────────────────────────────────────

function detectClickImminent(ctx: FusedContext): IntentHypothesis | null {
  const { events, window: win, channelQualities } = ctx;

  const gazeEvents = events.filter(
    e => e.channel === 'gaze' &&
      (String(e.data.target) === 'button' || String(e.data.target) === 'link'),
  );
  if (gazeEvents.length === 0) return null;

  const lastGaze = gazeEvents[gazeEvents.length - 1];
  const gazeX = Number(lastGaze.data.x ?? 0);
  const gazeY = Number(lastGaze.data.y ?? 0);

  const recentMouse = eventsInLast(
    events.filter(e => e.channel === 'mouse'),
    win.endT,
    500,
  );
  if (recentMouse.length < 2) return null;

  // Check decreasing distance to gaze target
  let prevDist = Infinity;
  let decreasingDist = false;
  let prevVel = Infinity;
  let decreasingVel = false;

  for (const me of recentMouse) {
    const mx = Number(me.data.x ?? 0);
    const my = Number(me.data.y ?? 0);
    const dist = Math.sqrt((mx - gazeX) ** 2 + (my - gazeY) ** 2);
    const vel = Math.abs(Number(me.data.velocity ?? me.data.speed ?? 0));

    if (dist < prevDist) decreasingDist = true;
    if (vel < prevVel && prevVel !== Infinity) decreasingVel = true;
    prevDist = dist;
    prevVel = vel;
  }

  if (!decreasingDist || !decreasingVel) return null;

  const gazeQ = channelQualities['gaze']?.confidence ?? lastGaze.quality;
  const mouseQ = channelQualities['mouse']?.confidence ?? 0.7;
  const confidence = Math.min(gazeQ, mouseQ) * 0.8;
  if (confidence <= 0) return null;

  const supportingEvents = [
    lastGaze.id,
    ...recentMouse.slice(-3).map(e => e.id),
  ];

  return {
    intent: 'click-imminent',
    confidence,
    supportingEvents,
    suggestedAdaptations: ['preview-tooltip'],
  };
}

// ─── 2. hesitation ────────────────────────────────────────────────────────────

function detectHesitation(ctx: FusedContext): IntentHypothesis | null {
  const { events, window: win, channelQualities } = ctx;
  const WINDOW_MS = 1500;

  const mouseQuality = channelQualities['mouse'];
  if (!mouseQuality || mouseQuality.sampleRate >= 0.5) return null;

  const recentGaze = eventsInLast(
    events.filter(e => e.channel === 'gaze'),
    win.endT,
    WINDOW_MS,
  );
  if (recentGaze.length < 2) return null;

  const gazeStddev = coordStddev(recentGaze);
  if (gazeStddev >= 50) return null;

  const recentClicks = eventsInLast(events, win.endT, WINDOW_MS).filter(
    e => (e.channel === 'mouse') && (e.type === 'click' || String(e.data.type) === 'click'),
  );
  if (recentClicks.length > 0) return null;

  // Fixation duration: span of gaze events in the window
  const gTimes = recentGaze.map(e => e.t);
  const fixationDurationMs = gTimes.length >= 2 ? gTimes[gTimes.length - 1] - gTimes[0] : 0;

  const confidence = 0.6 + Math.min(0.25, (fixationDurationMs - 1500) / 10000);
  if (confidence <= 0) return null;

  return {
    intent: 'hesitation',
    confidence: clamp(confidence, 0, 1),
    supportingEvents: recentGaze.map(e => e.id),
    suggestedAdaptations: ['confirmation-widget', 'inline-help'],
  };
}

// ─── 3. reading ───────────────────────────────────────────────────────────────

function detectReading(ctx: FusedContext): IntentHypothesis | null {
  const { events, window: win, channelQualities } = ctx;

  const gazeQ = channelQualities['gaze'];
  if (!gazeQ || gazeQ.sampleRate <= 0) return null;

  const allGaze = events.filter(e => e.channel === 'gaze');
  if (allGaze.length < 2) return null;

  const gazeStddev = coordStddev(allGaze);
  if (gazeStddev >= 80) return null;

  const scrollEvents = events.filter(
    e => (e.channel === 'screen' && String(e.data.type) === 'scroll') ||
      (e.channel === 'mouse' && (e.type === 'scroll' || String(e.data.type) === 'scroll')),
  );

  const slowScrolls = scrollEvents.filter(
    e => e.data.velocity === undefined || Number(e.data.velocity) < 0.3,
  );

  const recentKeyboard = eventsInLast(
    events.filter(e => e.channel === 'keyboard'),
    win.endT,
    2000,
  );
  if (recentKeyboard.length > 0) return null;

  const recentClicks = eventsInLast(events, win.endT, 2000).filter(
    e => e.channel === 'mouse' && (e.type === 'click' || String(e.data.type) === 'click'),
  );
  if (recentClicks.length > 0) return null;

  const gTimes = allGaze.map(e => e.t);
  const stableDurationMs = gTimes.length >= 2 ? gTimes[gTimes.length - 1] - gTimes[0] : 0;

  const confidence = clamp(0.55 + (stableDurationMs > 3000 ? 0.2 : 0), 0, 0.85);

  const supportingEvents = [
    ...allGaze.map(e => e.id),
    ...slowScrolls.map(e => e.id),
  ];

  return {
    intent: 'reading',
    confidence,
    supportingEvents,
    suggestedAdaptations: ['reading-mode'],
  };
}

// ─── 4. searching ─────────────────────────────────────────────────────────────

function detectSearching(ctx: FusedContext): IntentHypothesis | null {
  const { events } = ctx;

  const rapidScrolls = events.filter(
    e => (e.channel === 'screen' && String(e.data.type) === 'scroll' && Number(e.data.velocity) > 0.7) ||
      (e.channel === 'mouse' && (e.type === 'scroll' || String(e.data.type) === 'scroll') && Number(e.data.velocity) > 0.7),
  );
  if (rapidScrolls.length === 0) return null;

  const allGaze = events.filter(e => e.channel === 'gaze');
  const gazeStddev = coordStddev(allGaze);
  if (gazeStddev <= 150) return null;

  const backspaceEvents = events.filter(
    e => e.channel === 'keyboard' && String(e.data.key) === 'Backspace',
  );
  if (backspaceEvents.length === 0) return null;

  const confidence = clamp(
    0.4 + 0.1 * rapidScrolls.length + 0.1 * backspaceEvents.length,
    0,
    0.9,
  );

  const supportingEvents = [
    ...rapidScrolls.map(e => e.id),
    ...allGaze.map(e => e.id),
    ...backspaceEvents.map(e => e.id),
  ];

  return {
    intent: 'searching',
    confidence,
    supportingEvents,
    suggestedAdaptations: ['find-in-page-helper'],
  };
}

// ─── 5. typing ────────────────────────────────────────────────────────────────

function detectTyping(ctx: FusedContext): IntentHypothesis | null {
  const { events, channelQualities } = ctx;

  const kbdQ = channelQualities['keyboard'];
  if (!kbdQ || kbdQ.sampleRate <= 2) return null;

  const inputKeyEvents = events.filter(
    e => e.channel === 'keyboard' &&
      ['input', 'textarea', 'editable'].includes(String(e.data.target)),
  );
  if (inputKeyEvents.length === 0) return null;

  const confidence = clamp(kbdQ.confidence ?? 0.7, 0, 0.9);

  return {
    intent: 'typing',
    confidence,
    supportingEvents: inputKeyEvents.slice(0, 3).map(e => e.id),
    suggestedAdaptations: ['suppress-interruptions'],
  };
}

// ─── 6. abandoning ────────────────────────────────────────────────────────────

function detectAbandoning(ctx: FusedContext): IntentHypothesis | null {
  const { events, window: win } = ctx;

  const pendingEvents = events.filter(
    e => String(e.data.type) === 'tabswitch-pending' ||
      String(e.data.type) === 'beforeunload' ||
      e.type === 'beforeunload',
  );
  if (pendingEvents.length === 0) return null;

  const recentInputKeyEvents = eventsInLast(events, win.endT, 60000).filter(
    e => e.channel === 'keyboard' &&
      ['input', 'textarea', 'editable'].includes(String(e.data.target)),
  );
  if (recentInputKeyEvents.length === 0) return null;

  const supportingEvents = [
    ...pendingEvents.map(e => e.id),
    ...recentInputKeyEvents.slice(0, 2).map(e => e.id),
  ];

  return {
    intent: 'abandoning',
    confidence: 0.7,
    supportingEvents,
    suggestedAdaptations: ['auto-save-form-draft'],
  };
}

// ─── 7. help-seeking ──────────────────────────────────────────────────────────

function detectHelpSeeking(ctx: FusedContext): IntentHypothesis | null {
  const { events, window: win } = ctx;
  const DWELL_WINDOW = 3000;
  const SCROLL_WINDOW = 5000;

  const recentClicks = eventsInLast(events, win.endT, DWELL_WINDOW).filter(
    e => e.channel === 'mouse' && (e.type === 'click' || String(e.data.type) === 'click'),
  );
  if (recentClicks.length > 0) return null;

  // Dwell events: explicit type==='dwell', or mouse events with no velocity / low velocity
  const dwellEvents = eventsInLast(
    events.filter(e => e.channel === 'mouse'),
    win.endT,
    DWELL_WINDOW,
  ).filter(
    e => e.type === 'dwell' ||
      String(e.data.type) === 'dwell' ||
      (e.data.velocity === undefined && e.type !== 'click') ||
      Number(e.data.velocity) < 0.1,
  );
  if (dwellEvents.length < 2) return null;

  // Scroll direction changes in last 5000ms
  const recentScrolls = eventsInLast(
    events.filter(
      e => (e.channel === 'screen' && String(e.data.type) === 'scroll') ||
        (e.channel === 'mouse' && (e.type === 'scroll' || String(e.data.type) === 'scroll')),
    ),
    win.endT,
    SCROLL_WINDOW,
  );

  let directionChanges = 0;
  let prevSign: number | null = null;
  for (const se of recentScrolls) {
    const dy = Number(se.data.dy ?? se.data.velocity ?? 0);
    const sign = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    if (sign !== 0 && prevSign !== null && sign !== prevSign) directionChanges++;
    if (sign !== 0) prevSign = sign;
  }

  if (directionChanges < 3) return null;

  const confidence = clamp(0.55 + 0.05 * directionChanges, 0, 0.85);

  const supportingEvents = [
    ...dwellEvents.map(e => e.id),
    ...recentScrolls.map(e => e.id),
  ];

  return {
    intent: 'help-seeking',
    confidence,
    supportingEvents,
    suggestedAdaptations: ['contextual-help-panel'],
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Infer user intent from a fused multi-modal context.
 * Returns all hypotheses with confidence > 0, sorted by confidence descending.
 */
export function inferIntent(context: FusedContext): IntentHypothesis[] {
  const detectors = [
    detectClickImminent,
    detectHesitation,
    detectReading,
    detectSearching,
    detectTyping,
    detectAbandoning,
    detectHelpSeeking,
  ];

  return detectors
    .map(fn => fn(context))
    .filter((h): h is IntentHypothesis => h !== null && h.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);
}
