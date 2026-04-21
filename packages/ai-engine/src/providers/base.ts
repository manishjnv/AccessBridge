/**
 * Abstract base class for all AI providers.
 *
 * Concrete implementations supply the actual inference logic for each
 * tier (local rule-based, Gemini Flash, Claude Sonnet, etc.).
 */

import type { AIProvider, AITier } from '../types.js';

export abstract class BaseAIProvider {
  abstract readonly name: AIProvider;
  abstract readonly tier: AITier;

  protected tokensUsed = 0;
  protected cost = 0;

  // -----------------------------------------------------------------------
  // Abstract capabilities — every provider must implement these.
  // -----------------------------------------------------------------------

  abstract summarize(text: string, maxLength?: number): Promise<string>;

  abstract simplify(
    text: string,
    targetLevel?: 'mild' | 'strong',
  ): Promise<string>;

  abstract classify(text: string, categories: string[]): Promise<string>;

  abstract translate(text: string, from: string, to: string): Promise<string>;

  async vision(_prompt: string, _screenshotDataUrl: string): Promise<string> {
    throw new Error(`${this.name} provider does not support vision`);
  }

  // -----------------------------------------------------------------------
  // Tracking helpers
  // -----------------------------------------------------------------------

  getTokensUsed(): number {
    return this.tokensUsed;
  }

  getCost(): number {
    return this.cost;
  }

  /** Subclasses call this after each request to accumulate stats. */
  protected recordUsage(tokens: number, costUsd: number): void {
    this.tokensUsed += tokens;
    this.cost += costUsd;
  }
}
