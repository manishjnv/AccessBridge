# Cognitive Simplifier

**Status:** Planned  
**Package:** `@accessbridge/extension` (planned)  
**Target:** Day 2-3 of sprint

## Overview

The Cognitive Simplifier reduces cognitive load for users who struggle with complex web interfaces. It provides focus mode to eliminate distractions, reading mode for clean content consumption, AI-powered email summarization, document simplification, and smart notification filtering.

## Features

### Focus Mode

**Purpose:** Strips non-essential UI elements to help users concentrate on their primary task.

**How it works:**
- Identifies the user's current task context (reading an email, composing a message, browsing a document)
- Dims or hides peripheral UI elements: sidebars, chat widgets, promotional banners, social feeds
- Maintains a "focus tunnel" around the primary content area
- App-specific adapters (Gmail, Outlook) know which DOM elements to target for maximum effect with minimum breakage

**Trigger:** Struggle score > 55 and hesitation signal > 0.6, or manually activated via popup.

**Technical approach:**
- CSS `opacity` and `display` overrides on identified distraction elements
- Gmail-specific: hides `.aeN` (sidebar), `.aj3` (chat), `[role="complementary"]`
- Generic: hides elements matching common distraction patterns (cookie banners, newsletter popups, fixed-position ads)
- Reversible: all changes tracked and cleanly removable

### Reading Mode

**Purpose:** Transforms cluttered web pages into clean, readable documents.

**How it works:**
- Extracts the main content element using semantic selectors (`<main>`, `<article>`, `[role="main"]`)
- Applies dyslexia-friendly typography: OpenDyslexic or similar font, increased line height (1.8-2.0), wider letter spacing
- Constrains content width to 65-75 characters per line (optimal for readability research)
- Removes background images, complex borders, and decorative elements
- Converts multi-column layouts to single-column flow

**Trigger:** Struggle score > 65 and error rate > 0.6, or manually activated.

### Email Summarization

**Purpose:** Condenses long email threads into key points so users can quickly understand the conversation.

**How it works:**
1. Detects email content in Gmail or Outlook using app-specific adapters
2. Extracts the email thread, deduplicating quoted replies
3. Sends to the AI engine (prefers low-cost tier for speed)
4. Displays a summary card above the email with:
   - 2-3 bullet point summary
   - Action items extracted from the thread
   - Sentiment indicator (neutral/urgent/informational)
5. Original email remains accessible -- the summary is an overlay, not a replacement

**Privacy:** Email content is processed through the user's own API keys. No email data touches AccessBridge servers.

### Document Simplification

**Purpose:** Rewrites complex text at a lower reading level while preserving meaning.

**How it works:**
1. User highlights text or activates simplification on the current page
2. The AI engine processes the text with a simplification prompt
3. Simplified text is displayed in a tooltip or inline replacement (user choice)
4. Three levels of simplification:
   - **Mild:** Shorter sentences, simpler vocabulary, same structure
   - **Strong:** Elementary reading level, bullet points, definitions for jargon
   - **Visual:** Adds icons and whitespace, breaks content into digestible chunks

**Trigger:** Struggle score > 60 and backspace rate > 0.6 (suggesting the user is re-reading or struggling with input), or manually activated.

### Distraction Shield

**Purpose:** Proactively blocks distracting elements before they capture attention.

**How it works:**
- Monitors DOM mutations for newly inserted elements (ads, popups, notifications)
- Classifies each new element as distraction vs. content using heuristics:
  - Fixed/sticky positioning outside the main content area
  - `z-index` above a threshold
  - Common ad network class names and data attributes
  - Animation or transition properties on non-content elements
- Distracting elements are hidden with `display: none` before they render
- A counter in the popup shows how many distractions were blocked this session

### Smart Notification Filtering

**Purpose:** Reduces notification fatigue by filtering based on importance.

**How it works:**
- Intercepts browser notification permission requests and web-based notification elements
- Four filter levels (configured in the Cognitive profile):
  - **All:** No filtering (default)
  - **Important:** Blocks promotional and low-priority notifications
  - **Critical:** Only allows error states and explicit user mentions
  - **None:** Blocks all notifications
- Uses the AI engine (local tier) to classify notification text as informational, promotional, or critical
- Suppressed notifications are logged in the sidepanel for later review

## Configuration

```typescript
interface CognitiveProfile {
  focusModeEnabled: boolean;           // false default
  readingModeEnabled: boolean;         // false default
  textSimplification: 'off' | 'mild' | 'strong';
  notificationLevel: 'all' | 'important' | 'critical' | 'none';
  autoSummarize: boolean;             // false default
  distractionShield: boolean;         // false default
}
```

## Integration with Decision Engine

The Decision Engine includes rules that trigger cognitive adaptations:

| Condition | Adaptation |
|-----------|-----------|
| `struggle > 55 && hesitation > 0.6` | Focus Mode |
| `struggle > 60 && backspaceRate > 0.6` | Text Simplify (mild) |
| `struggle > 65 && errorRate > 0.6` | Reading Mode |
| `struggle > 70 && dwellTime > 0.7` | Auto Summarize |

These rules ensure that cognitive aids activate when behavioral signals suggest the user needs them, without requiring manual activation.
