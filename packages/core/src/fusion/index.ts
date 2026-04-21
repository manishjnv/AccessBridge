/**
 * Layer 5: Multi-Modal Fusion — unified event stream, cross-modal compensation,
 * intent inference. All fusion runs on-device; raw per-event payloads never
 * leave the browser.
 */

export type {
  InputChannel,
  ChannelQuality,
  ChannelQualityMap,
  UnifiedEvent,
  IngestEvent,
  EnvironmentConditions,
  FusedContext,
  IntentType,
  IntentHypothesis,
  CrossModalCompensationRule,
  FusionEngineConfig,
  FusionStats,
} from './types.js';

export {
  ALL_INPUT_CHANNELS,
  ALL_INTENT_TYPES,
  DEFAULT_FUSION_CONFIG,
} from './types.js';

export { estimateChannelQuality } from './quality-estimator.js';
export {
  applyCompensation,
  getActiveRules,
  DEFAULT_COMPENSATION_RULES,
} from './compensator.js';
export { inferIntent } from './intent-inference.js';
export { FusionEngine } from './fusion-engine.js';
