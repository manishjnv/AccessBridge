/**
 * Gemini Flash provider  (Tier 2 — low-cost API).
 *
 * Calls the Google Generative Language REST API using plain `fetch()`.
 * Model: gemini-2.0-flash
 * Cost:  ~$0.10 / 1 M tokens
 */

import { BaseAIProvider } from './base.js';
import { estimateCost } from '../cost-tracker.js';
import { estimateTokenCount } from '../normalizer.js';
import type { AIProvider, AITier } from '../types.js';

const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'gemini-2.0-flash';

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { totalTokenCount?: number };
  error?: { message?: string };
}

export class GeminiAIProvider extends BaseAIProvider {
  readonly name: AIProvider = 'gemini';
  readonly tier: AITier = 'low-cost';

  private apiKey: string;
  private endpoint: string;

  constructor(apiKey: string, endpoint?: string) {
    super();
    this.apiKey = apiKey;
    this.endpoint = endpoint ?? DEFAULT_ENDPOINT;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  // -----------------------------------------------------------------------
  // Capabilities
  // -----------------------------------------------------------------------

  async summarize(text: string, maxLength?: number): Promise<string> {
    const hint = maxLength ? ` in at most ${maxLength} characters` : '';
    const prompt =
      `Summarize the following text concisely${hint}. ` +
      `Return only the summary, no preamble.\n\n${text}`;
    return this.generate(prompt);
  }

  async simplify(
    text: string,
    targetLevel: 'mild' | 'strong' = 'mild',
  ): Promise<string> {
    const level =
      targetLevel === 'strong'
        ? 'Use very short, simple sentences suitable for someone with cognitive disabilities.'
        : 'Use plain language at an 8th-grade reading level.';
    const prompt =
      `Rewrite the following text to make it simpler and easier to understand. ` +
      `${level} Return only the simplified text.\n\n${text}`;
    return this.generate(prompt);
  }

  async classify(text: string, categories: string[]): Promise<string> {
    const cats = categories.join(', ');
    const prompt =
      `Classify the following text into exactly one of these categories: ${cats}. ` +
      `Return only the category name, nothing else.\n\n${text}`;
    const result = await this.generate(prompt);
    // Ensure the result matches one of the given categories.
    const lower = result.toLowerCase().trim();
    const match = categories.find((c) => c.toLowerCase() === lower);
    return match ?? categories[0];
  }

  async translate(text: string, from: string, to: string): Promise<string> {
    const prompt =
      `Translate the following text from ${from} to ${to}. ` +
      `Return only the translation, no preamble.\n\n${text}`;
    return this.generate(prompt);
  }

  // -----------------------------------------------------------------------
  // Internal: call Gemini REST API
  // -----------------------------------------------------------------------

  private async generate(prompt: string): Promise<string> {
    const url = `${this.endpoint}/models/${MODEL}:generateContent?key=${this.apiKey}`;

    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024,
      },
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `Gemini API network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown');
      if (response.status === 429) {
        throw new Error('Gemini API rate limited — try again later');
      }
      throw new Error(`Gemini API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as GeminiResponse;

    if (data.error) {
      throw new Error(`Gemini API error: ${data.error.message}`);
    }

    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    const tokens =
      data.usageMetadata?.totalTokenCount ?? estimateTokenCount(prompt + text);
    const cost = estimateCost(tokens, this.tier, this.name);
    this.recordUsage(tokens, cost);

    return text.trim();
  }
}
