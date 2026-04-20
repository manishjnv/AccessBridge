/**
 * Unicode-range-based language detection for page content.
 * Pure data + functions — no DOM.
 *
 * Used by the content script to pick a Web Speech API recognition locale
 * that matches the page's dominant language.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetectedLang =
  // English + Latin fallback
  | 'en'
  // 10 Indian languages
  | 'hi'
  | 'mr'
  | 'ta'
  | 'te'
  | 'kn'
  | 'bn'
  | 'gu'
  | 'pa'
  | 'ml'
  | 'ur'
  // Non-Latin script additions
  | 'ru'
  | 'ko'
  | 'th'
  | 'fa'
  // Latin-script additions (share the English range — distinguished only via profile)
  | 'pt'
  | 'id'
  | 'tr'
  | 'vi'
  | 'tl'
  | 'it'
  | 'pl'
  | 'unknown';

export interface LangRange {
  name: DetectedLang;
  start: number;
  end: number;
  /** Some blocks are shared across languages (e.g. Devanagari hi + mr). */
  aliases?: DetectedLang[];
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export const LANG_RANGES: readonly LangRange[] = [
  { name: 'hi', start: 0x0900, end: 0x097F, aliases: ['mr'] }, // Devanagari
  { name: 'bn', start: 0x0980, end: 0x09FF },                   // Bengali
  { name: 'pa', start: 0x0A00, end: 0x0A7F },                   // Gurmukhi
  { name: 'gu', start: 0x0A80, end: 0x0AFF },                   // Gujarati
  { name: 'ta', start: 0x0B80, end: 0x0BFF },                   // Tamil
  { name: 'te', start: 0x0C00, end: 0x0C7F },                   // Telugu
  { name: 'kn', start: 0x0C80, end: 0x0CFF },                   // Kannada
  { name: 'ml', start: 0x0D00, end: 0x0D7F },                   // Malayalam
  { name: 'th', start: 0x0E00, end: 0x0E7F },                   // Thai
  { name: 'ur', start: 0x0600, end: 0x06FF, aliases: ['fa'] },  // Perso-Arabic (Urdu / Farsi share the block)
  { name: 'ru', start: 0x0400, end: 0x04FF },                   // Cyrillic
  { name: 'ko', start: 0xAC00, end: 0xD7AF },                   // Hangul Syllables
  { name: 'ko', start: 0x1100, end: 0x11FF },                   // Hangul Jamo
  { name: 'en', start: 0x0041, end: 0x007A },                   // Basic Latin letters (A-Z gap a-z)
] as const;

// Non-English detection order — if more than one range hits the threshold,
// this is the tie-break priority (first entry wins).
const NON_ENGLISH_ORDER: readonly DetectedLang[] = [
  'hi', 'bn', 'pa', 'gu', 'ta', 'te', 'kn', 'ml',
  'th', 'ur', 'ru', 'ko',
];

function emptyCounts(): Record<DetectedLang, number> {
  return {
    en: 0,
    hi: 0, mr: 0, ta: 0, te: 0, kn: 0, bn: 0, gu: 0, pa: 0, ml: 0, ur: 0,
    ru: 0, ko: 0, th: 0, fa: 0,
    pt: 0, id: 0, tr: 0, vi: 0, tl: 0, it: 0, pl: 0,
    unknown: 0,
  };
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Count characters in `text` that fall within each known language range.
 * Characters outside all ranges are tallied under `unknown`. The counts for
 * `mr` remain zero — Devanagari is primarily counted as `hi` (callers can
 * cross-reference alias metadata if needed). Similarly `fa` aliases to `ur`
 * (both use the Perso-Arabic block), and Latin-script non-English languages
 * (pt / id / tr / vi / tl / it / pl) aggregate under `en` — the profile
 * setting is the only way to disambiguate them.
 */
export function countByLang(text: string): Record<DetectedLang, number> {
  const counts = emptyCounts();

  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;

    let matched = false;
    for (const range of LANG_RANGES) {
      if (cp >= range.start && cp <= range.end) {
        if (range.name === 'en') {
          // Only count actual letters; skip the [\W] gap 0x5B..0x60
          if (cp < 0x41 || (cp > 0x5A && cp < 0x61)) continue;
        }
        counts[range.name] += 1;
        matched = true;
        break;
      }
    }

    if (!matched) counts.unknown += 1;
  }

  return counts;
}

/**
 * Return the dominant language for `text`. A language wins if its share
 * of letter characters (total minus `unknown`) is at least `threshold`.
 * Non-Latin candidates are preferred on ties — Latin-script pages often
 * contain incidental non-Latin glyphs, but pages with substantial Indic
 * content almost always intend that as the primary language.
 *
 * Returns 'unknown' if no range clears the threshold or `text` is empty.
 */
export function detectLanguage(text: string, threshold = 0.3): DetectedLang {
  const counts = countByLang(text);

  let letterTotal = 0;
  for (const name of Object.keys(counts) as DetectedLang[]) {
    if (name === 'unknown') continue;
    letterTotal += counts[name];
  }
  if (letterTotal === 0) return 'unknown';

  let bestNonEn: DetectedLang = 'unknown';
  let bestNonEnCount = 0;
  for (const lang of NON_ENGLISH_ORDER) {
    if (counts[lang] > bestNonEnCount) {
      bestNonEn = lang;
      bestNonEnCount = counts[lang];
    }
  }

  if (bestNonEn !== 'unknown' && bestNonEnCount / letterTotal >= threshold) {
    return bestNonEn;
  }
  if (counts.en / letterTotal >= threshold) return 'en';
  return 'unknown';
}
