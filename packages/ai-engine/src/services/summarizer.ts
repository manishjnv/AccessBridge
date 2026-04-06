/**
 * High-level summarisation service.
 *
 * Pre-processes inputs with the normaliser before handing off to the
 * AI engine, and provides domain-specific helpers (emails, docs, meetings).
 */

import { AIEngine } from '../engine.js';
import {
  extractKeyContent,
  deduplicateEmailThread,
  truncateForSummarization,
  normalizeText,
} from '../normalizer.js';

export class SummarizerService {
  private readonly engine: AIEngine;

  constructor(engine: AIEngine) {
    this.engine = engine;
  }

  /**
   * Summarise an email that may be in HTML and may contain a quoted
   * reply thread.
   */
  async summarizeEmail(emailHtml: string): Promise<string> {
    const plain = extractKeyContent(emailHtml);
    const deduped = deduplicateEmailThread(plain);
    const truncated = truncateForSummarization(deduped);
    return this.engine.summarize(truncated);
  }

  /**
   * Summarise a document into bullet points.
   */
  async summarizeDocument(
    text: string,
    maxBullets: number = 5,
  ): Promise<string> {
    const normalised = truncateForSummarization(normalizeText(text));
    const raw = await this.engine.summarize(normalised);

    // If the engine returned prose, attempt to split into bullets.
    const sentences = raw
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.trim().length > 0);

    if (sentences.length <= 1) return raw;

    return sentences
      .slice(0, maxBullets)
      .map((s) => `- ${s.trim()}`)
      .join('\n');
  }

  /**
   * Summarise a meeting transcript, extracting a prose summary and
   * a list of action items.
   */
  async summarizeMeeting(
    transcript: string,
  ): Promise<{ summary: string; actionItems: string[] }> {
    const normalised = truncateForSummarization(normalizeText(transcript));

    // We make two engine calls — one for summary, one for action items.
    // If the engine is using a local provider both will be fast and free.
    const [summary, actionRaw] = await Promise.all([
      this.engine.summarize(normalised),
      this.engine.process({
        id: `meeting-actions-${Date.now().toString(36)}`,
        type: 'summarize',
        input: `Extract action items from the following meeting transcript. List each action item on its own line starting with "- ".\n\n${normalised}`,
      }),
    ]);

    const actionItems = actionRaw.output
      .split('\n')
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter((line) => line.length > 0);

    return { summary, actionItems };
  }
}
