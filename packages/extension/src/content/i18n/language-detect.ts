/**
 * Page-language auto-detection. Samples visible text from the page and
 * picks a DetectedLang via the unicode-range heuristic in core/i18n.
 */

import {
  countByLang,
  detectLanguage,
  type DetectedLang,
} from '@accessbridge/core/i18n/language-ranges.js';

const SAMPLE_MAX = 5000;

export interface PageLangResult {
  detected: DetectedLang;
  sampleSize: number;
  distribution: Record<DetectedLang, number>;
}

export function detectPageLanguage(): PageLangResult {
  const root =
    document.querySelector('main') ??
    document.querySelector('article') ??
    document.body;

  const raw = root ? (root.textContent ?? '') : '';
  const text = raw.length > SAMPLE_MAX ? raw.slice(0, SAMPLE_MAX) : raw;

  const distribution = countByLang(text);
  const detected = detectLanguage(text);

  return { detected, sampleSize: text.length, distribution };
}

const LOCALE_MAP: Record<DetectedLang, string | null> = {
  en: 'en-US',
  // Indian languages (original 10)
  hi: 'hi-IN',
  mr: 'mr-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  kn: 'kn-IN',
  bn: 'bn-IN',
  gu: 'gu-IN',
  pa: 'pa-IN',
  ml: 'ml-IN',
  ur: 'ur-IN',
  // 12 new Indian languages (Priority 2)
  // as: Assamese — Chrome STT routes through bn-IN (same script family)
  as: 'bn-IN',
  // Devanagari-script languages without native STT → hi-IN fallback
  sa: 'hi-IN',
  kok: 'hi-IN',
  ne: 'hi-IN',
  brx: 'hi-IN',
  mai: 'hi-IN',
  doi: 'hi-IN',
  // Ol Chiki (Santali) → hi-IN fallback
  sat: 'hi-IN',
  // Meitei Mayek (Manipuri) → bn-IN fallback (same Bengali-script family)
  mni: 'bn-IN',
  // Arabic-script languages → ur-IN fallback
  ks: 'ur-IN',
  sd: 'ur-IN',
  // Non-Latin script additions
  ru: 'ru-RU',
  ko: 'ko-KR',
  th: 'th-TH',
  fa: 'fa-IR',
  // Latin-script additions
  pt: 'pt-BR',
  id: 'id-ID',
  tr: 'tr-TR',
  vi: 'vi-VN',
  tl: 'fil-PH',
  it: 'it-IT',
  pl: 'pl-PL',
  unknown: null,
};

export function detectedLangToVoiceLocale(lang: DetectedLang): string | null {
  return LOCALE_MAP[lang];
}

export type { DetectedLang };
