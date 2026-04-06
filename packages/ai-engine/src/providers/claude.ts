/**
 * Claude provider  (Tier 2 low-cost with Haiku, Tier 3 premium with Sonnet).
 *
 * Calls the Anthropic Messages REST API using plain `fetch()`.
 */

import { BaseAIProvider } from './base.js';
import { estimateCost } from '../cost-tracker.js';
import { estimateTokenCount } from '../normalizer.js';
import type { AIProvider, AITier } from '../types.js';

const DEFAULT_ENDPOINT = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

const MODELS: Record<AITier, string> = {
  local: '',
  'low-cost': 'claude-haiku-4-5-20251001',
  premium: 'claude-sonnet-4-6-20250514',
};

const SYSTEM_PROMPT =
  'You are an accessibility assistant integrated into the AccessBridge browser extension. ' +
  'Your goal is to make web content more accessible to users with disabilities. ' +
  'Be concise, clear, and use plain language. ' +
  'When simplifying text, prioritise readability for people with cognitive, visual, or learning disabilities.';

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: AnthropicUsage;
  error?: { message?: string };
}

export class ClaudeAIProvider extends BaseAIProvider {
  readonly name: AIProvider = 'claude';
  readonly tier: AITier;

  private apiKey: string;
  private endpoint: string;
  private model: string;

  constructor(tier: AITier, apiKey: string, endpoint?: string) {
    super();
    this.tier = tier === 'local' ? 'low-cost' : tier;
    this.apiKey = apiKey;
    this.endpoint = endpoint ?? DEFAULT_ENDPOINT;
    this.model = MODELS[this.tier];
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
      `Return only the summary.\n\n${text}`;
    return this.generate(prompt);
  }

  async simplify(
    text: string,
    targetLevel: 'mild' | 'strong' = 'mild',
  ): Promise<string> {
    const level =
      targetLevel === 'strong'
        ? 'Rewrite for someone with a cognitive disability. Use very short, simple sentences. Avoid jargon.'
        : 'Rewrite at an 8th-grade reading level using plain language.';
    const prompt =
      `${level} Return only the simplified text.\n\n${text}`;
    return this.generate(prompt);
  }

  async classify(text: string, categories: string[]): Promise<string> {
    const cats = categories.join(', ');
    const prompt =
      `Classify the following text into exactly one of these categories: ${cats}. ` +
      `Return only the category name.\n\n${text}`;
    const result = await this.generate(prompt);
    const lower = result.toLowerCase().trim();
    const match = categories.find((c) => c.toLowerCase() === lower);
    return match ?? categories[0];
  }

  async translate(text: string, from: string, to: string): Promise<string> {
    const prompt =
      `Translate the following text from ${from} to ${to}. ` +
      `Return only the translation.\n\n${text}`;
    return this.generate(prompt);
  }

  // -----------------------------------------------------------------------
  // Internal: call Anthropic Messages API
  // -----------------------------------------------------------------------

  private async generate(userPrompt: string): Promise<string> {
    const url = `${this.endpoint}/v1/messages`;

    const body = {
      model: this.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `Claude API network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown');
      if (response.status === 429) {
        throw new Error('Claude API rate limited — try again later');
      }
      throw new Error(`Claude API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as AnthropicResponse;

    if (data.error) {
      throw new Error(`Claude API error: ${data.error.message}`);
    }

    const text =
      data.content
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('') ?? '';

    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    const tokens =
      inputTokens + outputTokens ||
      estimateTokenCount(userPrompt + text);
    const cost = estimateCost(tokens, this.tier, this.name);
    this.recordUsage(tokens, cost);

    return text.trim();
  }
}
