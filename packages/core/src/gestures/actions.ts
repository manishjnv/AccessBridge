import type { GestureAction } from './types.js';

export const GESTURE_ACTIONS: GestureAction[] = [
  // Navigation (9)
  { id: 'back', name: 'Back', description: 'Navigate to the previous page.', category: 'navigation' },
  { id: 'forward', name: 'Forward', description: 'Navigate to the next page.', category: 'navigation' },
  { id: 'scroll-to-top', name: 'Scroll to Top', description: 'Smoothly scroll to the top of the page.', category: 'navigation' },
  { id: 'scroll-to-bottom', name: 'Scroll to Bottom', description: 'Smoothly scroll to the bottom of the page.', category: 'navigation' },
  { id: 'next-tab', name: 'Next Tab', description: 'Switch to the next browser tab.', category: 'navigation' },
  { id: 'previous-tab', name: 'Previous Tab', description: 'Switch to the previous browser tab.', category: 'navigation' },
  { id: 'reload', name: 'Reload', description: 'Reload the current page.', category: 'navigation' },
  { id: 'new-tab', name: 'New Tab', description: 'Open a new browser tab.', category: 'navigation' },
  { id: 'close-tab', name: 'Close Tab', description: 'Close the current tab.', category: 'navigation' },

  // Accessibility (8)
  { id: 'toggle-focus-mode', name: 'Toggle Focus Mode', description: 'Spotlight the focused region and dim the rest.', category: 'accessibility' },
  { id: 'toggle-reading-mode', name: 'Toggle Reading Mode', description: 'Switch to a clean single-column reading layout.', category: 'accessibility' },
  { id: 'increase-font', name: 'Increase Font', description: 'Bump text scale up one step.', category: 'accessibility' },
  { id: 'decrease-font', name: 'Decrease Font', description: 'Bring text scale down one step.', category: 'accessibility' },
  { id: 'toggle-high-contrast', name: 'Toggle High Contrast', description: 'Flip high-contrast mode on or off.', category: 'accessibility' },
  { id: 'toggle-voice-nav', name: 'Toggle Voice Navigation', description: 'Start or stop voice commands.', category: 'accessibility' },
  { id: 'toggle-reading-guide', name: 'Toggle Reading Guide', description: 'Show or hide the horizontal reading guide.', category: 'accessibility' },
  { id: 'toggle-fatigue-mode', name: 'Toggle Fatigue Mode', description: 'Apply fatigue-adaptive reading adjustments.', category: 'accessibility' },

  // AI (5)
  { id: 'summarize-page', name: 'Summarize Page', description: 'Generate an AI summary of the current page.', category: 'ai' },
  { id: 'summarize-selection', name: 'Summarize Selection', description: 'Summarize the currently selected text.', category: 'ai' },
  { id: 'simplify-selection', name: 'Simplify Selection', description: 'Rewrite the selection in plain language.', category: 'ai' },
  { id: 'read-aloud-selection', name: 'Read Selection Aloud', description: 'Read the current selection using text-to-speech.', category: 'ai' },
  { id: 'translate-selection', name: 'Translate Selection', description: 'Translate the current selection to the profile language.', category: 'ai' },

  // Interactive (8)
  { id: 'click', name: 'Click', description: 'Activate the focused element.', category: 'custom' },
  { id: 'right-click', name: 'Right Click', description: 'Open the context menu on the focused element.', category: 'custom' },
  { id: 'triple-click', name: 'Triple Click', description: 'Select the paragraph under the cursor.', category: 'custom' },
  { id: 'select-word', name: 'Select Word', description: 'Extend selection to the current word.', category: 'custom' },
  { id: 'select-paragraph', name: 'Select Paragraph', description: 'Extend selection to the current paragraph.', category: 'custom' },
  { id: 'copy', name: 'Copy', description: 'Copy the current selection to the clipboard.', category: 'custom' },
  { id: 'paste', name: 'Paste', description: 'Paste clipboard content into the focused field.', category: 'custom' },
  { id: 'cancel', name: 'Cancel', description: 'Dismiss the current overlay or blur focus (Escape).', category: 'custom' },
];

const ACTION_INDEX: Map<string, GestureAction> = new Map(
  GESTURE_ACTIONS.map((a) => [a.id, a]),
);

export function getActionById(id: string): GestureAction | undefined {
  return ACTION_INDEX.get(id);
}
