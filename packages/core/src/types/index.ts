export type {
  SensoryProfile,
  CognitiveProfile,
  MotorProfile,
  AccessibilityProfile,
} from './profile.js';

export {
  DEFAULT_SENSORY_PROFILE,
  DEFAULT_COGNITIVE_PROFILE,
  DEFAULT_MOTOR_PROFILE,
  DEFAULT_PROFILE,
} from './profile.js';

export { SignalType, EnvironmentSignalType } from './signals.js';

export type {
  BehaviorSignal,
  StruggleScore,
  SignalBaseline,
  UserBaseline,
  EnvironmentSnapshot,
  EnvironmentContext,
  NetworkQuality,
  TimeOfDay,
  LightingCondition,
  NoiseEnvironment,
} from './signals.js';

export { AdaptationType } from './adaptation.js';

export type { Adaptation, AdaptationRule } from './adaptation.js';
