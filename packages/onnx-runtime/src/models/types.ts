export interface StrugglePrediction {
  /** 0-100 struggle score, probability-weighted. */
  score: number;
  /** 0-1 confidence (= argmax class probability). */
  confidence: number;
  /** The argmax bucket label. */
  bucket: 'none' | 'low' | 'medium' | 'high';
}

export interface EmbeddingResult {
  vector: Float32Array;
  /** Model that produced the embedding, e.g. 'minilm-l6-v2'. */
  model: string;
  /** True if produced by the ONNX model; false if a pseudo-embedding fallback. */
  real: boolean;
}

export interface SummarizeResult {
  text: string;
  model: string;
  real: boolean;
}
