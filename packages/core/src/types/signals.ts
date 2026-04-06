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
