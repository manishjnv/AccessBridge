export interface SensoryProfile {
  fontScale: number;
  contrastLevel: number;
  colorCorrectionMode: 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';
  lineHeight: number;
  letterSpacing: number;
  cursorSize: number;
  reducedMotion: boolean;
  highContrast: boolean;
  // --- Priority 1: Captions + Actions ---
  /** When true, overlay Web Speech API live captions on visible <video> elements. Opt-in. */
  liveCaptionsEnabled: boolean;
  /** BCP-47 language tag for caption recognition (e.g. 'en-US', 'hi-IN'). Empty = auto-detect. */
  captionsLanguage: string;
  /** Optional BCP-47 target language for live translation; null disables translation. */
  captionsTranslateTo: string | null;
  /** Overlay font size in px (12-32). */
  captionsFontSize: number;
  /** Overlay vertical position. */
  captionsPosition: 'top' | 'bottom';
  // --- Session 10: Vision-Assisted Semantic Recovery ---
  /** Master toggle for vision-based semantic-recovery of unlabeled UI elements. */
  visionRecoveryEnabled: boolean;
  /** Re-scan on DOM mutations. Off means on-demand only. */
  visionRecoveryAutoScan: boolean;
  /** Opt-in Tier-2 AI-engine inference for low-confidence elements. Costs API calls. */
  visionRecoveryTier2APIEnabled: boolean;
  /** Visually outline auto-recovered elements with a dotted border. */
  visionRecoveryHighlightRecovered: boolean;
  /** Minimum confidence (0-1) below which a recovered label is discarded. */
  visionRecoveryMinConfidence: number;
}

export interface CognitiveProfile {
  focusModeEnabled: boolean;
  readingModeEnabled: boolean;
  textSimplification: 'off' | 'mild' | 'strong';
  notificationLevel: 'all' | 'important' | 'critical' | 'none';
  autoSummarize: boolean;
  distractionShield: boolean;
  // --- Priority 1: Captions + Actions ---
  /** When true, passively scan page text for action items (TODOs, deadlines, imperative sentences). On by default. */
  actionItemsEnabled: boolean;
  /** When true, re-scan as the DOM changes via MutationObserver. Off means on-demand only. */
  actionItemsAutoScan: boolean;
  /** Minimum confidence (0-1) for surfacing an extracted item. Lower = noisier. */
  actionItemsMinConfidence: number;
  // --- Priority 5: Time-Awareness + Distraction Shield deepening ---
  /** When true, detect hyperfocus (45+ min continuous activity) and show a gentle break reminder. On by default. */
  timeAwarenessEnabled: boolean;
  /**
   * Deepened distractionShield: when the user is in a detected flow state
   * (sustained typing + low error rate), queue non-urgent Chrome notifications
   * until flow ends. Requires `distractionShield` to be enabled first.
   */
  flowAwareNotifications: boolean;
}

export interface MotorProfile {
  voiceNavigationEnabled: boolean;
  eyeTrackingEnabled: boolean;
  smartClickTargets: boolean;
  predictiveInput: boolean;
  keyboardOnlyMode: boolean;
  dwellClickEnabled: boolean;
  dwellClickDelay: number;
  /** Task C: recognize mouse/touch/trackpad gestures and dispatch bound actions. */
  gestureShortcutsEnabled: boolean;
  /** Task C: briefly show a bottom-right indicator when a gesture is recognized. */
  gestureShowHints: boolean;
  /** Task C: require holding Shift for mouse-driven gestures (prevents accidental activation). */
  gestureMouseModeRequiresShift: boolean;
}

export interface AccessibilityProfile {
  id: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  sensory: SensoryProfile;
  cognitive: CognitiveProfile;
  motor: MotorProfile;
  /** Primary spoken language (ISO 639-1 or BCP-47 short form). */
  language: string;
  /** When true, detect page language from unicode ranges and override voice recognition locale. */
  autoDetectLanguage: boolean;
  /** When true, enable Latin → Indic transliteration in input fields (Alt+T to toggle). */
  transliterationEnabled: boolean;
  /** Target script for transliteration. */
  transliterationScript: 'devanagari' | 'tamil' | 'telugu' | 'kannada';
  adaptationMode: 'auto' | 'manual' | 'suggest';
  /** Minimum confidence threshold (0-1) for applying adaptations */
  confidenceThreshold: number;
  /**
   * Opt-in: publish anonymous, differentially-private daily counters to the
   * Compliance Observatory. Off by default. Never transmits identity, content, URLs, or IP.
   */
  shareAnonymousMetrics: boolean;
  /** Master opt-in for ambient environment sensing (webcam light + mic noise). Off by default. */
  environmentSensingEnabled: boolean;
  /** Sample ambient light via webcam every 30s. Applies only when environmentSensingEnabled is true. */
  environmentLightSampling: boolean;
  /** Sample ambient noise via microphone every 15s. Applies only when environmentSensingEnabled is true. */
  environmentNoiseSampling: boolean;
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
  // --- Priority 1: Captions + Actions ---
  liveCaptionsEnabled: false,
  captionsLanguage: '',
  captionsTranslateTo: null,
  captionsFontSize: 18,
  captionsPosition: 'bottom',
  // --- Session 10: Vision-Assisted Semantic Recovery ---
  visionRecoveryEnabled: true,
  visionRecoveryAutoScan: true,
  visionRecoveryTier2APIEnabled: false,
  visionRecoveryHighlightRecovered: false,
  visionRecoveryMinConfidence: 0.6,
};

export const DEFAULT_COGNITIVE_PROFILE: CognitiveProfile = {
  focusModeEnabled: false,
  readingModeEnabled: false,
  textSimplification: 'off',
  notificationLevel: 'all',
  autoSummarize: false,
  distractionShield: false,
  // --- Priority 1: Captions + Actions ---
  actionItemsEnabled: true,
  actionItemsAutoScan: true,
  actionItemsMinConfidence: 0.5,
  // --- Priority 5: Time-Awareness + flow-aware notifications ---
  timeAwarenessEnabled: true,
  flowAwareNotifications: false,
};

export const DEFAULT_MOTOR_PROFILE: MotorProfile = {
  voiceNavigationEnabled: false,
  eyeTrackingEnabled: false,
  smartClickTargets: false,
  predictiveInput: false,
  keyboardOnlyMode: false,
  dwellClickEnabled: false,
  dwellClickDelay: 800,
  gestureShortcutsEnabled: false,
  gestureShowHints: true,
  gestureMouseModeRequiresShift: true,
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
  autoDetectLanguage: false,
  transliterationEnabled: false,
  transliterationScript: 'devanagari',
  adaptationMode: 'suggest',
  confidenceThreshold: 0.6,
  shareAnonymousMetrics: false,
  environmentSensingEnabled: false,
  environmentLightSampling: true,
  environmentNoiseSampling: true,
};
