import { describe, it, expect } from 'vitest';
import {
  transliterate,
  DEVANAGARI_RULES,
  TAMIL_RULES,
  TELUGU_RULES,
  KANNADA_RULES,
  getRulesForScript,
} from '../i18n/transliteration-rules.js';

describe('transliterate — Devanagari', () => {
  const tl = (s: string): string => transliterate(s, DEVANAGARI_RULES);

  it('empty string passes through', () => {
    expect(tl('')).toBe('');
  });

  it('single inherent-a consonant emits base letter', () => {
    expect(tl('k')).toBe('क');
  });

  it('consonant + explicit a drops matra (inherent)', () => {
    expect(tl('ka')).toBe('क');
  });

  it('vowel at word start emits independent form', () => {
    expect(tl('a')).toBe('अ');
    expect(tl('i')).toBe('इ');
    expect(tl('u')).toBe('उ');
  });

  it('long vowels: aa, ii, uu', () => {
    expect(tl('aa')).toBe('आ');
    expect(tl('ii')).toBe('ई');
    expect(tl('uu')).toBe('ऊ');
  });

  it('ITRANS namaste → नमस्ते', () => {
    expect(tl('namaste')).toBe('नमस्ते');
  });

  it('dhanyavaad → धन्यवाद', () => {
    expect(tl('dhanyavaad')).toBe('धन्यवाद');
  });

  it('long-vowel matra for aa', () => {
    expect(tl('kaa')).toBe('का');
  });

  it('consonant cluster with halant', () => {
    expect(tl('kt')).toBe('क्त');
  });

  it('anusvara M attaches to preceding', () => {
    expect(tl('saM')).toBe('सं');
  });

  it('passes through unknown characters (spaces, punctuation)', () => {
    expect(tl('hi ji')).toContain(' ');
    expect(tl('namaste!')).toContain('!');
  });

  it('digits convert to Devanagari numerals', () => {
    expect(tl('123')).toBe('१२३');
  });

  it('mixed word pair with space preserves space', () => {
    const out = tl('raam raam');
    expect(out.includes(' ')).toBe(true);
    expect(out.startsWith('र')).toBe(true);
  });

  it('compound x → क्ष', () => {
    expect(tl('xy')).toBe('क्ष्य');
  });
});

describe('transliterate — Tamil', () => {
  const tl = (s: string): string => transliterate(s, TAMIL_RULES);

  it('empty string passes through', () => {
    expect(tl('')).toBe('');
  });

  it('vanakkam yields a Tamil-script string', () => {
    const out = tl('vanakkam');
    expect(out.length).toBeGreaterThan(0);
    // First char is Tamil va
    expect(out.charCodeAt(0)).toBe(0x0BB5);
  });

  it('standalone vowels', () => {
    expect(tl('a')).toBe('அ');
    expect(tl('aa')).toBe('ஆ');
    expect(tl('i')).toBe('இ');
  });

  it('consonant inherent emits base letter', () => {
    expect(tl('k')).toBe('க');
  });

  it('ka = க (inherent a)', () => {
    expect(tl('ka')).toBe('க');
  });

  it('kaa = கா', () => {
    expect(tl('kaa')).toBe('கா');
  });

  it('ki = கி', () => {
    expect(tl('ki')).toBe('கி');
  });

  it('consonant cluster inserts Tamil halant', () => {
    const out = tl('kt');
    // Expect க + halant (0x0BCD) + த
    expect(out).toContain('\u0BCD');
  });

  it('space passes through', () => {
    expect(tl('ka ka')).toContain(' ');
  });

  it('unknown characters pass through', () => {
    expect(tl('!@#')).toBe('!@#');
  });

  it('zh → ழ', () => {
    expect(tl('zh')).toBe('ழ');
  });
});

describe('transliterate — Telugu', () => {
  const tl = (s: string): string => transliterate(s, TELUGU_RULES);

  it('empty', () => {
    expect(tl('')).toBe('');
  });

  it('vowel a', () => {
    expect(tl('a')).toBe('అ');
  });

  it('consonant k', () => {
    expect(tl('k')).toBe('క');
  });

  it('ka', () => {
    expect(tl('ka')).toBe('క');
  });

  it('kaa', () => {
    expect(tl('kaa')).toBe('కా');
  });

  it('ki', () => {
    expect(tl('ki')).toBe('కి');
  });

  it('long vowels', () => {
    expect(tl('aa')).toBe('ఆ');
    expect(tl('ii')).toBe('ఈ');
    expect(tl('uu')).toBe('ఊ');
  });

  it('consonant cluster with halant', () => {
    expect(tl('kt')).toContain('\u0C4D');
  });

  it('unknown char passes through', () => {
    expect(tl('?')).toBe('?');
  });

  it('namaskaaram starts with న', () => {
    const out = tl('namaskaaram');
    expect(out.charCodeAt(0)).toBe(0x0C28);
  });
});

describe('transliterate — Kannada', () => {
  const tl = (s: string): string => transliterate(s, KANNADA_RULES);

  it('empty', () => {
    expect(tl('')).toBe('');
  });

  it('vowel a', () => {
    expect(tl('a')).toBe('ಅ');
  });

  it('consonant k', () => {
    expect(tl('k')).toBe('ಕ');
  });

  it('ka', () => {
    expect(tl('ka')).toBe('ಕ');
  });

  it('kaa', () => {
    expect(tl('kaa')).toBe('ಕಾ');
  });

  it('ki', () => {
    expect(tl('ki')).toBe('ಕಿ');
  });

  it('long vowels', () => {
    expect(tl('aa')).toBe('ಆ');
    expect(tl('ii')).toBe('ಈ');
    expect(tl('uu')).toBe('ಊ');
  });

  it('cluster with halant', () => {
    expect(tl('kt')).toContain('\u0CCD');
  });

  it('unknown char passes through', () => {
    expect(tl('.')).toBe('.');
  });

  it('namaskara starts with ನ', () => {
    const out = tl('namaskara');
    expect(out.charCodeAt(0)).toBe(0x0CA8);
  });
});

describe('getRulesForScript', () => {
  it('returns Devanagari rules', () => {
    expect(getRulesForScript('devanagari')).toBe(DEVANAGARI_RULES);
  });
  it('returns Tamil rules', () => {
    expect(getRulesForScript('tamil')).toBe(TAMIL_RULES);
  });
  it('returns Telugu rules', () => {
    expect(getRulesForScript('telugu')).toBe(TELUGU_RULES);
  });
  it('returns Kannada rules', () => {
    expect(getRulesForScript('kannada')).toBe(KANNADA_RULES);
  });
});
