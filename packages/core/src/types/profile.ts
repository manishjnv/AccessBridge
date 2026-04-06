export interface SensoryProfile {
  fontScale: number;
  contrastLevel: number;
  colorCorrectionMode: 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';
  lineHeight: number;
  letterSpacing: number;
  cursorSize: number;
  reducedMotion: boolean;
  highContrast: boolean;
}

export interface CognitiveProfile {
  focusModeEnabled: boolean;
  readingModeEnabled: boolean;
  textSimplification: 'off' | 'mild' | 'strong';
  notificationLevel: 'all' | 'important' | 'critical' | 'none';
  autoSummarize: boolean;
  distractionShield: boolean;
}

export interface MotorProfile {
  voiceNavigationEnabled: boolean;
  eyeTrackingEnabled: boolean;
  smartClickTargets: boolean;
  predictiveInput: boolean;
  keyboardOnlyMode: boolean;
  dwellClickEnabled: boolean;
  dwellClickDelay: number;
}

export interface AccessibilityProfile {
  id: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  sensory: SensoryProfile;
  cognitive: CognitiveProfile;
  motor: MotorProfile;
  language: string;
  adaptationMode: 'auto' | 'manual' | 'suggest';
  /** Minimum confidence threshold (0-1) for applying adaptations */
  confidenceThreshold: number;
}

export const DEFAULT_SENSORY_PROFILE: SensoryProfile = {
  fontScale: 1.0,
  contrastLevel: 1.0,
  colorCorrectionMode: 'none',
  lineHeight: 1.5,
  letterSpacing: 0,
  cursorSize: 1.0,
  reducedMotion: false,
  highContrast: false,
};

export const DEFAULT_COGNITIVE_PROFILE: CognitiveProfile = {
  focusModeEnabled: false,
  readingModeEnabled: false,
  textSimplification: 'off',
  notificationLevel: 'all',
  autoSummarize: false,
  distractionShield: false,
};

export const DEFAULT_MOTOR_PROFILE: MotorProfile = {
  voiceNavigationEnabled: false,
  eyeTrackingEnabled: false,
  smartClickTargets: false,
  predictiveInput: false,
  keyboardOnlyMode: false,
  dwellClickEnabled: false,
  dwellClickDelay: 800,
};

export const DEFAULT_PROFILE: AccessibilityProfile = {
  id: 'default',
  version: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  sensory: { ...DEFAULT_SENSORY_PROFILE },
  cognitive: { ...DEFAULT_COGNITIVE_PROFILE },
  motor: { ...DEFAULT_MOTOR_PROFILE },
  language: 'en',
  adaptationMode: 'suggest',
  confidenceThreshold: 0.6,
};
