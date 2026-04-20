import { describe, it, expect } from 'vitest';
import {
  detectLanguage,
  countByLang,
  LANG_RANGES,
} from '../i18n/language-ranges.js';

describe('countByLang', () => {
  it('empty string produces all-zero counts', () => {
    const c = countByLang('');
    for (const name of Object.keys(c)) {
      expect(c[name as keyof typeof c]).toBe(0);
    }
  });

  it('counts Hindi (Devanagari) characters under hi', () => {
    const c = countByLang('नमस्ते');
    expect(c.hi).toBeGreaterThan(0);
  });

  it('counts English letters under en', () => {
    const c = countByLang('hello');
    expect(c.en).toBe(5);
  });

  it('skips ASCII punctuation as unknown', () => {
    const c = countByLang('!@#');
    expect(c.en).toBe(0);
    expect(c.unknown).toBe(3);
  });

  it('Tamil text counts under ta', () => {
    const c = countByLang('தமிழ்');
    expect(c.ta).toBeGreaterThan(0);
  });

  it('Arabic/Urdu counts under ur', () => {
    const c = countByLang('اردو');
    expect(c.ur).toBeGreaterThan(0);
  });
});

describe('detectLanguage', () => {
  it('empty string → unknown', () => {
    expect(detectLanguage('')).toBe('unknown');
  });

  it('whitespace only → unknown', () => {
    expect(detectLanguage('   \n\t ')).toBe('unknown');
  });

  it('pure English → en', () => {
    expect(detectLanguage('Hello world this is English text')).toBe('en');
  });

  it('pure Hindi → hi', () => {
    expect(detectLanguage('नमस्ते दुनिया यह हिन्दी है')).toBe('hi');
  });

  it('pure Tamil → ta', () => {
    expect(detectLanguage('தமிழ் மொழி உலக மொழி')).toBe('ta');
  });

  it('pure Telugu → te', () => {
    expect(detectLanguage('తెలుగు భాష ఒక అద్భుతమైన భాష')).toBe('te');
  });

  it('pure Kannada → kn', () => {
    expect(detectLanguage('ಕನ್ನಡ ನನ್ನ ತಾಯ್ನುಡಿ')).toBe('kn');
  });

  it('pure Bengali → bn', () => {
    expect(detectLanguage('বাংলা ভাষা অনেক সুন্দর')).toBe('bn');
  });

  it('pure Gujarati → gu', () => {
    expect(detectLanguage('ગુજરાતી ભાષા સરસ છે')).toBe('gu');
  });

  it('pure Punjabi → pa', () => {
    expect(detectLanguage('ਪੰਜਾਬੀ ਬੋਲੀ ਬਹੁਤ ਸੋਹਣੀ ਹੈ')).toBe('pa');
  });

  it('pure Malayalam → ml', () => {
    expect(detectLanguage('മലയാളം എന്റെ മാതൃഭാഷ')).toBe('ml');
  });

  it('pure Urdu → ur', () => {
    expect(detectLanguage('اردو زبان بہت خوبصورت ہے')).toBe('ur');
  });

  it('50/50 English + Hindi at default threshold → hi (non-Latin wins)', () => {
    const text = 'Hello world नमस्ते जी';
    expect(detectLanguage(text, 0.3)).toBe('hi');
  });

  it('mostly English with a few Hindi chars (below 0.3 threshold) → en', () => {
    // Heavy English plus just one Hindi glyph — Hindi share < 0.3
    const text = 'This is a long English sentence with almost no Hindi न';
    expect(detectLanguage(text, 0.3)).toBe('en');
  });

  it('punctuation-only treated as no letters → unknown', () => {
    expect(detectLanguage('!!!!!   ???')).toBe('unknown');
  });

  it('LANG_RANGES has entries for every detected language', () => {
    const ranges = LANG_RANGES.map((r) => r.name);
    expect(ranges).toContain('hi');
    expect(ranges).toContain('ta');
    expect(ranges).toContain('te');
    expect(ranges).toContain('kn');
    expect(ranges).toContain('bn');
    expect(ranges).toContain('gu');
    expect(ranges).toContain('pa');
    expect(ranges).toContain('ml');
    expect(ranges).toContain('ur');
    expect(ranges).toContain('en');
  });
});
