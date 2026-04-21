/**
 * Multi-Modal Fusion (Layer 5) — FusionEngine
 *
 * Orchestrates the sliding-window fusion pipeline:
 *   ingest → quality estimation → compensation → intent inference → emit
 *
 * Pure TypeScript; no DOM, no chrome.* APIs.
 */

import { DEFAULT_FUSION_CONFIG, ALL_INPUT_CHANNELS } from './types.js';
import type {
  UnifiedEvent,
  FusedContext,
  IntentHypothesis,
  FusionEngineConfig,
  IngestEvent,
  FusionStats,
  ChannelQuality,
  EnvironmentConditions,
  InputChannel,
} from './types.js';
import { estimateChannelQuality } from './quality-estimator.js';
import { applyCompensation, DEFAULT_COMPENSATION_RULES, getActiveRules } from './compensator.js';
import { inferIntent } from './intent-inference.js';

export class FusionEngine {
  private readonly _config: FusionEngineConfig;

  private _buffer: UnifiedEvent[] = [];
  private _idCounter = 0;
  private _totalIngested = 0;
  private _recentIngestTimes: number[] = [];

  private _env: EnvironmentConditions = {
    lighting: 'bright',
    noise: 'quiet',
    network: 'good',
    timeOfDay: 'day',
  };

  private _contextSubs: Set<(ctx: FusedContext) => void> = new Set();
  private _intentSubs: Set<(h: IntentHypothesis) => void> = new Set();

  private _timerId: ReturnType<typeof setInterval> | null = null;

  private _lastIntent: IntentHypothesis | null = null;
  private _lastEmittedAt = 0;
  private _lastWeights: Record<InputChannel, number> = Object.fromEntries(
    ALL_INPUT_CHANNELS.map((ch) => [ch, 0]),
  ) as Record<InputChannel, number>;
  private _lastActiveRuleIds: string[] = [];

  constructor(config?: Partial<FusionEngineConfig>) {
    this._config = { ...DEFAULT_FUSION_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // ingest
  // ---------------------------------------------------------------------------

  ingest(event: IngestEvent): void {
    const id = `evt-${++this._idCounter}`;

    // Compute per-event quality using last 50 events of same channel from buffer
    const filtered = this._buffer.filter((e) => e.channel === event.channel).slice(-50);

    // Build a temporary complete event (without quality yet) for quality estimation
    const tempEvent: UnifiedEvent = { ...event, id, quality: 0 };
    const qResult = estimateChannelQuality(event.channel, [...filtered, tempEvent], this._env);
    const quality = qResult.confidence;

    const fullEvent: UnifiedEvent = { ...event, id, quality };
    this._buffer.push(fullEvent);

    this._totalIngested++;

    const now = Date.now();
    this._recentIngestTimes.push(now);
    // Prune ingest-time ring to last 1000 ms inline; otherwise at mousemove
    // rates (~20/s) this grows unbounded on tabs where getStats() is never
    // polled. Security: bounded memory is a prerequisite for long-running
    // content scripts.
    const ingestCutoff = now - 1000;
    if (this._recentIngestTimes.length > 0 && this._recentIngestTimes[0]! < ingestCutoff) {
      this._recentIngestTimes = this._recentIngestTimes.filter((t) => t >= ingestCutoff);
    }

    // Evict by time
    const cutoff = now - this._config.windowMs;
    let i = 0;
    while (i < this._buffer.length && this._buffer[i]!.t < cutoff) {
      i++;
    }
    if (i > 0) this._buffer.splice(0, i);

    // Evict by count cap
    const max = this._config.maxEventsPerWindow;
    while (this._buffer.length > max) {
      this._buffer.shift();
    }
  }

  // ---------------------------------------------------------------------------
  // getCurrentContext
  // ---------------------------------------------------------------------------

  getCurrentContext(): FusedContext {
    const windowEnd = Date.now();
    const windowStart = windowEnd - this._config.windowMs;

    const events = this._buffer.filter((e) => e.t >= windowStart);

    // Build channel quality map for all channels
    const channelQualities = {} as Record<InputChannel, ChannelQuality>;
    for (const ch of ALL_INPUT_CHANNELS) {
      const chEvents = events.filter((e) => e.channel === ch);
      channelQualities[ch] = estimateChannelQuality(ch, chEvents, this._env);
    }

    // Dominant channel: highest confidence among channels where sampleRate > 0
    let dominantChannel: InputChannel = 'keyboard';
    let bestConfidence = -1;
    for (const ch of ALL_INPUT_CHANNELS) {
      const q = channelQualities[ch]!;
      if (q.sampleRate > 0 && q.confidence > bestConfidence) {
        bestConfidence = q.confidence;
        dominantChannel = ch;
      }
    }

    // Degraded channels: sampleRate > 0 AND confidence < 0.3
    const degradedChannels: InputChannel[] = ALL_INPUT_CHANNELS.filter((ch) => {
      const q = channelQualities[ch]!;
      return q.sampleRate > 0 && q.confidence < 0.3;
    });

    return {
      window: { startT: windowStart, endT: windowEnd },
      events,
      channelQualities,
      environmentConditions: this._env,
      dominantChannel,
      degradedChannels,
    };
  }

  // ---------------------------------------------------------------------------
  // _emitTick (internal)
  // ---------------------------------------------------------------------------

  private _emitTick(): void {
    const context = this.getCurrentContext();

    if (this._config.compensationRulesEnabled) {
      this._lastWeights = applyCompensation(context.channelQualities, DEFAULT_COMPENSATION_RULES);
      this._lastActiveRuleIds = getActiveRules(
        context.channelQualities,
        DEFAULT_COMPENSATION_RULES,
      ).map((r) => r.id);
    }

    for (const cb of this._contextSubs) {
      cb(context);
    }

    const hypotheses = inferIntent(context);
    const threshold = this._config.intentMinConfidence ?? 0.65;

    for (const h of hypotheses) {
      if (h.confidence >= threshold) {
        this._lastIntent = h;
        for (const cb of this._intentSubs) {
          cb(h);
        }
      }
    }

    this._lastEmittedAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    if (this._timerId !== null) return;
    this._timerId = setInterval(
      () => this._emitTick(),
      this._config.emitIntervalMs ?? 100,
    );
  }

  stop(): void {
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  dispose(): void {
    this.stop();
    this._contextSubs.clear();
    this._intentSubs.clear();
    this._buffer = [];
    this._recentIngestTimes = [];
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  subscribe(cb: (ctx: FusedContext) => void): () => void {
    this._contextSubs.add(cb);
    return () => {
      this._contextSubs.delete(cb);
    };
  }

  subscribeIntent(cb: (h: IntentHypothesis) => void): () => void {
    this._intentSubs.add(cb);
    return () => {
      this._intentSubs.delete(cb);
    };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  getStats(): FusionStats {
    // Prune recentIngestTimes to last 1000ms
    const now = Date.now();
    const cutoff1s = now - 1000;
    this._recentIngestTimes = this._recentIngestTimes.filter((t) => t >= cutoff1s);

    const ctx = this.getCurrentContext();

    const activeChannels = ALL_INPUT_CHANNELS.filter(
      (ch) => ctx.channelQualities[ch]!.sampleRate > 0,
    ).length;

    // dominantChannel is null only when all channels have zero sampleRate
    const anyActive = ALL_INPUT_CHANNELS.some((ch) => ctx.channelQualities[ch]!.sampleRate > 0);

    return {
      totalIngested: this._totalIngested,
      eventsPerSec: this._recentIngestTimes.length,
      activeChannels,
      dominantChannel: anyActive ? ctx.dominantChannel : null,
      degradedChannels: ctx.degradedChannels,
      lastIntent: this._lastIntent,
      lastEmittedAt: this._lastEmittedAt,
    };
  }

  getCompensationWeights(): Record<InputChannel, number> {
    return { ...this._lastWeights };
  }

  getActiveCompensationRules(): string[] {
    return [...this._lastActiveRuleIds];
  }

  setEnvironmentConditions(patch: Partial<EnvironmentConditions>): void {
    this._env = { ...this._env, ...patch };
  }
}
