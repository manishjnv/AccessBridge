/**
 * Session 11: Multi-Modal Fusion — sensor adapters.
 *
 * Each adapter is a thin factory: it takes an `ingest(IngestEvent)` callback
 * and wires a single input channel into the FusionEngine. No adapter mutates
 * sensor internals — they either attach DOM listeners directly (kbd, mouse,
 * touch, screen) or receive pre-computed samples from the controller (gaze,
 * voice, env). Each factory returns an `unsubscribe` function.
 *
 * IIFE-safe: no short module-level vars (see RCA BUG-008 / BUG-012).
 */

import type { IngestEvent } from '@accessbridge/core/types';

export type Ingest = (event: IngestEvent) => void;
export type Unsubscribe = () => void;

function nowMs(): number {
  return Date.now();
}

function getTargetTag(target: EventTarget | null): string {
  if (!(target instanceof Element)) return 'unknown';
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return tag;
  if ((target as HTMLElement).isContentEditable) return 'editable';
  if (tag === 'a') return 'link';
  if (tag === 'button' || target.getAttribute('role') === 'button') return 'button';
  return tag;
}

/** Keyboard adapter: attaches keydown to document. */
export function attachKeyboardAdapter(ingest: Ingest): Unsubscribe {
  let lastT = 0;
  const onKey = (e: KeyboardEvent) => {
    const t = nowMs();
    const dt = lastT > 0 ? t - lastT : 0;
    lastT = t;
    ingest({
      t,
      channel: 'keyboard',
      type: 'keydown',
      data: {
        key: e.key,
        code: e.code,
        target: getTargetTag(e.target),
        dt,
      },
    });
  };
  document.addEventListener('keydown', onKey, true);
  return () => document.removeEventListener('keydown', onKey, true);
}

/** Mouse adapter: mousemove (throttled ~50ms), click, scroll. */
export function attachMouseAdapter(ingest: Ingest): Unsubscribe {
  let lastMove = 0;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;

  const MOVE_THROTTLE_MS = 50;

  const onMove = (e: MouseEvent) => {
    const t = nowMs();
    if (t - lastMove < MOVE_THROTTLE_MS) return;
    const dx = lastT > 0 ? e.clientX - lastX : 0;
    const dy = lastT > 0 ? e.clientY - lastY : 0;
    const dt = lastT > 0 ? t - lastT : 0;
    const velocity = dt > 0 ? Math.sqrt(dx * dx + dy * dy) / dt : 0;
    const smoothness = velocity > 0 ? Math.max(0, 1 - Math.min(velocity / 5, 1)) : 0.5;
    ingest({
      t,
      channel: 'mouse',
      type: 'mousemove',
      data: {
        x: e.clientX,
        y: e.clientY,
        dx,
        dy,
        dt,
        velocityX: dt > 0 ? dx / dt : 0,
        velocityY: dt > 0 ? dy / dt : 0,
        velocity,
        smoothness,
        target: getTargetTag(e.target),
      },
    });
    lastMove = t;
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = t;
  };

  const onClick = (e: MouseEvent) => {
    ingest({
      t: nowMs(),
      channel: 'mouse',
      type: 'click',
      data: {
        x: e.clientX,
        y: e.clientY,
        target: getTargetTag(e.target),
      },
    });
  };

  const onScroll = () => {
    const t = nowMs();
    const dt = lastT > 0 ? t - lastT : 0;
    const dy = window.scrollY - lastY;
    const velocity = dt > 0 ? Math.abs(dy) / dt : 0;
    ingest({
      t,
      channel: 'screen',
      type: 'scroll',
      data: {
        y: window.scrollY,
        dy,
        velocity,
        value: Math.min(velocity / 5, 1),
      },
    });
    lastY = window.scrollY;
    lastT = t;
  };

  document.addEventListener('mousemove', onMove, { passive: true });
  document.addEventListener('click', onClick, true);
  window.addEventListener('scroll', onScroll, { passive: true });

  return () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('scroll', onScroll);
  };
}

/** Touch adapter: basic touch + pointer events for mobile/tablet. */
export function attachTouchAdapter(ingest: Ingest): Unsubscribe {
  const onTouchStart = (e: TouchEvent) => {
    ingest({
      t: nowMs(),
      channel: 'touch',
      type: 'touchstart',
      data: {
        fingers: e.touches.length,
        target: getTargetTag(e.target),
        gestureConfidence: 0.75,
      },
    });
  };
  const onPointer = (e: PointerEvent) => {
    ingest({
      t: nowMs(),
      channel: 'pointer',
      type: e.type,
      data: {
        pointerType: e.pointerType,
        pressure: e.pressure,
        target: getTargetTag(e.target),
        gestureConfidence: 0.8,
      },
    });
  };
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('pointerdown', onPointer, { passive: true });
  return () => {
    document.removeEventListener('touchstart', onTouchStart);
    document.removeEventListener('pointerdown', onPointer);
  };
}

/** Screen adapter: beforeunload + visibility (feeds `abandoning` intent). */
export function attachScreenAdapter(ingest: Ingest): Unsubscribe {
  const onBeforeUnload = () => {
    ingest({
      t: nowMs(),
      channel: 'screen',
      type: 'beforeunload',
      data: { value: 1 },
    });
  };
  const onVisibility = () => {
    ingest({
      t: nowMs(),
      channel: 'screen',
      type: document.hidden ? 'tabswitch-pending' : 'tab-focus',
      data: { hidden: document.hidden, value: document.hidden ? 0 : 1 },
    });
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** Explicit gaze sample — controller calls this from EyeTracker.onGaze. */
export function emitGazeSample(
  ingest: Ingest,
  x: number,
  y: number,
  quality: {
    brightness?: number;
    faceDetected?: boolean;
    blinkRate?: number;
  } = {},
): void {
  const target = document.elementFromPoint(x, y);
  ingest({
    t: nowMs(),
    channel: 'gaze',
    type: 'gaze-sample',
    data: {
      x,
      y,
      target: getTargetTag(target),
      brightness: quality.brightness ?? 0.6,
      faceDetected: quality.faceDetected ?? true,
      blinkRate: quality.blinkRate ?? 0.25,
    },
  });
}

/** Voice transcript sample — controller calls when STT emits interim/final. */
export function emitVoiceSample(
  ingest: Ingest,
  transcript: string,
  opts: {
    final?: boolean;
    snr?: number;
    transcriptConfidence?: number;
  } = {},
): void {
  ingest({
    t: nowMs(),
    channel: 'voice',
    type: opts.final ? 'final' : 'interim',
    data: {
      transcript,
      snr: opts.snr ?? 0.7,
      transcriptConfidence: opts.transcriptConfidence ?? 0.7,
    },
  });
}

/** Environment adapter — controller hands in a snapshot. */
export function emitEnvironmentSample(
  ingest: Ingest,
  snapshot: {
    lightLevel?: number;
    noiseLevel?: number;
    networkQuality?: number;
  },
): void {
  const t = nowMs();
  if (typeof snapshot.lightLevel === 'number') {
    ingest({
      t,
      channel: 'env-light',
      type: 'sample',
      data: { value: snapshot.lightLevel },
    });
  }
  if (typeof snapshot.noiseLevel === 'number') {
    ingest({
      t,
      channel: 'env-noise',
      type: 'sample',
      data: { value: snapshot.noiseLevel },
    });
  }
  if (typeof snapshot.networkQuality === 'number') {
    ingest({
      t,
      channel: 'env-network',
      type: 'sample',
      data: { value: snapshot.networkQuality },
    });
  }
}

/** Derive FusionEngine EnvironmentConditions from numeric env snapshot. */
export function snapshotToConditions(snapshot: {
  lightLevel?: number;
  noiseLevel?: number;
  networkQuality?: number;
}): {
  lighting: string;
  noise: string;
  network: string;
  timeOfDay: string;
} {
  const lightLevel = snapshot.lightLevel;
  const noiseLevel = snapshot.noiseLevel;
  const networkQuality = snapshot.networkQuality;
  const hour = new Date().getHours();
  const timeOfDay =
    hour >= 5 && hour < 12 ? 'morning'
      : hour >= 12 && hour < 17 ? 'afternoon'
      : hour >= 17 && hour < 21 ? 'evening'
      : 'night';
  return {
    lighting:
      typeof lightLevel !== 'number' ? 'bright'
        : lightLevel < 0.15 ? 'dark'
        : lightLevel < 0.35 ? 'dim'
        : lightLevel < 0.7 ? 'normal'
        : 'bright',
    noise:
      typeof noiseLevel !== 'number' ? 'quiet'
        : noiseLevel > 0.7 ? 'loud'
        : noiseLevel > 0.4 ? 'moderate'
        : 'quiet',
    network:
      typeof networkQuality !== 'number' ? 'good'
        : networkQuality < 0.3 ? 'poor'
        : networkQuality < 0.6 ? 'fair'
        : 'good',
    timeOfDay,
  };
}
