export enum AdaptationType {
  FONT_SCALE = 'FONT_SCALE',
  CONTRAST = 'CONTRAST',
  COLOR_CORRECTION = 'COLOR_CORRECTION',
  LINE_HEIGHT = 'LINE_HEIGHT',
  LETTER_SPACING = 'LETTER_SPACING',
  LAYOUT_SIMPLIFY = 'LAYOUT_SIMPLIFY',
  TEXT_SIMPLIFY = 'TEXT_SIMPLIFY',
  FOCUS_MODE = 'FOCUS_MODE',
  READING_MODE = 'READING_MODE',
  CLICK_TARGET_ENLARGE = 'CLICK_TARGET_ENLARGE',
  VOICE_NAV = 'VOICE_NAV',
  EYE_TRACKING = 'EYE_TRACKING',
  CURSOR_SIZE = 'CURSOR_SIZE',
  REDUCED_MOTION = 'REDUCED_MOTION',
  AUTO_SUMMARIZE = 'AUTO_SUMMARIZE',
  LANGUAGE_SWITCH = 'LANGUAGE_SWITCH',
}

export interface Adaptation {
  id: string;
  type: AdaptationType;
  value: unknown;
  /** Confidence in this adaptation from 0 to 1 */
  confidence: number;
  applied: boolean;
  timestamp: number;
  reversible: boolean;
}

export interface AdaptationRule {
  condition: string;
  adaptationType: AdaptationType;
  value: unknown;
  priority: number;
  minConfidence: number;
}
