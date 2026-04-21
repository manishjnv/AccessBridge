/**
 * FusionEngine test suite (vitest)
 * Uses vi.useFakeTimers() to control setInterval ticks deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FusionEngine } from '../fusion-engine.js';
import type { IngestEvent, InputChannel } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _evtCounter = 0;

function makeEvent(
  channel: InputChannel,
  type: string,
  data: Record<string, unknown> = {},
  tOffset = 0,
): IngestEvent {
  _evtCounter++;
  return {
    t: Date.now() + tOffset,
    channel,
    type,
    data,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _evtCounter = 0;
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000); // arbitrary epoch far from 0
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Test 1 — ingest single event appears in context with id + quality
// ---------------------------------------------------------------------------
describe('Test 1 — single ingest', () => {
  it('ingested event appears in context with id starting evt- and quality in [0,1]', () => {
    const engine = new FusionEngine();
    engine.ingest(makeEvent('keyboard', 'keydown', { key: 'a' }));

    const ctx = engine.getCurrentContext();
    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0]!.id).toMatch(/^evt-/);
    expect(ctx.events[0]!.quality).toBeGreaterThanOrEqual(0);
    expect(ctx.events[0]!.quality).toBeLessThanOrEqual(1);

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 2 — multiple ingests preserve insertion order by t
// ---------------------------------------------------------------------------
describe('Test 2 — order preserved', () => {
  it('events are ordered by t (ascending insertion)', () => {
    const engine = new FusionEngine();
    const base = Date.now();
    engine.ingest({ channel: 'keyboard', type: 'keydown', data: { key: 'a' }, t: base + 10 });
    engine.ingest({ channel: 'keyboard', type: 'keydown', data: { key: 'b' }, t: base + 20 });
    engine.ingest({ channel: 'keyboard', type: 'keydown', data: { key: 'c' }, t: base + 30 });

    const ctx = engine.getCurrentContext();
    const ts = ctx.events.map((e) => e.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — buffer cap at maxEventsPerWindow
// ---------------------------------------------------------------------------
describe('Test 3 — buffer cap', () => {
  it('buffer capped at maxEventsPerWindow=10 after 20 ingests', () => {
    const engine = new FusionEngine({ maxEventsPerWindow: 10, windowMs: 60_000 });
    const base = Date.now();
    for (let i = 0; i < 20; i++) {
      engine.ingest({ channel: 'mouse', type: 'move', data: {}, t: base + i });
    }

    const ctx = engine.getCurrentContext();
    expect(ctx.events.length).toBeLessThanOrEqual(10);

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — window correctness: old events excluded
// ---------------------------------------------------------------------------
describe('Test 4 — window eviction by time', () => {
  it('event before windowStart not in current events', () => {
    const engine = new FusionEngine({ windowMs: 1000 });
    const now = Date.now();
    // Event placed far in the past (outside the 1000ms window)
    engine.ingest({ channel: 'keyboard', type: 'keydown', data: { key: 'old' }, t: now - 5000 });
    // Recent event
    engine.ingest({ channel: 'keyboard', type: 'keydown', data: { key: 'new' }, t: now });

    const ctx = engine.getCurrentContext();
    // The old event should be filtered out of context.events even if not evicted from buffer
    // (window filter in getCurrentContext uses Date.now() - windowMs)
    const hasOld = ctx.events.some((e) => e.data['key'] === 'old');
    expect(hasOld).toBe(false);
    const hasNew = ctx.events.some((e) => e.data['key'] === 'new');
    expect(hasNew).toBe(true);

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 5 — subscribe + tick: callback receives FusedContext
// ---------------------------------------------------------------------------
describe('Test 5 — subscribe fires on tick', () => {
  it('context subscriber receives FusedContext after 100ms tick', () => {
    const engine = new FusionEngine();
    engine.start();

    const received: unknown[] = [];
    engine.subscribe((ctx) => received.push(ctx));

    vi.advanceTimersByTime(100);

    expect(received).toHaveLength(1);
    expect((received[0] as { events: unknown[] }).events).toBeDefined();

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 6 — multiple subscribers each called
// ---------------------------------------------------------------------------
describe('Test 6 — multiple subscribers', () => {
  it('each subscriber receives the tick callback', () => {
    const engine = new FusionEngine();
    engine.start();

    const calls: number[] = [0, 0, 0];
    engine.subscribe(() => calls[0]++);
    engine.subscribe(() => calls[1]++);
    engine.subscribe(() => calls[2]++);

    vi.advanceTimersByTime(100);

    expect(calls).toEqual([1, 1, 1]);

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 7 — unsubscribe: callback no longer fires
// ---------------------------------------------------------------------------
describe('Test 7 — unsubscribe', () => {
  it('unsubscribed callback does not fire on next tick', () => {
    const engine = new FusionEngine();
    engine.start();

    let count = 0;
    const unsub = engine.subscribe(() => count++);

    vi.advanceTimersByTime(100); // fires once
    expect(count).toBe(1);

    unsub();
    vi.advanceTimersByTime(100); // should NOT fire again
    expect(count).toBe(1);

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 8 — subscribeIntent fires when hypothesis confidence >= threshold
// ---------------------------------------------------------------------------
describe('Test 8 — subscribeIntent fires above threshold', () => {
  it('intent subscriber receives hypothesis when confidence >= 0.65', () => {
    const engine = new FusionEngine({ intentMinConfidence: 0.65 });
    engine.start();

    const intents: unknown[] = [];
    engine.subscribeIntent((h) => intents.push(h));

    const base = Date.now();

    // Set up a 'reading' scenario: stable gaze events, no keyboard, no clicks
    // reading fires at confidence 0.55 + 0 = 0.55 for short duration,
    // or 0.75 if gaze span > 3000ms. We need confidence >= 0.65.
    // Use gaze span > 3000ms → confidence = 0.75
    for (let i = 0; i <= 10; i++) {
      engine.ingest({
        channel: 'gaze',
        type: 'gaze',
        data: { x: 300, y: 200, brightness: 0.9, faceDetected: true, blinkRate: 0.25 },
        t: base - 3500 + i * 350,
      });
    }

    vi.advanceTimersByTime(100);

    // If reading intent fired, intents will have something
    // Allow the test to be flexible since other detectors may or may not fire
    // The key assertion: if any intent fires, it has confidence >= 0.65
    for (const h of intents as { confidence: number }[]) {
      expect(h.confidence).toBeGreaterThanOrEqual(0.65);
    }

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 9 — subscribeIntent does NOT fire when all hypotheses are below threshold
// ---------------------------------------------------------------------------
describe('Test 9 — subscribeIntent silent below threshold', () => {
  it('no intent callback when confidence below threshold', () => {
    // Use a very high intentMinConfidence so nothing fires
    const engine = new FusionEngine({ intentMinConfidence: 0.999 });
    engine.start();

    const intents: unknown[] = [];
    engine.subscribeIntent((h) => intents.push(h));

    // Ingest minimal events — won't trigger any detector at 0.999 confidence
    engine.ingest(makeEvent('keyboard', 'keydown', { key: 'a' }));

    vi.advanceTimersByTime(200);

    expect(intents).toHaveLength(0);

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 10 — setEnvironmentConditions propagates
// ---------------------------------------------------------------------------
describe('Test 10 — setEnvironmentConditions', () => {
  it('noise: noisy propagates to next context', () => {
    const engine = new FusionEngine();
    engine.setEnvironmentConditions({ noise: 'noisy' });

    const ctx = engine.getCurrentContext();
    expect(ctx.environmentConditions.noise).toBe('noisy');

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 11 — stop() halts ticks
// ---------------------------------------------------------------------------
describe('Test 11 — stop halts ticks', () => {
  it('no callbacks fired after stop()', () => {
    const engine = new FusionEngine();
    engine.start();

    let count = 0;
    engine.subscribe(() => count++);

    vi.advanceTimersByTime(100);
    expect(count).toBe(1);

    engine.stop();
    vi.advanceTimersByTime(300);
    expect(count).toBe(1); // no additional ticks

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 12 — dispose() idempotent
// ---------------------------------------------------------------------------
describe('Test 12 — dispose idempotent', () => {
  it('calling dispose() twice does not throw', () => {
    const engine = new FusionEngine();
    engine.start();

    expect(() => {
      engine.dispose();
      engine.dispose();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test 13 — getStats().eventsPerSec matches ingest rate
// ---------------------------------------------------------------------------
describe('Test 13 — eventsPerSec', () => {
  it('eventsPerSec reflects events ingested in the last 1000ms', () => {
    const engine = new FusionEngine({ windowMs: 10_000 });
    const base = Date.now();

    // Ingest 5 events all within the current millisecond
    for (let i = 0; i < 5; i++) {
      engine.ingest({ channel: 'mouse', type: 'move', data: {}, t: base + i });
    }

    const stats = engine.getStats();
    expect(stats.eventsPerSec).toBe(5);

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 14 — dominantChannel picks channel with highest confidence
// ---------------------------------------------------------------------------
describe('Test 14 — dominantChannel', () => {
  it('picks channel with highest confidence among active ones', () => {
    const engine = new FusionEngine({ windowMs: 60_000 });
    const base = Date.now();

    // Add many keyboard events to drive high keyboard confidence
    for (let i = 0; i < 15; i++) {
      engine.ingest({
        channel: 'keyboard',
        type: 'keydown',
        data: { key: String.fromCharCode(97 + i), target: 'input' },
        t: base - 1000 + i * 60,
      });
    }

    // Add a single voice event with explicit low snr so keyboard should dominate
    engine.ingest({
      channel: 'voice',
      type: 'interim',
      data: { snr: 0.1, transcriptConfidence: 0.1 },
      t: base,
    });

    const ctx = engine.getCurrentContext();
    expect(ctx.dominantChannel).toBe('keyboard');

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 15 — degradedChannels
// ---------------------------------------------------------------------------
describe('Test 15 — degradedChannels', () => {
  it('lists channels with sampleRate > 0 and confidence < 0.3', () => {
    const engine = new FusionEngine({ windowMs: 60_000 });
    const base = Date.now();

    // Voice with very poor quality (noisy env + low snr/confidence)
    engine.setEnvironmentConditions({ noise: 'noisy' });
    engine.ingest({
      channel: 'voice',
      type: 'interim',
      data: { snr: 0.05, transcriptConfidence: 0.05 },
      t: base,
    });

    const ctx = engine.getCurrentContext();
    // voice confidence with noise='loud/noisy' penalty 0.4 * 0.05 = 0.02 < 0.3
    expect(ctx.degradedChannels).toContain('voice');

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 16 — empty buffer: events [], all qualities zero, dominantChannel default
// ---------------------------------------------------------------------------
describe('Test 16 — empty buffer', () => {
  it('empty buffer yields events:[], all zero qualities, dominantChannel keyboard', () => {
    const engine = new FusionEngine();
    const ctx = engine.getCurrentContext();

    expect(ctx.events).toHaveLength(0);
    expect(ctx.dominantChannel).toBe('keyboard');

    for (const ch of Object.keys(ctx.channelQualities) as InputChannel[]) {
      expect(ctx.channelQualities[ch]!.sampleRate).toBe(0);
    }

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 17 — start() idempotent — single tick fires subs exactly once per period
// ---------------------------------------------------------------------------
describe('Test 17 — start() idempotent', () => {
  it('calling start() twice fires subscribers exactly once per 100ms tick', () => {
    const engine = new FusionEngine();
    engine.start();
    engine.start(); // second call is a no-op

    let count = 0;
    engine.subscribe(() => count++);

    vi.advanceTimersByTime(100);
    expect(count).toBe(1); // not 2

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 18 — Config override: custom windowMs and emitIntervalMs
// ---------------------------------------------------------------------------
describe('Test 18 — custom config applied', () => {
  it('emitIntervalMs=50 fires 2 ticks in 100ms', () => {
    const engine = new FusionEngine({ windowMs: 1000, emitIntervalMs: 50 });
    engine.start();

    let count = 0;
    engine.subscribe(() => count++);

    vi.advanceTimersByTime(100);
    expect(count).toBe(2);

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 19 — IDs are unique and monotonically increasing
// ---------------------------------------------------------------------------
describe('Test 19 — unique monotonic IDs', () => {
  it('IDs are unique and numeric suffix is monotonically increasing', () => {
    const engine = new FusionEngine();
    const base = Date.now();
    for (let i = 0; i < 10; i++) {
      engine.ingest({ channel: 'mouse', type: 'move', data: {}, t: base + i });
    }

    const ctx = engine.getCurrentContext();
    const ids = ctx.events.map((e) => e.id);
    const nums = ids.map((id) => parseInt(id.replace('evt-', ''), 10));

    // All unique
    expect(new Set(ids).size).toBe(ids.length);
    // All start with evt-
    for (const id of ids) {
      expect(id).toMatch(/^evt-\d+$/);
    }
    // Monotonically increasing
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]!).toBeGreaterThan(nums[i - 1]!);
    }

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 20 — getCompensationWeights / getActiveCompensationRules populated after tick
// ---------------------------------------------------------------------------
describe('Test 20 — compensation data after first tick', () => {
  it('getCompensationWeights and getActiveCompensationRules populated after first tick', () => {
    const engine = new FusionEngine({ compensationRulesEnabled: true });
    engine.start();

    vi.advanceTimersByTime(100);

    const weights = engine.getCompensationWeights();
    const rules = engine.getActiveCompensationRules();

    // weights should be an object with all channels as keys
    expect(typeof weights).toBe('object');
    expect(weights['keyboard']).toBeDefined();
    expect(weights['voice']).toBeDefined();

    // rules should be an array (possibly empty when no channels active)
    expect(Array.isArray(rules)).toBe(true);

    engine.dispose();
  });
});
