/**
 * ITRANS-style transliteration rules for Indic scripts.
 * Pure data + functions — no DOM. Used by the extension's transliteration
 * controller to convert Latin input into Devanagari, Tamil, Telugu, or
 * Kannada script.
 *
 * The algorithm is a longest-match greedy scan. State is tracked so that:
 *   - a vowel following a consonant emits its matra (dependent) form
 *   - a consonant following a consonant inserts the halant / virama
 *   - an independent vowel at word start emits its standalone form
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransliterationScript = 'devanagari' | 'tamil' | 'telugu' | 'kannada';

export type RuleKind = 'consonant' | 'vowel' | 'attach' | 'other';

export interface TransliterationRule {
  /** Latin source string (longest matches win). */
  latin: string;
  /** Independent / standalone script form. For consonants: the base letter. */
  script: string;
  /** For vowels: the dependent (matra) form used after a consonant. Empty string for inherent 'a'. */
  matra?: string;
  /** 'consonant' vs 'vowel' controls halant/matra logic. */
  kind: RuleKind;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEVANAGARI_HALANT = '\u094D';
const TAMIL_HALANT = '\u0BCD';
const TELUGU_HALANT = '\u0C4D';
const KANNADA_HALANT = '\u0CCD';

const HALANT_BY_SCRIPT: Record<TransliterationScript, string> = {
  devanagari: DEVANAGARI_HALANT,
  tamil: TAMIL_HALANT,
  telugu: TELUGU_HALANT,
  kannada: KANNADA_HALANT,
};

// ---------------------------------------------------------------------------
// Devanagari (Hindi / Marathi / Sanskrit)
// ---------------------------------------------------------------------------

export const DEVANAGARI_RULES: TransliterationRule[] = [
  // --- Independent vowels & matras (longer matches first) ---
  { latin: 'aa', script: 'आ', matra: 'ा', kind: 'vowel' },
  { latin: 'A',  script: 'आ', matra: 'ा', kind: 'vowel' },
  { latin: 'ii', script: 'ई', matra: 'ी', kind: 'vowel' },
  { latin: 'I',  script: 'ई', matra: 'ी', kind: 'vowel' },
  { latin: 'uu', script: 'ऊ', matra: 'ू', kind: 'vowel' },
  { latin: 'U',  script: 'ऊ', matra: 'ू', kind: 'vowel' },
  { latin: 'Ri', script: 'ऋ', matra: 'ृ', kind: 'vowel' },
  { latin: 'ai', script: 'ऐ', matra: 'ै', kind: 'vowel' },
  { latin: 'au', script: 'औ', matra: 'ौ', kind: 'vowel' },
  { latin: 'a',  script: 'अ', matra: '',  kind: 'vowel' },
  { latin: 'i',  script: 'इ', matra: 'ि', kind: 'vowel' },
  { latin: 'u',  script: 'उ', matra: 'ु', kind: 'vowel' },
  { latin: 'e',  script: 'ए', matra: 'े', kind: 'vowel' },
  { latin: 'o',  script: 'ओ', matra: 'ो', kind: 'vowel' },

  // --- Compound consonants (processed before singles) ---
  { latin: 'kSh', script: 'क्ष', kind: 'consonant' },
  { latin: 'kS',  script: 'क्ष', kind: 'consonant' },
  { latin: 'GY',  script: 'ज्ञ', kind: 'consonant' },
  { latin: 'x',   script: 'क्ष', kind: 'consonant' },

  // --- Aspirated / varga consonants (2-char before 1-char) ---
  { latin: 'chh', script: 'छ', kind: 'consonant' },
  { latin: 'Ch',  script: 'छ', kind: 'consonant' },
  { latin: 'ch',  script: 'च', kind: 'consonant' },
  { latin: 'kh',  script: 'ख', kind: 'consonant' },
  { latin: 'gh',  script: 'घ', kind: 'consonant' },
  { latin: 'jh',  script: 'झ', kind: 'consonant' },
  { latin: 'Th',  script: 'ठ', kind: 'consonant' },
  { latin: 'Dh',  script: 'ढ', kind: 'consonant' },
  { latin: 'th',  script: 'थ', kind: 'consonant' },
  { latin: 'dh',  script: 'ध', kind: 'consonant' },
  { latin: 'ph',  script: 'फ', kind: 'consonant' },
  { latin: 'bh',  script: 'भ', kind: 'consonant' },
  { latin: 'sh',  script: 'श', kind: 'consonant' },
  { latin: 'Sh',  script: 'ष', kind: 'consonant' },

  // --- Single consonants ---
  { latin: 'k', script: 'क', kind: 'consonant' },
  { latin: 'g', script: 'ग', kind: 'consonant' },
  { latin: 'c', script: 'च', kind: 'consonant' },
  { latin: 'j', script: 'ज', kind: 'consonant' },
  { latin: 'T', script: 'ट', kind: 'consonant' },
  { latin: 'D', script: 'ड', kind: 'consonant' },
  { latin: 'N', script: 'ण', kind: 'consonant' },
  { latin: 't', script: 'त', kind: 'consonant' },
  { latin: 'd', script: 'द', kind: 'consonant' },
  { latin: 'n', script: 'न', kind: 'consonant' },
  { latin: 'p', script: 'प', kind: 'consonant' },
  { latin: 'b', script: 'ब', kind: 'consonant' },
  { latin: 'm', script: 'म', kind: 'consonant' },
  { latin: 'y', script: 'य', kind: 'consonant' },
  { latin: 'r', script: 'र', kind: 'consonant' },
  { latin: 'l', script: 'ल', kind: 'consonant' },
  { latin: 'v', script: 'व', kind: 'consonant' },
  { latin: 'w', script: 'व', kind: 'consonant' },
  { latin: 's', script: 'स', kind: 'consonant' },
  { latin: 'h', script: 'ह', kind: 'consonant' },
  { latin: 'L', script: 'ळ', kind: 'consonant' },
  { latin: 'f', script: 'फ़', kind: 'consonant' },
  { latin: 'z', script: 'ज़', kind: 'consonant' },
  { latin: 'q', script: 'क़', kind: 'consonant' },

  // --- Modifiers (anusvara / visarga) — attach to preceding char ---
  { latin: 'M', script: 'ं', kind: 'attach' },
  { latin: 'H', script: 'ः', kind: 'attach' },

  // --- Digits ---
  { latin: '0', script: '०', kind: 'other' },
  { latin: '1', script: '१', kind: 'other' },
  { latin: '2', script: '२', kind: 'other' },
  { latin: '3', script: '३', kind: 'other' },
  { latin: '4', script: '४', kind: 'other' },
  { latin: '5', script: '५', kind: 'other' },
  { latin: '6', script: '६', kind: 'other' },
  { latin: '7', script: '७', kind: 'other' },
  { latin: '8', script: '८', kind: 'other' },
  { latin: '9', script: '९', kind: 'other' },
];

// ---------------------------------------------------------------------------
// Tamil — simpler alphabet, no aspirated stops
// ---------------------------------------------------------------------------

export const TAMIL_RULES: TransliterationRule[] = [
  { latin: 'aa', script: 'ஆ', matra: 'ா', kind: 'vowel' },
  { latin: 'A',  script: 'ஆ', matra: 'ா', kind: 'vowel' },
  { latin: 'ii', script: 'ஈ', matra: 'ீ', kind: 'vowel' },
  { latin: 'I',  script: 'ஈ', matra: 'ீ', kind: 'vowel' },
  { latin: 'uu', script: 'ஊ', matra: 'ூ', kind: 'vowel' },
  { latin: 'U',  script: 'ஊ', matra: 'ூ', kind: 'vowel' },
  { latin: 'ai', script: 'ஐ', matra: 'ை', kind: 'vowel' },
  { latin: 'ee', script: 'ஏ', matra: 'ே', kind: 'vowel' },
  { latin: 'oo', script: 'ஓ', matra: 'ோ', kind: 'vowel' },
  { latin: 'au', script: 'ஔ', matra: 'ௌ', kind: 'vowel' },
  { latin: 'a',  script: 'அ', matra: '',   kind: 'vowel' },
  { latin: 'i',  script: 'இ', matra: 'ி', kind: 'vowel' },
  { latin: 'u',  script: 'உ', matra: 'ு', kind: 'vowel' },
  { latin: 'e',  script: 'எ', matra: 'ெ', kind: 'vowel' },
  { latin: 'o',  script: 'ஒ', matra: 'ொ', kind: 'vowel' },

  // --- Consonants (Tamil has fewer than Devanagari) ---
  { latin: 'ng', script: 'ங', kind: 'consonant' },
  { latin: 'ny', script: 'ஞ', kind: 'consonant' },
  { latin: 'zh', script: 'ழ', kind: 'consonant' },
  { latin: 'sh', script: 'ஷ', kind: 'consonant' },
  { latin: 'ch', script: 'ச', kind: 'consonant' },
  { latin: 'k', script: 'க', kind: 'consonant' },
  { latin: 'c', script: 'ச', kind: 'consonant' },
  { latin: 'j', script: 'ஜ', kind: 'consonant' },
  { latin: 'T', script: 'ட', kind: 'consonant' },
  { latin: 'N', script: 'ண', kind: 'consonant' },
  { latin: 't', script: 'த', kind: 'consonant' },
  { latin: 'n', script: 'ந', kind: 'consonant' },
  { latin: 'p', script: 'ப', kind: 'consonant' },
  { latin: 'm', script: 'ம', kind: 'consonant' },
  { latin: 'y', script: 'ய', kind: 'consonant' },
  { latin: 'r', script: 'ர', kind: 'consonant' },
  { latin: 'R', script: 'ற', kind: 'consonant' },
  { latin: 'l', script: 'ல', kind: 'consonant' },
  { latin: 'L', script: 'ள', kind: 'consonant' },
  { latin: 'v', script: 'வ', kind: 'consonant' },
  { latin: 'w', script: 'வ', kind: 'consonant' },
  { latin: 's', script: 'ஸ', kind: 'consonant' },
  { latin: 'h', script: 'ஹ', kind: 'consonant' },

  { latin: 'M', script: 'ம்', kind: 'attach' },
  { latin: 'H', script: 'ஃ',  kind: 'attach' },

  { latin: '0', script: '௦', kind: 'other' },
  { latin: '1', script: '௧', kind: 'other' },
  { latin: '2', script: '௨', kind: 'other' },
  { latin: '3', script: '௩', kind: 'other' },
  { latin: '4', script: '௪', kind: 'other' },
  { latin: '5', script: '௫', kind: 'other' },
  { latin: '6', script: '௬', kind: 'other' },
  { latin: '7', script: '௭', kind: 'other' },
  { latin: '8', script: '௮', kind: 'other' },
  { latin: '9', script: '௯', kind: 'other' },
];

// ---------------------------------------------------------------------------
// Telugu
// ---------------------------------------------------------------------------

export const TELUGU_RULES: TransliterationRule[] = [
  { latin: 'aa', script: 'ఆ', matra: 'ా', kind: 'vowel' },
  { latin: 'A',  script: 'ఆ', matra: 'ా', kind: 'vowel' },
  { latin: 'ii', script: 'ఈ', matra: 'ీ', kind: 'vowel' },
  { latin: 'I',  script: 'ఈ', matra: 'ీ', kind: 'vowel' },
  { latin: 'uu', script: 'ఊ', matra: 'ూ', kind: 'vowel' },
  { latin: 'U',  script: 'ఊ', matra: 'ూ', kind: 'vowel' },
  { latin: 'Ri', script: 'ఋ', matra: 'ృ', kind: 'vowel' },
  { latin: 'ai', script: 'ఐ', matra: 'ై', kind: 'vowel' },
  { latin: 'au', script: 'ఔ', matra: 'ౌ', kind: 'vowel' },
  { latin: 'a',  script: 'అ', matra: '',   kind: 'vowel' },
  { latin: 'i',  script: 'ఇ', matra: 'ి', kind: 'vowel' },
  { latin: 'u',  script: 'ఉ', matra: 'ు', kind: 'vowel' },
  { latin: 'e',  script: 'ఎ', matra: 'ె', kind: 'vowel' },
  { latin: 'o',  script: 'ఒ', matra: 'ొ', kind: 'vowel' },

  { latin: 'chh', script: 'ఛ', kind: 'consonant' },
  { latin: 'Ch',  script: 'ఛ', kind: 'consonant' },
  { latin: 'ch',  script: 'చ', kind: 'consonant' },
  { latin: 'kh',  script: 'ఖ', kind: 'consonant' },
  { latin: 'gh',  script: 'ఘ', kind: 'consonant' },
  { latin: 'jh',  script: 'ఝ', kind: 'consonant' },
  { latin: 'Th',  script: 'ఠ', kind: 'consonant' },
  { latin: 'Dh',  script: 'ఢ', kind: 'consonant' },
  { latin: 'th',  script: 'థ', kind: 'consonant' },
  { latin: 'dh',  script: 'ధ', kind: 'consonant' },
  { latin: 'ph',  script: 'ఫ', kind: 'consonant' },
  { latin: 'bh',  script: 'భ', kind: 'consonant' },
  { latin: 'sh',  script: 'శ', kind: 'consonant' },
  { latin: 'Sh',  script: 'ష', kind: 'consonant' },

  { latin: 'k', script: 'క', kind: 'consonant' },
  { latin: 'g', script: 'గ', kind: 'consonant' },
  { latin: 'c', script: 'చ', kind: 'consonant' },
  { latin: 'j', script: 'జ', kind: 'consonant' },
  { latin: 'T', script: 'ట', kind: 'consonant' },
  { latin: 'D', script: 'డ', kind: 'consonant' },
  { latin: 'N', script: 'ణ', kind: 'consonant' },
  { latin: 't', script: 'త', kind: 'consonant' },
  { latin: 'd', script: 'ద', kind: 'consonant' },
  { latin: 'n', script: 'న', kind: 'consonant' },
  { latin: 'p', script: 'ప', kind: 'consonant' },
  { latin: 'b', script: 'బ', kind: 'consonant' },
  { latin: 'm', script: 'మ', kind: 'consonant' },
  { latin: 'y', script: 'య', kind: 'consonant' },
  { latin: 'r', script: 'ర', kind: 'consonant' },
  { latin: 'l', script: 'ల', kind: 'consonant' },
  { latin: 'L', script: 'ళ', kind: 'consonant' },
  { latin: 'v', script: 'వ', kind: 'consonant' },
  { latin: 'w', script: 'వ', kind: 'consonant' },
  { latin: 's', script: 'స', kind: 'consonant' },
  { latin: 'h', script: 'హ', kind: 'consonant' },

  { latin: 'M', script: 'ం', kind: 'attach' },
  { latin: 'H', script: 'ః', kind: 'attach' },
];

// ---------------------------------------------------------------------------
// Kannada
// ---------------------------------------------------------------------------

export const KANNADA_RULES: TransliterationRule[] = [
  { latin: 'aa', script: 'ಆ', matra: 'ಾ', kind: 'vowel' },
  { latin: 'A',  script: 'ಆ', matra: 'ಾ', kind: 'vowel' },
  { latin: 'ii', script: 'ಈ', matra: 'ೀ', kind: 'vowel' },
  { latin: 'I',  script: 'ಈ', matra: 'ೀ', kind: 'vowel' },
  { latin: 'uu', script: 'ಊ', matra: 'ೂ', kind: 'vowel' },
  { latin: 'U',  script: 'ಊ', matra: 'ೂ', kind: 'vowel' },
  { latin: 'Ri', script: 'ಋ', matra: 'ೃ', kind: 'vowel' },
  { latin: 'ai', script: 'ಐ', matra: 'ೈ', kind: 'vowel' },
  { latin: 'au', script: 'ಔ', matra: 'ೌ', kind: 'vowel' },
  { latin: 'a',  script: 'ಅ', matra: '',   kind: 'vowel' },
  { latin: 'i',  script: 'ಇ', matra: 'ಿ', kind: 'vowel' },
  { latin: 'u',  script: 'ಉ', matra: 'ು', kind: 'vowel' },
  { latin: 'e',  script: 'ಎ', matra: 'ೆ', kind: 'vowel' },
  { latin: 'o',  script: 'ಒ', matra: 'ೊ', kind: 'vowel' },

  { latin: 'chh', script: 'ಛ', kind: 'consonant' },
  { latin: 'Ch',  script: 'ಛ', kind: 'consonant' },
  { latin: 'ch',  script: 'ಚ', kind: 'consonant' },
  { latin: 'kh',  script: 'ಖ', kind: 'consonant' },
  { latin: 'gh',  script: 'ಘ', kind: 'consonant' },
  { latin: 'jh',  script: 'ಝ', kind: 'consonant' },
  { latin: 'Th',  script: 'ಠ', kind: 'consonant' },
  { latin: 'Dh',  script: 'ಢ', kind: 'consonant' },
  { latin: 'th',  script: 'ಥ', kind: 'consonant' },
  { latin: 'dh',  script: 'ಧ', kind: 'consonant' },
  { latin: 'ph',  script: 'ಫ', kind: 'consonant' },
  { latin: 'bh',  script: 'ಭ', kind: 'consonant' },
  { latin: 'sh',  script: 'ಶ', kind: 'consonant' },
  { latin: 'Sh',  script: 'ಷ', kind: 'consonant' },

  { latin: 'k', script: 'ಕ', kind: 'consonant' },
  { latin: 'g', script: 'ಗ', kind: 'consonant' },
  { latin: 'c', script: 'ಚ', kind: 'consonant' },
  { latin: 'j', script: 'ಜ', kind: 'consonant' },
  { latin: 'T', script: 'ಟ', kind: 'consonant' },
  { latin: 'D', script: 'ಡ', kind: 'consonant' },
  { latin: 'N', script: 'ಣ', kind: 'consonant' },
  { latin: 't', script: 'ತ', kind: 'consonant' },
  { latin: 'd', script: 'ದ', kind: 'consonant' },
  { latin: 'n', script: 'ನ', kind: 'consonant' },
  { latin: 'p', script: 'ಪ', kind: 'consonant' },
  { latin: 'b', script: 'ಬ', kind: 'consonant' },
  { latin: 'm', script: 'ಮ', kind: 'consonant' },
  { latin: 'y', script: 'ಯ', kind: 'consonant' },
  { latin: 'r', script: 'ರ', kind: 'consonant' },
  { latin: 'l', script: 'ಲ', kind: 'consonant' },
  { latin: 'L', script: 'ಳ', kind: 'consonant' },
  { latin: 'v', script: 'ವ', kind: 'consonant' },
  { latin: 'w', script: 'ವ', kind: 'consonant' },
  { latin: 's', script: 'ಸ', kind: 'consonant' },
  { latin: 'h', script: 'ಹ', kind: 'consonant' },

  { latin: 'M', script: 'ಂ', kind: 'attach' },
  { latin: 'H', script: 'ಃ', kind: 'attach' },
];

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function getRulesForScript(script: TransliterationScript): TransliterationRule[] {
  switch (script) {
    case 'devanagari':
      return DEVANAGARI_RULES;
    case 'tamil':
      return TAMIL_RULES;
    case 'telugu':
      return TELUGU_RULES;
    case 'kannada':
      return KANNADA_RULES;
  }
}

export function getHalantForScript(script: TransliterationScript): string {
  return HALANT_BY_SCRIPT[script];
}

/**
 * Greedy longest-match transliteration.
 *
 * Characters not covered by any rule pass through unchanged. State tracks
 * whether the previous emitted glyph was a consonant so a following vowel
 * produces its matra form, and a following consonant gets a halant between.
 */
export function transliterate(input: string, rules: TransliterationRule[]): string {
  if (!input) return '';

  // Detect which script we're using from the rules' halant map.
  // (All rules in a given array come from the same script.)
  const halant = detectHalant(rules);

  const sortedRules = [...rules].sort((a, b) => b.latin.length - a.latin.length);

  let result = '';
  let afterConsonant = false;
  let i = 0;

  while (i < input.length) {
    let matched: TransliterationRule | null = null;
    for (const rule of sortedRules) {
      if (input.startsWith(rule.latin, i)) {
        matched = rule;
        break;
      }
    }

    if (!matched) {
      result += input[i];
      afterConsonant = false;
      i += 1;
      continue;
    }

    switch (matched.kind) {
      case 'consonant':
        if (afterConsonant) result += halant;
        result += matched.script;
        afterConsonant = true;
        break;
      case 'vowel':
        if (afterConsonant) {
          result += matched.matra ?? '';
        } else {
          result += matched.script;
        }
        afterConsonant = false;
        break;
      case 'attach':
        result += matched.script;
        afterConsonant = false;
        break;
      case 'other':
        result += matched.script;
        afterConsonant = false;
        break;
    }

    i += matched.latin.length;
  }

  return result;
}

function detectHalant(rules: TransliterationRule[]): string {
  for (const rule of rules) {
    if (rule.kind !== 'consonant') continue;
    const first = rule.script.charCodeAt(0);
    if (first >= 0x0900 && first <= 0x097F) return DEVANAGARI_HALANT;
    if (first >= 0x0B80 && first <= 0x0BFF) return TAMIL_HALANT;
    if (first >= 0x0C00 && first <= 0x0C7F) return TELUGU_HALANT;
    if (first >= 0x0C80 && first <= 0x0CFF) return KANNADA_HALANT;
  }
  return DEVANAGARI_HALANT;
}
