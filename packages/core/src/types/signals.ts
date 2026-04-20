export enum SignalType {
  SCROLL_VELOCITY = 'SCROLL_VELOCITY',
  CLICK_ACCURACY = 'CLICK_ACCURACY',
  DWELL_TIME = 'DWELL_TIME',
  TYPING_RHYTHM = 'TYPING_RHYTHM',
  BACKSPACE_RATE = 'BACKSPACE_RATE',
  ZOOM_EVENTS = 'ZOOM_EVENTS',
  CURSOR_PATH = 'CURSOR_PATH',
  ERROR_RATE = 'ERROR_RATE',
  READING_SPEED = 'READING_SPEED',
  HESITATION = 'HESITATION',
}

export enum EnvironmentSignalType {
  AMBIENT_LIGHT = 'AMBIENT_LIGHT',
  AMBIENT_NOISE = 'AMBIENT_NOISE',
  NETWORK_QUALITY = 'NETWORK_QUALITY',
  TIME_OF_DAY = 'TIME_OF_DAY',
}

export interface BehaviorSignal {
  type: SignalType;
  value: number;
  timestamp: number;
  /** Normalized value between 0 and 1 */
  normalized: number;
}

export interface StruggleScore {
  /** Overall struggle score from 0 to 100 */
  score: number;
  /** Confidence in the score from 0 to 1 */
  confidence: number;
  signals: BehaviorSignal[];
  timestamp: number;
}

export interface SignalBaseline {
  mean: number;
  stddev: number;
  sampleCount: number;
}

export interface UserBaseline {
  signalBaselines: Map<SignalType, SignalBaseline>;
  lastUpdated: number;
}

export type NetworkQuality = 'poor' | 'fair' | 'good' | 'excellent';
export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';
export type LightingCondition = 'dark' | 'dim' | 'normal' | 'bright';
export type NoiseEnvironment = 'quiet' | 'moderate' | 'noisy' | 'very_noisy';

/** Single point-in-time sample of the user's physical environment. Derived features only — raw images/audio are never included. */
export interface EnvironmentSnapshot {
  /** Normalized ambient brightness 0-1. null if light sampling is disabled or permission denied. */
  lightLevel: number | null;
  /** Normalized ambient noise RMS 0-1. null if audio sampling is disabled or permission denied. */
  noiseLevel: number | null;
  networkQuality: NetworkQuality;
  timeOfDay: TimeOfDay;
  sampledAt: number;
}

/** Running-window aggregate used by downstream consumers for stable adaptation decisions. */
export interface EnvironmentContext {
  latest: EnvironmentSnapshot | null;
  averageLight: number | null;
  averageNoise: number | null;
  /** Variance of the light buffer — high variance hints at flicker / changing conditions. */
  lightVariance: number;
  /** Variance of the noise buffer. */
  noiseVariance: number;
  sampleCount: number;
}
