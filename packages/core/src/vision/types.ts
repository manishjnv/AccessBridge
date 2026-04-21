export interface UnlabeledElement {
  nodeHint: string;
  bbox: { x: number; y: number; w: number; h: number };
  computedRole: string | null;
  currentAriaLabel: string | null;
  textContent: string;
  siblingContext: string;
  classSignature: string;
  backgroundImageUrl: string | null;
}

export interface RecoveredLabel {
  element: UnlabeledElement;
  inferredRole: string;
  inferredLabel: string;
  inferredDescription: string;
  confidence: number;
  source: 'heuristic' | 'api-vision' | 'on-device-vlm' | 'cached' | 'semantic-similar';
  tier: 1 | 2 | 3;
  /** For Tier 3 hits, SHA-256 of the downsampled element screenshot (hex). */
  screenshotHash?: string;
  /** For 'semantic-similar' hits, the label this result was matched to. */
  similarTo?: string;
}

export interface VisionRecoveryConfig {
  tierEnabled: { 1: boolean; 2: boolean; 3: boolean };
  cacheTTLms: number;
  minConfidence: number;
  costBudgetPerDay: number;
  /** Max inferences (Tier 3) per page scan. On-device so generous vs Tier 2's 50. */
  maxPerPageScan: number;
  /** 'speed' runs a shorter prompt + smaller max-tokens; 'accuracy' runs full caption. */
  tier3Priority: 'speed' | 'accuracy';
  /** Cosine-similarity threshold for reusing an existing label on a new screenshot. */
  semanticSimilarityThreshold: number;
  /** Dedup cache TTL for identical screenshot hashes (ms). */
  screenshotDedupTTLms: number;
  /** Upper bound on daily Tier 3 inferences; enterprise-controllable. */
  maxTier3PerDay: number;
}

export interface RecoveryCache {
  key: string;
  recovered: RecoveredLabel;
  cachedAt: number;
  appVersion: string;
}

export interface ApiVisionClient {
  inferElementMeaning(screenshot: string, domContext: string): Promise<{
    role: string;
    label: string;
    description: string;
    confidence: number;
  }>;
}

/** Tier 3 (on-device vision-language model) — narrow structural interface so
 *  @accessbridge/core does not take an onnxruntime-web dependency. */
export interface OnDeviceVisionClient {
  /** True once model weights are loaded and inference is possible. */
  isLoaded(): boolean;
  /** Returns null on error / missing model / degenerate image. Caller falls
   *  back to Tier 1 heuristic when this returns null. */
  describeElement(
    image: ImageDataLike,
    prompt: string,
  ): Promise<{
    caption: string;
    role: string;
    inferredLabel: string;
    confidence: number;
    latencyMs: number;
  } | null>;
}

/** Structural alias for browser ImageData — accepts any object with width/height
 *  and a Uint8ClampedArray / Uint8Array-compatible `data` field. */
export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Optional per-element screenshot provider; when absent, Tier 3 is skipped. */
export interface ScreenshotProvider {
  screenshot(element: UnlabeledElement): Promise<ImageDataLike | null>;
}

/** Optional embedder — when present, recovered labels are keyed by MiniLM
 *  embeddings to enable "semantic vocabulary" convergence across the same app. */
export interface LabelEmbedder {
  embed(text: string): Promise<Float32Array | null>;
}

/** Optional hasher for a downsampled screenshot → hex string. When absent,
 *  dedup falls back to DOM-only cache key. */
export interface ScreenshotHasher {
  hash(image: ImageDataLike): Promise<string | null>;
}

export interface UserCurationRecord {
  /** Stable id — `${appVersion}::${classSignature}::${screenshotHash}`. */
  id: string;
  element: UnlabeledElement;
  recovered: RecoveredLabel;
  status: 'accepted' | 'rejected' | 'edited';
  editedLabel?: string;
  domain: string;
  appVersion: string;
  curatedAt: number;
}

export const DEFAULT_VISION_CONFIG: VisionRecoveryConfig = {
  tierEnabled: { 1: true, 2: false, 3: false },
  cacheTTLms: 7 * 24 * 60 * 60 * 1000,
  minConfidence: 0.6,
  costBudgetPerDay: 0.1,
  maxPerPageScan: 200,
  tier3Priority: 'accuracy',
  semanticSimilarityThreshold: 0.85,
  screenshotDedupTTLms: 24 * 60 * 60 * 1000,
  maxTier3PerDay: 500,
};
