/**
 * Multi-Modal Fusion (Layer 5) — shared type contracts.
 *
 * All fusion runs on-device; raw per-event payloads never leave the browser.
 * Downstream modules (quality-estimator, compensator, intent-inference,
 * fusion-engine) depend solely on these types — no DOM, no chrome.* APIs here.
 */

export type InputChannel =
  | 'keyboard'
  | 'mouse'
  | 'gaze'
  | 'voice'
  | 'touch'
  | 'pointer'
  | 'screen'
  | 'env-light'
  | 'env-noise'
  | 'env-network';

export const ALL_INPUT_CHANNELS: readonly InputChannel[] = [
  'keyboard',
  'mouse',
  'gaze',
  'voice',
  'touch',
  'pointer',
  'screen',
  'env-light',
  'env-noise',
  'env-network',
];

/**
 * Per-channel runtime quality snapshot. Confidence is how trustable the channel
 * currently is (signal strength + sample density); noise is the inverse-SNR-like
 * term used by the compensator; sampleRate is observed events-per-second in the
 * current window; lastSampledAt is a monotonic ms timestamp.
 */
export interface ChannelQuality {
  channel: InputChannel;
  confidence: number;
  noise: number;
  sampleRate: number;
  lastSampledAt: number;
}

/**
 * A single time-aligned input event in the unified stream. `t` is a monotonic
 * millisecond timestamp (performance.now() or Date.now() — caller picks, just
 * stay consistent per engine instance). `type` is channel-specific (e.g. for
 * 'keyboard': 'keydown'/'keyup'; for 'voice': 'interim'/'final'). `quality` is
 * the quality assigned at ingest time, 0-1.
 */
export interface UnifiedEvent {
  id: string;
  t: number;
  channel: InputChannel;
  type: string;
  data: Record<string, unknown>;
  quality: number;
}

export interface EnvironmentConditions {
  lighting: string;
  noise: string;
  network: string;
  timeOfDay: string;
}

/**
 * The result of one sliding-window fusion tick.
 */
export interface FusedContext {
  window: { startT: number; endT: number };
  events: UnifiedEvent[];
  channelQualities: Record<InputChannel, ChannelQuality>;
  environmentConditions: EnvironmentConditions;
  dominantChannel: InputChannel;
  degradedChannels: InputChannel[];
}

export type IntentType =
  | 'click-imminent'
  | 'scroll-continuation'
  | 'reading'
  | 'hesitation'
  | 'searching'
  | 'typing'
  | 'abandoning'
  | 'help-seeking';

export const ALL_INTENT_TYPES: readonly IntentType[] = [
  'click-imminent',
  'scroll-continuation',
  'reading',
  'hesitation',
  'searching',
  'typing',
  'abandoning',
  'help-seeking',
];

export interface IntentHypothesis {
  intent: IntentType;
  confidence: number;
  supportingEvents: string[];
  suggestedAdaptations: string[];
}

export type ChannelQualityMap = Record<InputChannel, ChannelQuality>;

/**
 * A compensation rule: when a degraded channel is detected, boost the listed
 * channels by `factor` (>1 boost, <1 suppress). `condition` is a pure predicate
 * over the current quality map.
 */
export interface CrossModalCompensationRule {
  id: string;
  degraded: InputChannel;
  boost: InputChannel[];
  factor: number;
  condition: (qualities: ChannelQualityMap) => boolean;
  description?: string;
}

export interface FusionEngineConfig {
  windowMs: number;
  maxEventsPerWindow: number;
  compensationRulesEnabled: boolean;
  emitIntervalMs?: number;
  intentMinConfidence?: number;
}

export const DEFAULT_FUSION_CONFIG: FusionEngineConfig = {
  windowMs: 3000,
  maxEventsPerWindow: 500,
  compensationRulesEnabled: true,
  emitIntervalMs: 100,
  intentMinConfidence: 0.65,
};

/**
 * Minimum event payload accepted by FusionEngine.ingest(). The engine assigns
 * id + quality before pushing to the ring buffer.
 */
export type IngestEvent = Omit<UnifiedEvent, 'id' | 'quality'>;

export interface FusionStats {
  totalIngested: number;
  eventsPerSec: number;
  activeChannels: number;
  dominantChannel: InputChannel | null;
  degradedChannels: InputChannel[];
  lastIntent: IntentHypothesis | null;
  lastEmittedAt: number;
}
