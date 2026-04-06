/**
 * Hindi Voice Command Support
 *
 * Maps Hindi voice commands to English action identifiers,
 * and provides Hindi STT via Web Speech API with lang='hi-IN'.
 *
 * Users can speak in Hindi and the system maps to the same
 * command actions as English voice commands.
 */

// ---------------------------------------------------------------------------
// Hindi command mappings (Romanized Hindi → command action)
// ---------------------------------------------------------------------------

export interface HindiCommandMapping {
  /** Hindi phrase(s) that trigger this command */
  hindi: string[];
  /** Corresponding English command action */
  action: string;
  /** Whether the command accepts trailing arguments */
  hasArgs: boolean;
}

export const HINDI_COMMANDS: HindiCommandMapping[] = [
  // Navigation
  { hindi: ['ऊपर स्क्रॉल', 'ऊपर जाओ', 'ऊपर'], action: 'scroll-up', hasArgs: false },
  { hindi: ['नीचे स्क्रॉल', 'नीचे जाओ', 'नीचे'], action: 'scroll-down', hasArgs: false },
  { hindi: ['शुरू में जाओ', 'टॉप पर जाओ', 'सबसे ऊपर'], action: 'go-to-top', hasArgs: false },
  { hindi: ['अंत में जाओ', 'नीचे तक जाओ', 'सबसे नीचे'], action: 'go-to-bottom', hasArgs: false },
  { hindi: ['पीछे जाओ', 'वापस जाओ'], action: 'go-back', hasArgs: false },
  { hindi: ['आगे जाओ', 'आगे'], action: 'go-forward', hasArgs: false },

  // Page actions
  { hindi: ['पेज लोड करो', 'रीलोड', 'दोबारा लोड'], action: 'reload', hasArgs: false },
  { hindi: ['बड़ा करो', 'ज़ूम इन'], action: 'zoom-in', hasArgs: false },
  { hindi: ['छोटा करो', 'ज़ूम आउट'], action: 'zoom-out', hasArgs: false },

  // Tab management
  { hindi: ['अगला टैब', 'नेक्स्ट टैब'], action: 'next-tab', hasArgs: false },
  { hindi: ['पिछला टैब', 'प्रीवियस टैब'], action: 'prev-tab', hasArgs: false },
  { hindi: ['टैब बंद करो', 'ये बंद करो'], action: 'close-tab', hasArgs: false },
  { hindi: ['नया टैब', 'नया पेज'], action: 'new-tab', hasArgs: false },

  // Accessibility features
  { hindi: ['फोकस मोड', 'ध्यान मोड'], action: 'focus-mode', hasArgs: false },
  { hindi: ['पढ़ने का मोड', 'रीडिंग मोड'], action: 'reading-mode', hasArgs: false },
  { hindi: ['पेज पढ़ो', 'पढ़ कर सुनाओ', 'पढ़ो'], action: 'read-page', hasArgs: false },

  // AI features
  { hindi: ['सारांश दो', 'समरी दिखाओ', 'सारांश'], action: 'summarize', hasArgs: false },
  { hindi: ['सरल करो', 'आसान भाषा', 'सिम्प्लीफाई'], action: 'simplify', hasArgs: false },
  { hindi: ['ईमेल सारांश', 'ईमेल की समरी'], action: 'summarize-email', hasArgs: false },

  // Interactions (with args)
  { hindi: ['क्लिक करो', 'दबाओ'], action: 'click', hasArgs: true },
  { hindi: ['लिखो', 'टाइप करो'], action: 'type', hasArgs: true },
  { hindi: ['खोजो', 'ढूंढो', 'ढूँढो'], action: 'find', hasArgs: true },

  // Control
  { hindi: ['सुनना बंद करो', 'बंद करो', 'रुको'], action: 'stop-listening', hasArgs: false },
  { hindi: ['मदद', 'हेल्प', 'सहायता'], action: 'help', hasArgs: false },
];

// ---------------------------------------------------------------------------
// Matcher — resolves a Hindi transcript to an action + args
// ---------------------------------------------------------------------------

export interface MatchResult {
  action: string;
  args: string;
}

/**
 * Try to match a Hindi speech transcript against known commands.
 * Returns the action and any trailing arguments, or null if no match.
 */
export function matchHindiCommand(transcript: string): MatchResult | null {
  const cleaned = transcript.trim();

  for (const cmd of HINDI_COMMANDS) {
    for (const phrase of cmd.hindi) {
      if (cmd.hasArgs) {
        // Check if transcript starts with the Hindi phrase
        if (cleaned.startsWith(phrase + ' ') || cleaned.startsWith(phrase + '  ')) {
          const args = cleaned.slice(phrase.length).trim();
          return { action: cmd.action, args };
        }
      } else {
        // Exact match (allow minor trailing whitespace)
        if (cleaned === phrase || cleaned === phrase + '।') {
          return { action: cmd.action, args: '' };
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Supported languages for voice commands
// ---------------------------------------------------------------------------

export const SUPPORTED_VOICE_LANGUAGES = [
  { code: 'en-US', label: 'English (US)', flag: 'EN' },
  { code: 'en-IN', label: 'English (India)', flag: 'EN' },
  { code: 'hi-IN', label: 'Hindi (हिन्दी)', flag: 'HI' },
  { code: 'es-ES', label: 'Spanish', flag: 'ES' },
  { code: 'fr-FR', label: 'French', flag: 'FR' },
  { code: 'de-DE', label: 'German', flag: 'DE' },
  { code: 'ja-JP', label: 'Japanese', flag: 'JA' },
  { code: 'zh-CN', label: 'Chinese (Simplified)', flag: 'ZH' },
  { code: 'ar-SA', label: 'Arabic', flag: 'AR' },
] as const;

export type VoiceLangCode = (typeof SUPPORTED_VOICE_LANGUAGES)[number]['code'];
