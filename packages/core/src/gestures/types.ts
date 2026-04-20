export type GestureType =
  | 'swipe-left'
  | 'swipe-right'
  | 'swipe-up'
  | 'swipe-down'
  | 'circle-cw'
  | 'circle-ccw'
  | 'zigzag'
  | 'two-finger-tap'
  | 'three-finger-tap'
  | 'double-tap'
  | 'triple-tap'
  | 'long-press'
  | 'pinch-in'
  | 'pinch-out'
  | 'two-finger-swipe-left'
  | 'two-finger-swipe-right';

export interface PointerEvent2D {
  x: number;
  y: number;
  t: number;
  pointerId: number;
  pressure?: number;
}

export interface GestureStroke {
  points: PointerEvent2D[];
  durationMs: number;
  fingerCount: number;
}

export interface RecognizedGesture {
  type: GestureType;
  confidence: number;
  stroke: GestureStroke;
}

export type GestureActionCategory = 'navigation' | 'accessibility' | 'ai' | 'custom';

export interface GestureAction {
  id: string;
  name: string;
  description: string;
  category: GestureActionCategory;
}

export interface GestureBinding {
  gesture: GestureType;
  actionId: string;
  enabled: boolean;
}

export const GESTURE_TYPES: readonly GestureType[] = [
  'swipe-left',
  'swipe-right',
  'swipe-up',
  'swipe-down',
  'circle-cw',
  'circle-ccw',
  'zigzag',
  'two-finger-tap',
  'three-finger-tap',
  'double-tap',
  'triple-tap',
  'long-press',
  'pinch-in',
  'pinch-out',
  'two-finger-swipe-left',
  'two-finger-swipe-right',
];

export const DEFAULT_GESTURE_BINDINGS: GestureBinding[] = [
  { gesture: 'swipe-left', actionId: 'back', enabled: true },
  { gesture: 'swipe-right', actionId: 'forward', enabled: true },
  { gesture: 'swipe-up', actionId: 'scroll-to-top', enabled: true },
  { gesture: 'swipe-down', actionId: 'scroll-to-bottom', enabled: true },
  { gesture: 'circle-cw', actionId: 'increase-font', enabled: true },
  { gesture: 'circle-ccw', actionId: 'decrease-font', enabled: true },
  { gesture: 'two-finger-tap', actionId: 'read-aloud-selection', enabled: true },
  { gesture: 'three-finger-tap', actionId: 'toggle-focus-mode', enabled: true },
  { gesture: 'double-tap', actionId: 'click', enabled: true },
  { gesture: 'triple-tap', actionId: 'triple-click', enabled: true },
  { gesture: 'long-press', actionId: 'right-click', enabled: true },
  { gesture: 'pinch-in', actionId: 'zoom-out', enabled: true },
  { gesture: 'pinch-out', actionId: 'zoom-in', enabled: true },
  { gesture: 'two-finger-swipe-left', actionId: 'previous-tab', enabled: true },
  { gesture: 'two-finger-swipe-right', actionId: 'next-tab', enabled: true },
  { gesture: 'zigzag', actionId: 'cancel', enabled: true },
];
