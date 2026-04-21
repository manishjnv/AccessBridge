import { describe, it, expect, beforeEach } from 'vitest';
import { inferIntent } from '../intent-inference.js';
import type {
  FusedContext,
  IntentHypothesis,
  UnifiedEvent,
  InputChannel,
  ChannelQuality,
  EnvironmentConditions,
} from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let __ctr = 0;
beforeEach(() => { __ctr = 0; });

function makeEvent(
  channel: InputChannel,
  type: string,
  data: Record<string, unknown>,
  t: number,
): UnifiedEvent {
  return { id: 'e' + __ctr++, t, channel, type, data, quality: 0.7 };
}

function makeQuality(
  channel: InputChannel,
  confidence: number,
  sampleRate: number,
): ChannelQuality {
  return { channel, confidence, noise: 1 - confidence, sampleRate, lastSampledAt: Date.now() };
}

const defaultEnv: EnvironmentConditions = {
  lighting: 'bright',
  noise: 'quiet',
  network: 'good',
  timeOfDay: 'day',
};

function makeContext(
  events: UnifiedEvent[],
  endT = 10_000,
  qualities: Partial<Record<InputChannel, ChannelQuality>> = {},
): FusedContext {
  const channelQualities = qualities as Record<InputChannel, ChannelQuality>;
  return {
    window: { startT: 0, endT },
    events,
    channelQualities,
    environmentConditions: defaultEnv,
    dominantChannel: 'mouse',
    degradedChannels: [],
  };
}

// ─── Invariants shared across tests ───────────────────────────────────────────

function assertInvariants(results: IntentHypothesis[], inputEvents: UnifiedEvent[]): void {
  const allIds = new Set(inputEvents.map(e => e.id));
  for (const h of results) {
    expect(h.confidence).toBeGreaterThan(0);
    expect(h.confidence).toBeLessThanOrEqual(1);
    expect(h.supportingEvents.length).toBeGreaterThan(0);
    for (const id of h.supportingEvents) {
      expect(allIds.has(id), `supporting event ${id} must exist in input`).toBe(true);
    }
    expect(h.suggestedAdaptations.length).toBeGreaterThan(0);
  }
}

// ─── Empty context ─────────────────────────────────────────────────────────────

describe('empty context', () => {
  it('returns [] when no events and no qualities', () => {
    const ctx = makeContext([]);
    expect(inferIntent(ctx)).toEqual([]);
  });
});

// ─── Sorted by confidence desc ─────────────────────────────────────────────────

describe('sorting', () => {
  it('results are sorted by confidence descending', () => {
    // typing fires high confidence; reading fires lower
    const endT = 10_000;
    const events = [
      // gaze stable → reading candidate
      makeEvent('gaze', 'gaze', { x: 100, y: 200, target: 'p' }, 5000),
      makeEvent('gaze', 'gaze', { x: 105, y: 202, target: 'p' }, 6000),
      makeEvent('gaze', 'gaze', { x: 103, y: 201, target: 'p' }, 7000),
      // keyboard typing → typing
      makeEvent('keyboard', 'keydown', { key: 'a', target: 'input' }, 9000),
      makeEvent('keyboard', 'keydown', { key: 'b', target: 'input' }, 9100),
      makeEvent('keyboard', 'keydown', { key: 'c', target: 'input' }, 9200),
    ];
    const qualities: Partial<Record<InputChannel, ChannelQuality>> = {
      gaze: makeQuality('gaze', 0.8, 1.5),
      keyboard: makeQuality('keyboard', 0.85, 3),
    };
    const ctx = makeContext(events, endT, qualities);
    const results = inferIntent(ctx);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].confidence).toBeGreaterThanOrEqual(results[i].confidence);
    }
  });
});

// ─── click-imminent ────────────────────────────────────────────────────────────

describe('click-imminent', () => {
  function makeClickImminentCtx(targetStr: string) {
    const endT = 10_000;
    const events = [
      makeEvent('gaze', 'gaze', { x: 300, y: 400, target: targetStr }, 8000),
      // mouse approaching gaze position with decreasing velocity
      makeEvent('mouse', 'mousemove', { x: 200, y: 300, velocity: 5.0 }, 9600),
      makeEvent('mouse', 'mousemove', { x: 280, y: 370, velocity: 3.0 }, 9800),
      makeEvent('mouse', 'mousemove', { x: 295, y: 390, velocity: 1.0 }, 9900),
    ];
    return { events, ctx: makeContext(events, endT, {
      gaze: makeQuality('gaze', 0.9, 1),
      mouse: makeQuality('mouse', 0.8, 5),
    }) };
  }

  it('fires for gaze target=button with approaching cursor', () => {
    const { events, ctx } = makeClickImminentCtx('button');
    const results = inferIntent(ctx);
    const h = results.find(r => r.intent === 'click-imminent');
    expect(h).toBeDefined();
    assertInvariants(results, events);
  });

  it('fires for gaze target=link with approaching cursor', () => {
    const { events, ctx } = makeClickImminentCtx('link');
    const results = inferIntent(ctx);
    expect(results.find(r => r.intent === 'click-imminent')).toBeDefined();
    assertInvariants(results, events);
  });

  it('confidence = min(gazeQ, mouseQ) * 0.8', () => {
    const { ctx } = makeClickImminentCtx('button');
    const results = inferIntent(ctx);
    const h = results.find(r => r.intent === 'click-imminent')!;
    expect(h.confidence).toBeCloseTo(Math.min(0.9, 0.8) * 0.8, 5);
  });

  it('suggestedAdaptations = [preview-tooltip]', () => {
    const { ctx } = makeClickImminentCtx('button');
    const h = inferIntent(ctx).find(r => r.intent === 'click-imminent')!;
    expect(h.suggestedAdaptations).toEqual(['preview-tooltip']);
  });

  it('does NOT fire when gaze target is not button or link', () => {
    const endT = 10_000;
    const events = [
      makeEvent('gaze', 'gaze', { x: 300, y: 400, target: 'div' }, 8000),
      makeEvent('mouse', 'mousemove', { x: 200, y: 300, velocity: 5.0 }, 9600),
      makeEvent('mouse', 'mousemove', { x: 280, y: 370, velocity: 3.0 }, 9800),
      makeEvent('mouse', 'mousemove', { x: 295, y: 390, velocity: 1.0 }, 9900),
    ];
    const ctx = makeContext(events, endT, {
      gaze: makeQuality('gaze', 0.9, 1),
      mouse: makeQuality('mouse', 0.8, 5),
    });
    const h = inferIntent(ctx).find(r => r.intent === 'click-imminent');
    expect(h).toBeUndefined();
  });

  it('does NOT fire when cursor is moving away from gaze', () => {
    const endT = 10_000;
    const events = [
      makeEvent('gaze', 'gaze', { x: 300, y: 400, target: 'button' }, 8000),
      // cursor moving away
      makeEvent('mouse', 'mousemove', { x: 290, y: 390, velocity: 1.0 }, 9600),
      makeEvent('mouse', 'mousemove', { x: 200, y: 300, velocity: 3.0 }, 9800),
      makeEvent('mouse', 'mousemove', { x: 100, y: 200, velocity: 5.0 }, 9900),
    ];
    const ctx = makeContext(events, endT, {
      gaze: makeQuality('gaze', 0.9, 1),
      mouse: makeQuality('mouse', 0.8, 5),
    });
    const h = inferIntent(ctx).find(r => r.intent === 'click-imminent');
    expect(h).toBeUndefined();
  });
});

// ─── hesitation ───────────────────────────────────────────────────────────────

describe('hesitation', () => {
  function makeHesitationCtx() {
    const endT = 10_000;
    // endT=11000; last-1500ms window = [9500, 11000].
    // Events span 9500→11000 = 1500ms so fixationDurationMs = 1500 → confidence = 0.6 exactly.
    const events = [
      makeEvent('gaze', 'gaze', { x: 200, y: 300 }, 9500),
      makeEvent('gaze', 'gaze', { x: 202, y: 301 }, 9900),
      makeEvent('gaze', 'gaze', { x: 201, y: 299 }, 10400),
      makeEvent('gaze', 'gaze', { x: 200, y: 300 }, 11000),
    ];
    return { events, ctx: makeContext(events, 11_000, {
      mouse: makeQuality('mouse', 0.6, 0.2), // low sampleRate
    }) };
  }

  it('fires when mouse is idle + gaze fixated + no recent click', () => {
    const { events, ctx } = makeHesitationCtx();
    const results = inferIntent(ctx);
    const h = results.find(r => r.intent === 'hesitation');
    expect(h).toBeDefined();
    assertInvariants(results, events);
  });

  it('has suggestedAdaptations containing confirmation-widget and inline-help', () => {
    const { ctx } = makeHesitationCtx();
    const h = inferIntent(ctx).find(r => r.intent === 'hesitation')!;
    expect(h.suggestedAdaptations).toContain('confirmation-widget');
    expect(h.suggestedAdaptations).toContain('inline-help');
  });

  it('confidence is at least 0.6', () => {
    const { ctx } = makeHesitationCtx();
    const h = inferIntent(ctx).find(r => r.intent === 'hesitation')!;
    expect(h.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('does NOT fire when there is a recent mouse click', () => {
    const endT = 10_000;
    const events = [
      makeEvent('gaze', 'gaze', { x: 200, y: 300 }, 8600),
      makeEvent('gaze', 'gaze', { x: 202, y: 301 }, 8900),
      makeEvent('gaze', 'gaze', { x: 201, y: 299 }, 9200),
      makeEvent('mouse', 'click', { type: 'click' }, 9500), // recent click
    ];
    const ctx = makeContext(events, endT, {
      mouse: makeQuality('mouse', 0.6, 0.2),
    });
    expect(inferIntent(ctx).find(r => r.intent === 'hesitation')).toBeUndefined();
  });

  it('does NOT fire when mouse sampleRate >= 0.5 (active mouse)', () => {
    const endT = 10_000;
    const events = [
      makeEvent('gaze', 'gaze', { x: 200, y: 300 }, 8600),
      makeEvent('gaze', 'gaze', { x: 202, y: 301 }, 8900),
    ];
    const ctx = makeContext(events, endT, {
      mouse: makeQuality('mouse', 0.9, 1.5), // active
    });
    expect(inferIntent(ctx).find(r => r.intent === 'hesitation')).toBeUndefined();
  });
});

// ─── reading ──────────────────────────────────────────────────────────────────

describe('reading', () => {
  function makeReadingCtx(stableMs = 4000) {
    const endT = 10_000;
    // Place gaze events so last - first = stableMs exactly
    const firstGaze = endT - stableMs;
    const lastGaze = endT - 100;
    const span = lastGaze - firstGaze; // ≈ stableMs - 100
    const events = [
      makeEvent('gaze', 'gaze', { x: 100, y: 200 }, firstGaze),
      makeEvent('gaze', 'gaze', { x: 103, y: 202 }, firstGaze + span / 3),
      makeEvent('gaze', 'gaze', { x: 101, y: 201 }, lastGaze),
      makeEvent('screen', 'scroll', { type: 'scroll', velocity: 0.1 }, firstGaze + span / 2),
    ];
    return { events, ctx: makeContext(events, endT, {
      gaze: makeQuality('gaze', 0.8, 1.5),
    }) };
  }

  it('fires when gaze stable + slow scroll + no keyboard or click', () => {
    const { events, ctx } = makeReadingCtx();
    const results = inferIntent(ctx);
    const h = results.find(r => r.intent === 'reading');
    expect(h).toBeDefined();
    assertInvariants(results, events);
  });

  it('confidence boosted to 0.75 when stable duration > 3000ms', () => {
    const { ctx } = makeReadingCtx(4000);
    const h = inferIntent(ctx).find(r => r.intent === 'reading')!;
    expect(h.confidence).toBeCloseTo(0.75, 5);
  });

  it('suggestedAdaptations = [reading-mode]', () => {
    const { ctx } = makeReadingCtx();
    const h = inferIntent(ctx).find(r => r.intent === 'reading')!;
    expect(h.suggestedAdaptations).toEqual(['reading-mode']);
  });

  it('does NOT fire when there is recent keyboard input', () => {
    const endT = 10_000;
    const events = [
      makeEvent('gaze', 'gaze', { x: 100, y: 200 }, 5000),
      makeEvent('gaze', 'gaze', { x: 103, y: 202 }, 6000),
      makeEvent('screen', 'scroll', { type: 'scroll', velocity: 0.1 }, 6500),
      makeEvent('keyboard', 'keydown', { key: 'a' }, 9500), // recent keyboard
    ];
    const ctx = makeContext(events, endT, {
      gaze: makeQuality('gaze', 0.8, 1.5),
    });
    expect(inferIntent(ctx).find(r => r.intent === 'reading')).toBeUndefined();
  });

  it('does NOT fire when gaze stddev >= 80px', () => {
    const endT = 10_000;
    const events = [
      makeEvent('gaze', 'gaze', { x: 10, y: 10 }, 5000),
      makeEvent('gaze', 'gaze', { x: 800, y: 600 }, 7000),
      makeEvent('screen', 'scroll', { type: 'scroll', velocity: 0.1 }, 6000),
    ];
    const ctx = makeContext(events, endT, {
      gaze: makeQuality('gaze', 0.8, 1.5),
    });
    expect(inferIntent(ctx).find(r => r.intent === 'reading')).toBeUndefined();
  });
});

// ─── searching ────────────────────────────────────────────────────────────────

describe('searching', () => {
  function makeSearchingCtx() {
    const endT = 10_000;
    const events = [
      makeEvent('screen', 'scroll', { type: 'scroll', velocity: 1.2, dy: 200 }, 5000),
      makeEvent('screen', 'scroll', { type: 'scroll', velocity: 0.9, dy: 150 }, 6000),
      // scattered gaze → high stddev
      makeEvent('gaze', 'gaze', { x: 10, y: 10 }, 5500),
      makeEvent('gaze', 'gaze', { x: 700, y: 500 }, 6500),
      makeEvent('gaze', 'gaze', { x: 50, y: 600 }, 7000),
      makeEvent('keyboard', 'keydown', { key: 'Backspace', target: 'input' }, 7500),
    ];
    return { events, ctx: makeContext(events, endT, {
      gaze: makeQuality('gaze', 0.8, 1),
      keyboard: makeQuality('keyboard', 0.8, 1),
    }) };
  }

  it('fires when rapid scroll + scanning gaze + backspace', () => {
    const { events, ctx } = makeSearchingCtx();
    const results = inferIntent(ctx);
    const h = results.find(r => r.intent === 'searching');
    expect(h).toBeDefined();
    assertInvariants(results, events);
  });

  it('confidence = 0.4 + 0.1*rapidScrollCount + 0.1*backspaceCount (capped 0.9)', () => {
    const { ctx } = makeSearchingCtx();
    const h = inferIntent(ctx).find(r => r.intent === 'searching')!;
    // 2 rapid scrolls, 1 backspace → 0.4 + 0.2 + 0.1 = 0.7
    expect(h.confidence).toBeCloseTo(0.7, 5);
  });

  it('suggestedAdaptations = [find-in-page-helper]', () => {
    const { ctx } = makeSearchingCtx();
    const h = inferIntent(ctx).find(r => r.intent === 'searching')!;
    expect(h.suggestedAdaptations).toEqual(['find-in-page-helper']);
  });

  it('does NOT fire when no backspace key present', () => {
    const endT = 10_000;
    const events = [
      makeEvent('screen', 'scroll', { type: 'scroll', velocity: 1.2 }, 5000),
      makeEvent('gaze', 'gaze', { x: 10, y: 10 }, 5500),
      makeEvent('gaze', 'gaze', { x: 700, y: 500 }, 6500),
      makeEvent('keyboard', 'keydown', { key: 'a', target: 'input' }, 7500),
    ];
    const ctx = makeContext(events, endT);
    expect(inferIntent(ctx).find(r => r.intent === 'searching')).toBeUndefined();
  });

  it('does NOT fire when scroll is slow (velocity ≤ 0.7)', () => {
    const endT = 10_000;
    const events = [
      makeEvent('screen', 'scroll', { type: 'scroll', velocity: 0.5 }, 5000),
      makeEvent('gaze', 'gaze', { x: 10, y: 10 }, 5500),
      makeEvent('gaze', 'gaze', { x: 700, y: 500 }, 6500),
      makeEvent('keyboard', 'keydown', { key: 'Backspace', target: 'input' }, 7500),
    ];
    const ctx = makeContext(events, endT);
    expect(inferIntent(ctx).find(r => r.intent === 'searching')).toBeUndefined();
  });
});

// ─── typing ───────────────────────────────────────────────────────────────────

describe('typing', () => {
  function makeTypingCtx(sampleRate = 3, confidence = 0.85) {
    const endT = 10_000;
    const events = [
      makeEvent('keyboard', 'keydown', { key: 'H', target: 'input' }, 9000),
      makeEvent('keyboard', 'keydown', { key: 'e', target: 'input' }, 9100),
      makeEvent('keyboard', 'keydown', { key: 'l', target: 'input' }, 9200),
    ];
    return { events, ctx: makeContext(events, endT, {
      keyboard: makeQuality('keyboard', confidence, sampleRate),
    }) };
  }

  it('fires when keyboard sampleRate > 2 and events in input target', () => {
    const { events, ctx } = makeTypingCtx();
    const results = inferIntent(ctx);
    const h = results.find(r => r.intent === 'typing');
    expect(h).toBeDefined();
    assertInvariants(results, events);
  });

  it('confidence = min(0.9, keyboardQuality.confidence)', () => {
    const { ctx } = makeTypingCtx(3, 0.85);
    const h = inferIntent(ctx).find(r => r.intent === 'typing')!;
    expect(h.confidence).toBeCloseTo(0.85, 5);
  });

  it('suggestedAdaptations = [suppress-interruptions]', () => {
    const { ctx } = makeTypingCtx();
    const h = inferIntent(ctx).find(r => r.intent === 'typing')!;
    expect(h.suggestedAdaptations).toEqual(['suppress-interruptions']);
  });

  it('fires for textarea target', () => {
    const endT = 10_000;
    const events = [
      makeEvent('keyboard', 'keydown', { key: 'a', target: 'textarea' }, 9000),
      makeEvent('keyboard', 'keydown', { key: 'b', target: 'textarea' }, 9100),
    ];
    const ctx = makeContext(events, endT, {
      keyboard: makeQuality('keyboard', 0.8, 4),
    });
    expect(inferIntent(ctx).find(r => r.intent === 'typing')).toBeDefined();
  });

  it('does NOT fire when keyboard sampleRate <= 2', () => {
    const { ctx } = makeTypingCtx(0.5);
    expect(inferIntent(ctx).find(r => r.intent === 'typing')).toBeUndefined();
  });

  it('does NOT fire when no events have input/textarea/editable target', () => {
    const endT = 10_000;
    const events = [
      makeEvent('keyboard', 'keydown', { key: 'a', target: 'body' }, 9000),
    ];
    const ctx = makeContext(events, endT, {
      keyboard: makeQuality('keyboard', 0.8, 4),
    });
    expect(inferIntent(ctx).find(r => r.intent === 'typing')).toBeUndefined();
  });
});

// ─── abandoning ───────────────────────────────────────────────────────────────

describe('abandoning', () => {
  function makeAbandoningCtx(signalType = 'beforeunload') {
    const endT = 10_000;
    const events = [
      makeEvent('keyboard', 'keydown', { key: 'a', target: 'input' }, 5000),
      makeEvent('keyboard', 'keydown', { key: 'b', target: 'input' }, 5100),
      makeEvent('mouse', signalType, { type: signalType }, 9900),
    ];
    return { events, ctx: makeContext(events, endT) };
  }

  it('fires on beforeunload signal + recent input keyboard events', () => {
    const { events, ctx } = makeAbandoningCtx('beforeunload');
    const results = inferIntent(ctx);
    const h = results.find(r => r.intent === 'abandoning');
    expect(h).toBeDefined();
    assertInvariants(results, events);
  });

  it('fires on tabswitch-pending signal', () => {
    const { events, ctx } = makeAbandoningCtx('tabswitch-pending');
    const h = inferIntent(ctx).find(r => r.intent === 'abandoning');
    expect(h).toBeDefined();
  });

  it('confidence = 0.7', () => {
    const { ctx } = makeAbandoningCtx();
    const h = inferIntent(ctx).find(r => r.intent === 'abandoning')!;
    expect(h.confidence).toBe(0.7);
  });

  it('suggestedAdaptations = [auto-save-form-draft]', () => {
    const { ctx } = makeAbandoningCtx();
    const h = inferIntent(ctx).find(r => r.intent === 'abandoning')!;
    expect(h.suggestedAdaptations).toEqual(['auto-save-form-draft']);
  });

  it('does NOT fire when no recent keyboard input in form (last 60s)', () => {
    const endT = 100_000;
    const events = [
      // input keyboard event is > 60s before endT
      makeEvent('keyboard', 'keydown', { key: 'a', target: 'input' }, 1000),
      makeEvent('mouse', 'beforeunload', { type: 'beforeunload' }, 99_900),
    ];
    const ctx = makeContext(events, endT);
    expect(inferIntent(ctx).find(r => r.intent === 'abandoning')).toBeUndefined();
  });

  it('does NOT fire when no beforeunload/tabswitch signal', () => {
    const endT = 10_000;
    const events = [
      makeEvent('keyboard', 'keydown', { key: 'a', target: 'input' }, 5000),
      makeEvent('mouse', 'mousemove', { x: 100, y: 100 }, 9900),
    ];
    const ctx = makeContext(events, endT);
    expect(inferIntent(ctx).find(r => r.intent === 'abandoning')).toBeUndefined();
  });
});

// ─── help-seeking ─────────────────────────────────────────────────────────────

describe('help-seeking', () => {
  function makeHelpSeekingCtx(dirChanges = 4) {
    const endT = 10_000;
    // Alternating scroll directions to get direction changes
    const scrollBase = endT - 4000;
    const scrollEvents: UnifiedEvent[] = [];
    for (let i = 0; i < dirChanges + 1; i++) {
      const dy = i % 2 === 0 ? 30 : -30;
      scrollEvents.push(
        makeEvent('screen', 'scroll', { type: 'scroll', dy, velocity: dy > 0 ? 0.4 : -0.4 }, scrollBase + i * 500),
      );
    }

    const events = [
      // dwell events in last 3s (no velocity → dwell)
      makeEvent('mouse', 'dwell', { x: 200, y: 300 }, 7500),
      makeEvent('mouse', 'dwell', { x: 210, y: 310 }, 8000),
      ...scrollEvents,
    ];
    return { events, ctx: makeContext(events, endT) };
  }

  it('fires when dwell + direction changes >= 3', () => {
    const { events, ctx } = makeHelpSeekingCtx(4);
    const results = inferIntent(ctx);
    const h = results.find(r => r.intent === 'help-seeking');
    expect(h).toBeDefined();
    assertInvariants(results, events);
  });

  it('confidence = 0.55 + 0.05 * directionChangeCount (capped at 0.85)', () => {
    const { ctx } = makeHelpSeekingCtx(4);
    const h = inferIntent(ctx).find(r => r.intent === 'help-seeking')!;
    // 4 direction changes → 0.55 + 0.20 = 0.75
    expect(h.confidence).toBeCloseTo(0.75, 5);
  });

  it('suggestedAdaptations = [contextual-help-panel]', () => {
    const { ctx } = makeHelpSeekingCtx();
    const h = inferIntent(ctx).find(r => r.intent === 'help-seeking')!;
    expect(h.suggestedAdaptations).toEqual(['contextual-help-panel']);
  });

  it('does NOT fire when there is a recent click', () => {
    const endT = 10_000;
    const events = [
      makeEvent('mouse', 'dwell', { x: 200, y: 300 }, 7500),
      makeEvent('mouse', 'dwell', { x: 210, y: 310 }, 8000),
      makeEvent('mouse', 'click', { type: 'click' }, 9500), // recent click
      makeEvent('screen', 'scroll', { type: 'scroll', dy: 30 }, 6000),
      makeEvent('screen', 'scroll', { type: 'scroll', dy: -30 }, 6500),
      makeEvent('screen', 'scroll', { type: 'scroll', dy: 30 }, 7000),
      makeEvent('screen', 'scroll', { type: 'scroll', dy: -30 }, 7500),
    ];
    const ctx = makeContext(events, endT);
    expect(inferIntent(ctx).find(r => r.intent === 'help-seeking')).toBeUndefined();
  });

  it('does NOT fire when direction changes < 3', () => {
    const endT = 10_000;
    const events = [
      makeEvent('mouse', 'dwell', { x: 200, y: 300 }, 7500),
      makeEvent('mouse', 'dwell', { x: 210, y: 310 }, 8000),
      // only 1 direction change
      makeEvent('screen', 'scroll', { type: 'scroll', dy: 30 }, 6000),
      makeEvent('screen', 'scroll', { type: 'scroll', dy: -30 }, 6500),
    ];
    const ctx = makeContext(events, endT);
    expect(inferIntent(ctx).find(r => r.intent === 'help-seeking')).toBeUndefined();
  });
});

// ─── Cross-cutting: reading + hesitation coexist ───────────────────────────────

describe('cross-cutting', () => {
  it('reading and hesitation can fire simultaneously on overlapping evidence', () => {
    const endT = 10_000;
    const events = [
      // stable gaze → satisfies both reading (stddev < 80) and hesitation (stddev < 50)
      makeEvent('gaze', 'gaze', { x: 200, y: 300 }, 8000),
      makeEvent('gaze', 'gaze', { x: 202, y: 302 }, 8500),
      makeEvent('gaze', 'gaze', { x: 201, y: 301 }, 9000),
      // slow scroll for reading
      makeEvent('screen', 'scroll', { type: 'scroll', velocity: 0.1 }, 8200),
    ];
    const ctx = makeContext(events, endT, {
      gaze: makeQuality('gaze', 0.8, 1.5),
      mouse: makeQuality('mouse', 0.6, 0.1), // idle mouse for hesitation
    });
    const results = inferIntent(ctx);
    const intents = results.map(r => r.intent);
    expect(intents).toContain('reading');
    expect(intents).toContain('hesitation');
    assertInvariants(results, events);
  });

  it('all result confidences are within (0, 1]', () => {
    const endT = 10_000;
    const events = [
      makeEvent('keyboard', 'keydown', { key: 'a', target: 'input' }, 9000),
      makeEvent('keyboard', 'keydown', { key: 'b', target: 'input' }, 9100),
      makeEvent('keyboard', 'keydown', { key: 'c', target: 'input' }, 9200),
    ];
    const ctx = makeContext(events, endT, {
      keyboard: makeQuality('keyboard', 0.8, 5),
    });
    const results = inferIntent(ctx);
    for (const h of results) {
      expect(h.confidence).toBeGreaterThan(0);
      expect(h.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('supportingEvents IDs all exist in input events', () => {
    const endT = 10_000;
    const events = [
      makeEvent('gaze', 'gaze', { x: 100, y: 200, target: 'button' }, 8000),
      makeEvent('mouse', 'mousemove', { x: 200, y: 300, velocity: 5 }, 9600),
      makeEvent('mouse', 'mousemove', { x: 280, y: 370, velocity: 3 }, 9800),
      makeEvent('mouse', 'mousemove', { x: 295, y: 390, velocity: 1 }, 9900),
    ];
    const ctx = makeContext(events, endT, {
      gaze: makeQuality('gaze', 0.9, 1),
      mouse: makeQuality('mouse', 0.8, 5),
    });
    assertInvariants(inferIntent(ctx), events);
  });
});
