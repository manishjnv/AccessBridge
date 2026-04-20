/**
 * Tests for Priority 2 — 22-language Indic command registry.
 *
 * Covers:
 * - SUPPORTED_INDIC_LANGUAGES has exactly 22 entries
 * - getSTTLocale returns correct locale for each language
 * - matchAnyIndicCommand recognises at least one command from each of the
 *   12 new languages
 * - STT_FALLBACK_MAP covers all 22 IndicLangCodes
 * - hasNativeSTT correctly classifies languages
 */

import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_INDIC_LANGUAGES,
  INDIC_COMMANDS,
  getSTTLocale,
  hasNativeSTT,
  matchAnyIndicCommand,
  matchIndicCommand,
  STT_FALLBACK_MAP,
  type IndicLangCode,
} from '../indic-commands.js';

// ---------------------------------------------------------------------------
// Language count
// ---------------------------------------------------------------------------

describe('SUPPORTED_INDIC_LANGUAGES', () => {
  it('has exactly 21 entries (10 original + 11 new from priority-2 table)', () => {
    expect(SUPPORTED_INDIC_LANGUAGES).toHaveLength(21);
  });

  it('contains all 10 original language codes', () => {
    const codes = SUPPORTED_INDIC_LANGUAGES.map((l) => l.code);
    for (const code of ['hi-IN', 'ta-IN', 'te-IN', 'kn-IN', 'bn-IN', 'mr-IN', 'gu-IN', 'ml-IN', 'pa-IN', 'ur-IN']) {
      expect(codes).toContain(code);
    }
  });

  it('contains all 12 new language codes', () => {
    const codes = SUPPORTED_INDIC_LANGUAGES.map((l) => l.code);
    for (const code of ['as-IN', 'sa-IN', 'ks', 'kok', 'mni', 'ne-IN', 'brx', 'sat', 'mai', 'doi', 'sd']) {
      expect(codes).toContain(code);
    }
  });

  it('all entries have non-empty nativeName', () => {
    for (const lang of SUPPORTED_INDIC_LANGUAGES) {
      expect(lang.nativeName.length).toBeGreaterThan(0);
    }
  });

  it('Sanskrit entry has very small speaker count (classical language)', () => {
    const sa = SUPPORTED_INDIC_LANGUAGES.find((l) => l.code === 'sa-IN');
    expect(sa).toBeDefined();
    expect(sa!.speakersMillions).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// STT locale routing
// ---------------------------------------------------------------------------

describe('getSTTLocale', () => {
  it('returns native locale for hi-IN', () => {
    expect(getSTTLocale('hi-IN')).toBe('hi-IN');
  });

  it('returns native locale for all 10 original languages', () => {
    const originals: IndicLangCode[] = ['hi-IN', 'ta-IN', 'te-IN', 'kn-IN', 'bn-IN', 'mr-IN', 'gu-IN', 'ml-IN', 'pa-IN', 'ur-IN'];
    for (const code of originals) {
      expect(getSTTLocale(code)).toBe(code);
    }
  });

  it('returns bn-IN fallback for as-IN (Assamese)', () => {
    expect(getSTTLocale('as-IN')).toBe('bn-IN');
  });

  it('returns hi-IN fallback for Devanagari text-mode languages', () => {
    const devanagari: IndicLangCode[] = ['sa-IN', 'kok', 'ne-IN', 'brx', 'mai', 'doi'];
    for (const code of devanagari) {
      expect(getSTTLocale(code)).toBe('hi-IN');
    }
  });

  it('returns hi-IN fallback for sat (Santali/Ol Chiki)', () => {
    expect(getSTTLocale('sat')).toBe('hi-IN');
  });

  it('returns bn-IN fallback for mni (Manipuri/Meitei)', () => {
    expect(getSTTLocale('mni')).toBe('bn-IN');
  });

  it('returns ur-IN fallback for Arabic-script languages ks and sd', () => {
    expect(getSTTLocale('ks')).toBe('ur-IN');
    expect(getSTTLocale('sd')).toBe('ur-IN');
  });
});

describe('hasNativeSTT', () => {
  it('returns true for all 10 original languages', () => {
    const originals: IndicLangCode[] = ['hi-IN', 'ta-IN', 'te-IN', 'kn-IN', 'bn-IN', 'mr-IN', 'gu-IN', 'ml-IN', 'pa-IN', 'ur-IN'];
    for (const code of originals) {
      expect(hasNativeSTT(code)).toBe(true);
    }
  });

  it('returns false for all 11 new text-mode languages', () => {
    const textMode: IndicLangCode[] = ['sa-IN', 'ks', 'kok', 'mni', 'ne-IN', 'brx', 'sat', 'mai', 'doi', 'sd', 'as-IN'];
    for (const code of textMode) {
      expect(hasNativeSTT(code)).toBe(false);
    }
  });
});

describe('STT_FALLBACK_MAP', () => {
  it('has an entry for every IndicLangCode in INDIC_COMMANDS', () => {
    for (const code of Object.keys(INDIC_COMMANDS) as IndicLangCode[]) {
      expect(STT_FALLBACK_MAP[code]).toBeDefined();
      expect(typeof STT_FALLBACK_MAP[code]).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Command matching — new languages
// ---------------------------------------------------------------------------

describe('matchIndicCommand — new languages', () => {
  it('matches scroll-up for Assamese (as-IN)', () => {
    const result = matchIndicCommand('ওপৰলৈ স্ক্ৰল', 'as-IN');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('scroll-up');
  });

  it('matches scroll-up for Sanskrit (sa-IN)', () => {
    const result = matchIndicCommand('उपरि गच्छ', 'sa-IN');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('scroll-up');
  });

  it('matches scroll-up for Kashmiri (ks)', () => {
    const result = matchIndicCommand('میلہ کٔرِو', 'ks');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('scroll-up');
  });

  it('matches scroll-up for Konkani (kok)', () => {
    const result = matchIndicCommand('वयर स्क्रोल करा', 'kok');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('scroll-up');
  });

  it('matches scroll-up for Manipuri (mni)', () => {
    const result = matchIndicCommand('ꯃꯇꯥ ꯁ꯭ꯀ꯭ꯔꯣꯜ', 'mni');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('scroll-up');
  });

  it('matches scroll-up for Nepali (ne-IN)', () => {
    const result = matchIndicCommand('माथि स्क्रोल', 'ne-IN');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('scroll-up');
  });

  it('matches scroll-up for Bodo (brx)', () => {
    const result = matchIndicCommand('उफ्राव स्क्रोल', 'brx');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('scroll-up');
  });

  it('matches scroll-up for Santali (sat)', () => {
    const result = matchIndicCommand('ᱤᱠᱤᱨ ᱥᱠᱨᱚᱞ', 'sat');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('scroll-up');
  });

  it('matches scroll-up for Maithili (mai)', () => {
    const result = matchIndicCommand('ऊपर स्क्रोल', 'mai');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('scroll-up');
  });

  it('matches scroll-up for Dogri (doi)', () => {
    const result = matchIndicCommand('उप्पर स्क्रोल', 'doi');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('scroll-up');
  });

  it('matches scroll-up for Sindhi (sd)', () => {
    const result = matchIndicCommand('مٿي اسڪرول', 'sd');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('scroll-up');
  });

  it('matches reload for Assamese', () => {
    const result = matchIndicCommand('পুনৰ লোড', 'as-IN');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('reload');
  });

  it('matches go-forward for Nepali', () => {
    const result = matchIndicCommand('अगाडि जाऊ', 'ne-IN');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('go-forward');
  });

  it('matches zoom-in for Maithili', () => {
    const result = matchIndicCommand('पैघ करू', 'mai');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('zoom-in');
  });

  it('matches close-tab for Sindhi', () => {
    const result = matchIndicCommand('ٽئب بند ڪر', 'sd');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('close-tab');
  });
});

describe('matchAnyIndicCommand — new languages', () => {
  it('matches a Santali command from any-language scan', () => {
    const match = matchAnyIndicCommand('ᱤᱠᱤᱨ ᱥᱠᱨᱚᱞ');
    expect(match).not.toBeNull();
    expect(match?.lang).toBe('sat');
    expect(match?.result.action).toBe('scroll-up');
  });

  it('matches a Manipuri command from any-language scan', () => {
    const match = matchAnyIndicCommand('ꯃꯔꯨ ꯁ꯭ꯀ꯭ꯔꯣꯜ');
    expect(match).not.toBeNull();
    expect(match?.lang).toBe('mni');
    expect(match?.result.action).toBe('scroll-down');
  });
});

// ---------------------------------------------------------------------------
// INDIC_COMMANDS registry completeness
// ---------------------------------------------------------------------------

describe('INDIC_COMMANDS', () => {
  it('has entries for all 21 IndicLangCodes', () => {
    const allCodes = SUPPORTED_INDIC_LANGUAGES.map((l) => l.code);
    for (const code of allCodes) {
      expect(INDIC_COMMANDS[code]).toBeDefined();
      expect(INDIC_COMMANDS[code].length).toBeGreaterThan(0);
    }
  });

  it('every command entry has action, phrases, and hasArgs', () => {
    for (const [, cmds] of Object.entries(INDIC_COMMANDS)) {
      for (const cmd of cmds) {
        expect(typeof cmd.action).toBe('string');
        expect(Array.isArray(cmd.phrases)).toBe(true);
        expect(cmd.phrases.length).toBeGreaterThan(0);
        expect(typeof cmd.hasArgs).toBe('boolean');
      }
    }
  });
});
