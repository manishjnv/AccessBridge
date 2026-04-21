/**
 * @accessbridge/onnx-runtime — shared types.
 *
 * Minimal structural interfaces so the rest of the monorepo can import
 * this package without pulling in onnxruntime-web at type-check time.
 */

export type ModelTier = 0 | 1 | 2 | 3;

export interface TokenizerMetadata {
  url: string;
  bundledPath: string | null;
  sha256: string | null;
  sizeBytes: number;
}

export interface ModelMetadata {
  id: string;
  version: string;
  url: string;
  /** Path inside the extension bundle if the model ships with the zip. Null otherwise. */
  bundledPath: string | null;
  /** Lower-case hex SHA-256 of the ONNX bytes. Null while no real model exists yet. */
  sha256: string | null;
  sizeBytes: number;
  loadTier: ModelTier;
  inputNames: readonly string[];
  outputNames: readonly string[];
  description: string;
  /** Companion tokenizer for NL models (MiniLM, T5). Not present for numeric-feature models like the struggle classifier. */
  tokenizer?: TokenizerMetadata;
}

export interface ModelLoadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export interface TensorLike {
  type: string;
  data: Float32Array | Int32Array | BigInt64Array;
  dims: readonly number[];
}

export interface InferenceSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, TensorLike>): Promise<Record<string, TensorLike>>;
  release?(): void;
}

export type LoadResult =
  | { ok: true; session: InferenceSessionLike; cached: boolean }
  | { ok: false; error: string };

export interface RuntimeStats {
  modelsLoaded: string[];
  cacheBytes: number;
  inferenceCount: Record<string, number>;
  avgLatencyMs: Record<string, number>;
  fallbackCount: number;
}

export interface StruggleClassifierLike {
  predict(
    features: Float32Array,
  ): Promise<{ score: number; confidence: number } | null>;
}

export interface EmbedderLike {
  embed(text: string): Promise<Float32Array | null>;
}

export interface SummarizerLike {
  summarize(
    text: string,
    options: { maxLength: number },
  ): Promise<string | null>;
}

export interface TranscriberLike {
  transcribe(
    audio: Float32Array,
    sampleRate: number,
    options: { language: string },
  ): Promise<{
    text: string;
    confidence: number;
    language: string;
    latencyMs: number;
    real: boolean;
  } | null>;
  isSupported(language: string): boolean;
}
