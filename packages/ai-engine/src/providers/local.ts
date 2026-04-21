/**
 * Local / on-device AI provider  (Tier 1 — free, zero API calls).
 *
 * Historically rule-based; Session 12 extends it with optional hooks for
 * the ONNX model wrappers that ship in `@accessbridge/onnx-runtime`.
 * The provider never hard-depends on that package: callers pass in
 * embedder + summarizer objects matching the structural interfaces
 * below, and every ONNX path falls back to a deterministic heuristic
 * when the hook is absent, returns null, or throws.
 */

import { BaseAIProvider } from './base.js';
import type { AIProvider, AITier } from '../types.js';

// ---------------------------------------------------------------------------
// Optional on-device model interfaces (structurally compatible with
// @accessbridge/onnx-runtime's MiniLMEmbeddings + T5Summarizer).
// ---------------------------------------------------------------------------

export interface LocalEmbedder {
  embed(text: string): Promise<Float32Array | null>;
  ready?(): boolean;
}

export interface LocalSummarizer {
  summarize(
    text: string,
    options: { maxLength: number },
  ): Promise<string | null>;
  ready?(): boolean;
}

export interface LocalAIProviderOptions {
  embedder?: LocalEmbedder | null;
  summarizer?: LocalSummarizer | null;
  /** Returns true to bypass every ONNX call and use the heuristic path. */
  forceFallback?: () => boolean;
  /** Per-call timeout for ONNX hooks in ms (default 5000). */
  modelTimeoutMs?: number;
  /** Called every time a fallback fires. Useful for observability. */
  onFallback?: (reason: string) => void;
}

export const EMBED_DIM = 384;

// ---------------------------------------------------------------------------
// Small dictionary: complex word -> simpler replacement
// ---------------------------------------------------------------------------

const SIMPLIFY_MAP: Record<string, string> = {
  // Common complex -> simple
  'utilize': 'use',
  'utilise': 'use',
  'utilization': 'use',
  'implement': 'do',
  'implementation': 'setup',
  'demonstrate': 'show',
  'approximately': 'about',
  'sufficient': 'enough',
  'facilitate': 'help',
  'subsequent': 'next',
  'commence': 'start',
  'terminate': 'end',
  'endeavor': 'try',
  'endeavour': 'try',
  'additional': 'more',
  'accomplish': 'do',
  'acquire': 'get',
  'assistance': 'help',
  'beneficial': 'helpful',
  'communicate': 'talk',
  'consequently': 'so',
  'considerable': 'big',
  'currently': 'now',
  'difficulty': 'problem',
  'discontinue': 'stop',
  'equivalent': 'equal',
  'establish': 'set up',
  'fundamental': 'basic',
  'generate': 'make',
  'indicate': 'show',
  'individual': 'person',
  'inquire': 'ask',
  'magnitude': 'size',
  'modification': 'change',
  'necessitate': 'need',
  'numerous': 'many',
  'objective': 'goal',
  'obtain': 'get',
  'participate': 'join',
  'perceive': 'see',
  'previously': 'before',
  'prioritize': 'rank',
  'probability': 'chance',
  'proficiency': 'skill',
  'purchase': 'buy',
  'regarding': 'about',
  'remainder': 'rest',
  'request': 'ask',
  'requirement': 'need',
  'residence': 'home',
  'respond': 'answer',
  'therefore': 'so',
  'thoroughly': 'fully',
  'transmit': 'send',
  'occupation': 'job',
  'component': 'part',
  'comprehend': 'understand',
  'frequently': 'often',
  'immediately': 'now',
  'primarily': 'mainly',
  'however': 'but',
  'nevertheless': 'still',
  'notwithstanding': 'despite',
  'whereas': 'while',
  'furthermore': 'also',
  'henceforth': 'from now on',
  'herein': 'here',
  'aforementioned': 'above',
  'pursuant': 'under',
};

// ---------------------------------------------------------------------------
// Helper: split text into sentences
// ---------------------------------------------------------------------------

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Helper: score a sentence for extractive summarisation
// ---------------------------------------------------------------------------

function scoreSentence(
  sentence: string,
  index: number,
  total: number,
  wordFreq: Map<string, number>,
): number {
  let score = 0;

  // Position bonus: first and last sentences are usually important.
  if (index === 0) score += 3;
  else if (index === total - 1) score += 1.5;
  else if (index < 3) score += 1;

  // Length penalty: very short or very long sentences are less useful.
  const words = sentence.split(/\s+/);
  if (words.length < 4) score -= 1;
  if (words.length > 40) score -= 0.5;

  // Keyword frequency — sum of word frequencies in this sentence.
  for (const w of words) {
    score += (wordFreq.get(w.toLowerCase()) ?? 0) * 0.1;
  }

  return score;
}

function buildWordFrequency(sentences: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const s of sentences) {
    for (const w of s.split(/\s+/)) {
      const key = w.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (key.length > 2) {
        freq.set(key, (freq.get(key) ?? 0) + 1);
      }
    }
  }
  return freq;
}

// ---------------------------------------------------------------------------
// Helper: deterministic trigram pseudo-embedding (fallback only)
// ---------------------------------------------------------------------------

function hashTrigram(a: number, b: number, c: number): number {
  let h = 2166136261 ^ a;
  h = Math.imul(h, 16777619) ^ b;
  h = Math.imul(h, 16777619) ^ c;
  h = Math.imul(h, 16777619);
  return h >>> 0;
}

function pseudoEmbed(text: string, dim = EMBED_DIM): Float32Array {
  const v = new Float32Array(dim);
  const lower = text.toLowerCase();
  if (lower.length < 3) {
    for (let i = 0; i < lower.length; i++) {
      v[lower.charCodeAt(i) % dim] += 1;
    }
  } else {
    for (let i = 0; i <= lower.length - 3; i++) {
      const h = hashTrigram(
        lower.charCodeAt(i),
        lower.charCodeAt(i + 1),
        lower.charCodeAt(i + 2),
      );
      v[h % dim] += 1;
    }
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

// ---------------------------------------------------------------------------
// Helper: race a promise against a timeout; never throws.
// ---------------------------------------------------------------------------

async function raceTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class LocalAIProvider extends BaseAIProvider {
  readonly name: AIProvider = 'local';
  readonly tier: AITier = 'local';

  private embedder: LocalEmbedder | null;
  private summarizer: LocalSummarizer | null;
  private forceFallback: () => boolean;
  private modelTimeoutMs: number;
  private onFallback: (reason: string) => void;

  constructor(options: LocalAIProviderOptions = {}) {
    super();
    this.embedder = options.embedder ?? null;
    this.summarizer = options.summarizer ?? null;
    this.forceFallback = options.forceFallback ?? (() => false);
    this.modelTimeoutMs = options.modelTimeoutMs ?? 5000;
    this.onFallback = options.onFallback ?? (() => {});
  }

  setEmbedder(embedder: LocalEmbedder | null): void {
    this.embedder = embedder;
  }

  setSummarizer(summarizer: LocalSummarizer | null): void {
    this.summarizer = summarizer;
  }

  // -----------------------------------------------------------------------
  // Summarise — T5 when available, else extractive sentence-scoring.
  // -----------------------------------------------------------------------

  async summarize(text: string, maxLength?: number): Promise<string> {
    if (this.summarizer && !this.forceFallback()) {
      const modelOutput = await raceTimeout(
        this.summarizer.summarize(text, { maxLength: maxLength ?? 200 }),
        this.modelTimeoutMs,
      ).catch(() => null);
      if (modelOutput && modelOutput.trim().length > 0) {
        this.recordUsage(0, 0);
        return modelOutput;
      }
      this.onFallback('summarizer');
    }

    return this.summarizeHeuristic(text, maxLength);
  }

  private summarizeHeuristic(text: string, maxLength?: number): string {
    const sentences = splitSentences(text);
    if (sentences.length <= 3) {
      this.recordUsage(0, 0);
      return text;
    }

    const wordFreq = buildWordFrequency(sentences);
    const scored = sentences.map((s, i) => ({
      sentence: s,
      score: scoreSentence(s, i, sentences.length, wordFreq),
      index: i,
    }));

    // Take top N sentences (by score) but present them in original order.
    const targetCount = Math.max(2, Math.min(5, Math.ceil(sentences.length * 0.3)));
    const top = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, targetCount)
      .sort((a, b) => a.index - b.index);

    let summary = top.map((t) => t.sentence).join(' ');

    if (maxLength && summary.length > maxLength) {
      summary = summary.slice(0, maxLength - 3) + '...';
    }

    this.recordUsage(0, 0);
    return summary;
  }

  // -----------------------------------------------------------------------
  // Simplify — word substitution + sentence shortening (unchanged)
  // -----------------------------------------------------------------------

  async simplify(
    text: string,
    targetLevel: 'mild' | 'strong' = 'mild',
  ): Promise<string> {
    let result = text;

    // Replace complex words with simpler alternatives.
    for (const [complex, simple] of Object.entries(SIMPLIFY_MAP)) {
      const regex = new RegExp(`\\b${complex}\\b`, 'gi');
      result = result.replace(regex, simple);
    }

    if (targetLevel === 'strong') {
      // Break long sentences at conjunctions.
      result = result.replace(
        /([.!?]?\s*)(,?\s*(?:and|but|or|while|although|because|however|therefore|furthermore)\s+)/gi,
        '$1. ',
      );

      // Remove parenthetical asides.
      result = result.replace(/\s*\([^)]{0,200}\)\s*/g, ' ');
    }

    // Collapse excess whitespace.
    result = result.replace(/\s+/g, ' ').trim();

    this.recordUsage(0, 0);
    return result;
  }

  // -----------------------------------------------------------------------
  // Classify — keyword matching (unchanged)
  // -----------------------------------------------------------------------

  async classify(text: string, categories: string[]): Promise<string> {
    if (categories.length === 0) return 'unknown';

    const lowerText = text.toLowerCase();
    const scores = categories.map((cat) => {
      const keywords = cat.toLowerCase().split(/[\s_-]+/);
      let score = 0;
      for (const kw of keywords) {
        // Count occurrences of each keyword fragment in the text.
        const regex = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const matches = lowerText.match(regex);
        score += matches ? matches.length : 0;
      }
      return { category: cat, score };
    });

    scores.sort((a, b) => b.score - a.score);

    this.recordUsage(0, 0);
    return scores[0].score > 0 ? scores[0].category : categories[0];
  }

  // -----------------------------------------------------------------------
  // Translate — placeholder (no-op, unchanged)
  // -----------------------------------------------------------------------

  async translate(text: string, _from: string, _to: string): Promise<string> {
    this.recordUsage(0, 0);
    return text;
  }

  // -----------------------------------------------------------------------
  // Embed — MiniLM when available, else deterministic trigram pseudo.
  // -----------------------------------------------------------------------

  async embed(text: string): Promise<Float32Array> {
    if (this.embedder && !this.forceFallback()) {
      const vector = await raceTimeout(
        this.embedder.embed(text),
        this.modelTimeoutMs,
      ).catch(() => null);
      if (vector && vector.length === EMBED_DIM) {
        this.recordUsage(0, 0);
        return vector;
      }
      this.onFallback('embedder');
    }

    this.recordUsage(0, 0);
    return pseudoEmbed(text);
  }
}
