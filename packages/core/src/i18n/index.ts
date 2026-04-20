export type {
  TransliterationScript,
  TransliterationRule,
  RuleKind,
} from './transliteration-rules.js';

export {
  DEVANAGARI_RULES,
  TAMIL_RULES,
  TELUGU_RULES,
  KANNADA_RULES,
  getRulesForScript,
  getHalantForScript,
  transliterate,
} from './transliteration-rules.js';

export type { DetectedLang, LangRange } from './language-ranges.js';
export { LANG_RANGES, countByLang, detectLanguage } from './language-ranges.js';
