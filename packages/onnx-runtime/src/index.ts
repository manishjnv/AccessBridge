export { ONNXRuntime } from './runtime.js';
export type { ONNXRuntimeOptions } from './runtime.js';

export {
  StruggleClassifier,
  buildPrediction,
} from './models/struggle-classifier.js';
export type { StruggleBucket } from './models/struggle-classifier.js';
export type {
  StrugglePrediction,
  EmbeddingResult,
  SummarizeResult,
} from './models/types.js';

export {
  MiniLMEmbeddings,
  MINILM_DIM,
  l2normalize,
  cosineSimilarity,
  pseudoEmbedding,
} from './models/minilm-embeddings.js';

export { T5Summarizer } from './models/t5-summarizer.js';
export type { SummarizeOptions } from './models/t5-summarizer.js';

export {
  MODEL_REGISTRY,
  STRUGGLE_CLASSIFIER_ID,
  MINILM_EMBEDDINGS_ID,
  T5_SUMMARIZER_ID,
  TIER_LABELS,
  TIER_DESCRIPTIONS,
  getModelMetadata,
  getModelsForTier,
} from './model-registry.js';

export type {
  ModelTier,
  ModelMetadata,
  ModelLoadProgress,
  TensorLike,
  InferenceSessionLike,
  LoadResult,
  RuntimeStats,
  StruggleClassifierLike,
  EmbedderLike,
  SummarizerLike,
} from './types.js';
