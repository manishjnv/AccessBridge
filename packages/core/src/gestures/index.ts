export type {
  GestureType,
  PointerEvent2D,
  GestureStroke,
  RecognizedGesture,
  GestureActionCategory,
  GestureAction,
  GestureBinding,
} from './types.js';

export { GESTURE_TYPES, DEFAULT_GESTURE_BINDINGS } from './types.js';

export {
  detectSwipeDirection,
  detectCircle,
  detectZigzag,
  detectTapCount,
  detectLongPress,
  detectPinch,
  detectTwoFingerSwipe,
  recognize,
} from './recognizer.js';

export { GESTURE_ACTIONS, getActionById } from './actions.js';

export { GestureBindingStore } from './bindings.js';
