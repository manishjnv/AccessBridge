/**
 * Hindi Voice Command Support — BACKWARD-COMPATIBLE SHIM.
 *
 * Original single-language Hindi support has been absorbed into the
 * multi-language Indic registry in `indic-commands.ts`. This file now
 * re-exports the Hindi slice so any existing imports continue to work.
 */

import {
  INDIC_COMMANDS,
  matchIndicCommand,
  SUPPORTED_INDIC_LANGUAGES,
  type IndicCommandMapping,
  type MatchResult,
} from './indic-commands.js';

export type HindiCommandMapping = IndicCommandMapping & { hindi: string[] };

/** Hindi command slice (aliased keys for legacy callers). */
export const HINDI_COMMANDS: HindiCommandMapping[] = INDIC_COMMANDS['hi-IN'].map(
  (cmd) => ({ ...cmd, hindi: cmd.phrases }),
);

/** Match a Hindi transcript. Equivalent to `matchIndicCommand(t, 'hi-IN')`. */
export function matchHindiCommand(transcript: string): MatchResult | null {
  return matchIndicCommand(transcript, 'hi-IN');
}

export const SUPPORTED_VOICE_LANGUAGES = [
  { code: 'en-US', label: 'English (US)', flag: 'EN' },
  { code: 'en-IN', label: 'English (India)', flag: 'EN' },
  ...SUPPORTED_INDIC_LANGUAGES.map((lang) => ({
    code: lang.code,
    label: `${lang.label} (${lang.nativeName})`,
    flag: lang.flag,
  })),
  { code: 'es-ES', label: 'Spanish', flag: 'ES' },
  { code: 'fr-FR', label: 'French', flag: 'FR' },
  { code: 'de-DE', label: 'German', flag: 'DE' },
  { code: 'ja-JP', label: 'Japanese', flag: 'JA' },
  { code: 'zh-CN', label: 'Chinese (Simplified)', flag: 'ZH' },
  { code: 'ar-SA', label: 'Arabic', flag: 'AR' },
] as const;

export type VoiceLangCode = (typeof SUPPORTED_VOICE_LANGUAGES)[number]['code'];

export type { MatchResult };
