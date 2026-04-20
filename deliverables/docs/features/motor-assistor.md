# Motor Assistor

**Status:** Planned  
**Package:** `@accessbridge/extension` (planned)  
**Target:** Day 3 of sprint

## Overview

The Motor Assistor helps users with motor impairments navigate and interact with web applications. It provides voice navigation, enlarged click targets, eye tracking, keyboard-only mode, predictive input, dwell click, and gesture shortcuts.

## Features

### Voice Navigation (Web Speech API)

**Purpose:** Allows users to navigate and interact with web pages using voice commands instead of mouse or keyboard.

**How it works:**
- Uses the Web Speech API (`SpeechRecognition`) for continuous speech recognition
- Maintains a command vocabulary mapped to page actions:
  - **Navigation:** "scroll down", "scroll up", "go back", "go forward", "go to top", "go to bottom"
  - **Interaction:** "click [element]", "type [text]", "select [option]", "submit", "cancel"
  - **Accessibility:** "read this", "summarize", "simplify", "focus mode on/off"
  - **System:** "undo", "redo", "help", "stop listening"
- Elements are labeled with floating number badges when voice mode is active (e.g., "click 3" clicks the third interactive element)
- Fuzzy matching for element identification: "click the blue button" matches elements by color, text content, and aria-labels

**Technical approach:**
```
Speech Input ──> SpeechRecognition API ──> Command Parser ──> Action Dispatcher
                                               |
                                      Fuzzy Element Matcher
```

**Fallback:** If Web Speech API is unavailable (Firefox, some Linux distros), the feature is disabled with a notification. A future version may use a local Whisper model.

### Smart Click Targets

**Purpose:** Enlarges interactive elements that are too small to click accurately.

**How it works:**
- Scans the page for interactive elements (`<a>`, `<button>`, `[role="button"]`, `<input>`, `<select>`)
- Measures each element's bounding box against WCAG 2.5.8 minimum target size (24x24 CSS pixels)
- Elements below the threshold receive:
  - Expanded padding to meet minimum size
  - A subtle visual indicator (thin outline) so the user can see the enlarged area
  - `::before` pseudo-element hit area expansion for elements where padding would break layout

**Trigger:** Struggle score > 60 and click accuracy < 0.3.

**Gmail-specific:** The Gmail adapter targets known small elements: `.T-I` (toolbar buttons), `.asa` (action icons), `.aim .TN` (sidebar items), expanding them to minimum 40x40px.

### Eye Tracking (MediaPipe)

**Purpose:** Enables gaze-based navigation for users who cannot use a mouse or keyboard.

**How it works:**
- Uses MediaPipe Face Mesh via the user's webcam to track eye gaze direction
- Maps gaze coordinates to screen position using a calibration step (9-point grid)
- Gaze position is visualized with a subtle circular indicator
- Gaze-based interactions:
  - **Gaze hover:** Dwelling on an element for a configurable duration triggers a highlight
  - **Gaze click:** Extended dwell (configurable, default 800ms) triggers a click
  - **Gaze scroll:** Looking at the top/bottom edge of the viewport triggers scrolling

**Privacy:** Camera access is requested only when eye tracking is explicitly enabled. No video frames leave the browser -- all processing is done locally via MediaPipe's WASM runtime. The camera indicator light remains on while tracking is active.

**Requirements:** Webcam access, sufficient lighting, Chrome or Edge (for MediaPipe WASM support).

### Keyboard-Only Mode

**Purpose:** Ensures every interactive element on the page is reachable and usable via keyboard alone.

**How it works:**
- Audits the page for interactive elements missing `tabindex` and adds them to the tab order
- Adds visible focus indicators (high-contrast outline) that override the site's focus styles
- Implements arrow-key navigation within component groups (menus, toolbars, tab lists)
- Adds keyboard shortcuts for common actions:
  - `Alt+S` -- toggle sidebar/focus mode
  - `Alt+R` -- toggle reading mode
  - `Alt+V` -- toggle voice navigation
  - `Esc` -- dismiss overlays, revert last adaptation
- Skip-to-content link is injected at the top of the page if not already present

### Predictive Input

**Purpose:** Reduces the number of keystrokes needed to complete text input.

**How it works:**
- Monitors text input fields for typing activity
- After a configurable delay (default: 300ms of inactivity), generates completion suggestions
- Uses the AI engine (local tier for speed, low-cost tier for quality):
  - Local: Simple prefix matching against common phrases and the user's typing history
  - Low-cost: Gemini Flash for context-aware sentence completion
- Suggestions appear in a dropdown below the input field
- Accept with `Tab`, dismiss with `Esc`, cycle with arrow keys

**Privacy:** Typing history for local predictions is stored in IndexedDB with AES-GCM encryption. Remote AI predictions use the user's own API keys.

### Dwell Click

**Purpose:** Allows users to click by hovering over an element for a set duration, eliminating the need for physical click actions.

**How it works:**
- When enabled, a circular progress indicator appears around the cursor
- Hovering over an interactive element starts the dwell timer
- Moving the cursor more than 10px resets the timer
- When the timer completes (default: 800ms, configurable 200-2000ms), a click event is dispatched
- Audio feedback (short tick) confirms the click
- A brief cooldown (300ms) prevents accidental double-clicks

**Configuration:**
```typescript
interface MotorProfile {
  dwellClickEnabled: boolean;  // false default
  dwellClickDelay: number;     // 800ms default (200-2000ms range)
}
```

### Gesture Shortcuts

**Purpose:** Maps simple mouse gestures to common actions for users who can move a mouse but find clicking difficult.

**Planned gestures:**
- **Circle clockwise:** Scroll down
- **Circle counter-clockwise:** Scroll up
- **Swipe right:** Go forward
- **Swipe left:** Go back
- **Zigzag (Z shape):** Undo last action
- **L shape:** Open AccessBridge popup

**Technical approach:**
- Track mouse movement path as a series of direction changes
- Match against gesture templates using a simplified $1 Unistroke Recognizer
- Require minimum path length to avoid accidental gesture recognition

## Configuration

```typescript
interface MotorProfile {
  voiceNavigationEnabled: boolean;   // false default
  eyeTrackingEnabled: boolean;       // false default
  smartClickTargets: boolean;        // false default
  predictiveInput: boolean;          // false default
  keyboardOnlyMode: boolean;         // false default
  dwellClickEnabled: boolean;        // false default
  dwellClickDelay: number;           // 800ms default
}
```

## Integration with Decision Engine

The Decision Engine includes rules that trigger motor adaptations:

| Condition | Adaptation |
|-----------|-----------|
| `struggle > 60 && clickAccuracy < 0.3` | Click Target Enlarge (1.5x) |
| `struggle > 70 && cursorPath > 0.7` | Cursor Size (1.5x) |
| `struggle > 50 && scrollVelocity > 0.7` | Layout Simplify |

Additional rules for voice navigation and eye tracking activation are planned. These will likely require higher confidence thresholds (0.7+) since they involve more intrusive changes to the interaction model.

## Accessibility Standards

Motor Assistor features are designed to meet or exceed:
- **WCAG 2.1 Level AAA** 2.5.8 (Target Size minimum 24x24 CSS pixels)
- **WCAG 2.1 Level A** 2.1.1 (Keyboard accessible)
- **WCAG 2.1 Level A** 2.1.2 (No keyboard trap)
- **WCAG 2.1 Level AAA** 2.1.3 (Keyboard - no exception)
