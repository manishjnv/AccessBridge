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
  // --- Session 17: IndicWhisper tiered STT ---
  /**
   * STT tier preference. Auto = Tier A (Web Speech) first, fall back to B
   * (IndicWhisper ONNX) on language gap / low confidence, Tier C (cloud)
   * only when `cloud-allowed`. `native` forces A, `onnx` forces B.
   */
  voiceQualityTier: 'auto' | 'native' | 'onnx' | 'cloud-allowed';
  /** Opt-in: download + use the IndicWhisper ~80 MB ONNX for Tier B STT. Default false. */
  indicWhisperEnabled: boolean;
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
  // --- Session 11: Multi-Modal Fusion (Layer 5) ---
  /** Master toggle for unified multi-channel event fusion + intent inference. Core value, opt-out. */
  fusionEnabled: boolean;
  /** Sliding window size in milliseconds. 1000-10000. */
  fusionWindowMs: number;
  /** Enable cross-modal compensation rules (degraded channel → boost alternatives). */
  fusionCompensationEnabled: boolean;
  /** Minimum confidence (0.3-0.9) at which an inferred intent triggers an adaptation. */
  fusionIntentMinConfidence: number;
  // --- Session 12: On-Device ONNX Models ---
  /**
   * Opt-in toggles for each model tier (0 always-on, 1 embeddings, 2 summarizer,
   * 3 IndicWhisper STT). Session 17 adds `indicWhisper`.
   */
  onnxModelsEnabled: {
    struggleClassifier: boolean;
    embeddings: boolean;
    summarizer: boolean;
    indicWhisper: boolean;
  };
  /** Allow model downloads on metered networks. Defaults off; saves user bandwidth. */
  onnxDownloadOnMeteredNetwork: boolean;
  /** Debug: force all ONNX calls to fail so the heuristic path runs. Useful for demos. */
  onnxForceFallback: boolean;
  // --- Session 16: Zero-Knowledge Attestation (Feature #7) ---
  /** Device is enrolled in the observatory ring (public key submitted). */
  observatoryEnrolled: boolean;
  /** Ring version the device last synced; re-enroll if the server's version diverges. */
  observatoryRingVersion: number;
  /** Cached key image hex for the current publish date; null outside the active publish day. */
  observatoryKeyImage: string | null;
  /** Date (YYYY-MM-DD) the cached keyImage belongs to; null when unset. */
  observatoryKeyImageDate: string | null;
  // --- Session 24: Team deployment pilot tagging ---
  /**
   * Optional pilot cohort identifier set by a Team install script or by
   * managed policy. When set, included in daily observatory attestations so
   * the orchestrator can aggregate pilot-level metrics. Null when the device
   * is not part of any pilot. This is a group identifier — never personal.
   *
   * Format: `^[a-z0-9][a-z0-9-]{0,63}$` — lowercase alphanumeric + hyphens,
   * 1-64 chars, must start with alphanumeric. Rejects path traversal,
   * shell metacharacters, Unicode bidi overrides, control chars.
   */
  pilotId: string | null;
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
  // --- Session 17: IndicWhisper tiered STT ---
  voiceQualityTier: 'auto',
  indicWhisperEnabled: false,
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
  // --- Session 11: Multi-Modal Fusion (Layer 5) ---
  fusionEnabled: true,
  fusionWindowMs: 3000,
  fusionCompensationEnabled: true,
  fusionIntentMinConfidence: 0.65,
  // --- Session 12: On-Device ONNX Models ---
  onnxModelsEnabled: {
    struggleClassifier: true,
    embeddings: false,
    summarizer: false,
    indicWhisper: false,
  },
  onnxDownloadOnMeteredNetwork: false,
  onnxForceFallback: false,
  // --- Session 16: Zero-Knowledge Attestation (Feature #7) ---
  observatoryEnrolled: false,
  observatoryRingVersion: 0,
  observatoryKeyImage: null,
  observatoryKeyImageDate: null,
  // --- Session 24: Team deployment pilot tagging ---
  pilotId: null,
};

/**
 * Session 24: pilot_id format gate.
 * Lowercase alphanumeric + hyphens, 1-64 chars, must start with alphanumeric.
 * Rejects: uppercase (collision risk with enum keys), whitespace, control
 * chars, Unicode bidi overrides (RCA BUG-015/Session-23 sanitizeLabel pattern),
 * shell metacharacters, path traversal (`.`, `..`, `/`, `\`).
 *
 * Used by enterprise/policy.ts when parsing `pilotId` from managed storage,
 * and by observatory-publisher.ts before including pilot_id in bundles.
 */
export const PILOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Returns true if `v` is a string that matches PILOT_ID_PATTERN. */
export function isValidPilotId(v: unknown): v is string {
  return typeof v === 'string' && PILOT_ID_PATTERN.test(v);
}
