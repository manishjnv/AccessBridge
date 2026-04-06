/**
 * Text simplification service.
 *
 * Wraps the AI engine with pre-processing suited to accessibility
 * use-cases: plain-language rewrites, policy document simplification,
 * and readability scoring.
 */

import { AIEngine } from '../engine.js';
import { normalizeText, truncateForSummarization } from '../normalizer.js';

export class SimplifierService {
  private readonly engine: AIEngine;

  constructor(engine: AIEngine) {
    this.engine = engine;
  }

  /**
   * Simplify arbitrary text at the given level.
   */
  async simplifyText(
    text: string,
    level: 'mild' | 'strong' = 'mild',
  ): Promise<string> {
    const normalised = normalizeText(text, 8000);
    const resp = await this.engine.process({
      id: `simplify-${Date.now().toString(36)}`,
      type: 'simplify',
      input: normalised,
      metadata: { level },
    });
    return resp.output;
  }

  /**
   * Simplify legal / policy documents.
   *
   * Policy text is truncated aggressively because these documents
   * tend to be long and repetitive.
   */
  async simplifyPolicy(policyText: string): Promise<string> {
    const normalised = truncateForSummarization(normalizeText(policyText));
    const resp = await this.engine.process({
      id: `simplify-policy-${Date.now().toString(36)}`,
      type: 'simplify',
      input: normalised,
      metadata: { level: 'strong' },
    });
    return resp.output;
  }

  /**
   * Estimate the Flesch-Kincaid grade level of the given text.
   *
   * This is a pure local computation — no AI call needed.
   * Formula: 0.39 * (words/sentences) + 11.8 * (syllables/words) - 15.59
   */
  getReadabilityScore(text: string): number {
    const sentences = text
      .split(/[.!?]+/)
      .filter((s) => s.trim().length > 0);
    const words = text.split(/\s+/).filter((w) => w.length > 0);

    if (sentences.length === 0 || words.length === 0) return 0;

    const totalSyllables = words.reduce(
      (sum, w) => sum + this.countSyllables(w),
      0,
    );

    const grade =
      0.39 * (words.length / sentences.length) +
      11.8 * (totalSyllables / words.length) -
      15.59;

    return Math.max(0, Math.round(grade * 10) / 10);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Rough syllable count for an English word.
   */
  private countSyllables(word: string): number {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (w.length <= 3) return 1;

    let count = 0;
    let prevVowel = false;
    const vowels = 'aeiouy';

    for (const ch of w) {
      const isVowel = vowels.includes(ch);
      if (isVowel && !prevVowel) count++;
      prevVowel = isVowel;
    }

    // Silent "e" at end.
    if (w.endsWith('e') && count > 1) count--;
    // Words like "le" at end often add a syllable.
    if (w.endsWith('le') && w.length > 2 && !vowels.includes(w[w.length - 3])) {
      count++;
    }

    return Math.max(1, count);
  }
}
