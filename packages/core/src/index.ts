export type {
  SensoryProfile,
  CognitiveProfile,
  MotorProfile,
  AccessibilityProfile,
  BehaviorSignal,
  StruggleScore,
  SignalBaseline,
  UserBaseline,
  Adaptation,
  AdaptationRule,
} from './types/index.js';

export {
  DEFAULT_SENSORY_PROFILE,
  DEFAULT_COGNITIVE_PROFILE,
  DEFAULT_MOTOR_PROFILE,
  DEFAULT_PROFILE,
  SignalType,
  AdaptationType,
} from './types/index.js';

export { ProfileStore } from './profile/index.js';
export { StruggleDetector } from './signals/index.js';
export { DecisionEngine } from './decision/index.js';

export {
  VisionRecoveryEngine,
  DEFAULT_VISION_CONFIG,
  composeHeuristicLabel,
  inferRoleFromClass,
  inferLabelFromSiblingContext,
  inferIconLabel,
  inferButtonFromPosition,
  ICON_LEXICON,
} from './vision/index.js';

export type {
  UnlabeledElement,
  RecoveredLabel,
  VisionRecoveryConfig,
  RecoveryCache,
  ApiVisionClient,
} from './vision/index.js';
