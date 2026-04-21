/**
 * StruggleClassifier — wraps the Tier-0 XGBoost-exported ONNX model.
 *
 * Input contract: 60-feature Float32Array (10 signal types × 6 rolling
 * statistics, see packages/core/src/signals/struggle-detector.ts#featurize).
 *
 * Output contract: a 4-class softmax over {none, low, medium, high}.
 * We reduce to (score 0-100, confidence 0-1) using a probability-weighted
 * combination of bucket centres so a confident "medium" gives a crisp
 * ~60, while a flat distribution collapses toward 50 with low confidence.
 *
 * When the model has not been loaded, predict() returns null so the
 * caller falls back to the heuristic detector cleanly.
 */

import type { ONNXRuntime } from '../runtime.js';
import type { StrugglePrediction } from './types.js';
import { STRUGGLE_CLASSIFIER_ID } from '../model-registry.js';

const BUCKET_CENTERS = [0, 25, 60, 85] as const;
const BUCKETS = ['none', 'low', 'medium', 'high'] as const;

export type StruggleBucket = (typeof BUCKETS)[number];

export class StruggleClassifier {
  constructor(
    private readonly runtime: ONNXRuntime,
    private readonly modelId: string = STRUGGLE_CLASSIFIER_ID,
  ) {}

  async load(
    onProgress?: (p: { percent: number }) => void,
  ): Promise<boolean> {
    const r = await this.runtime.loadModel(this.modelId, onProgress);
    return r.ok;
  }

  ready(): boolean {
    return this.runtime.hasModel(this.modelId);
  }

  async predict(features: Float32Array): Promise<StrugglePrediction | null> {
    const session = this.runtime.getModel(this.modelId);
    if (!session) return null;
    if (features.length !== 60) return null;

    const inputName = session.inputNames[0] ?? 'features';
    const outputName = session.outputNames[0] ?? 'probabilities';
    const tensor = this.runtime.createTensor('float32', features, [1, 60]);
    if (!tensor) return null;

    try {
      const t0 =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      const outputs = await session.run({ [inputName]: tensor });
      const out = outputs[outputName];
      if (!out || !(out.data instanceof Float32Array)) {
        this.runtime.recordFallback();
        return null;
      }
      const latency =
        (typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now()) - t0;
      this.runtime.recordInference(this.modelId, latency);
      return buildPrediction(out.data);
    } catch {
      this.runtime.recordFallback();
      return null;
    }
  }
}

export function buildPrediction(probs: Float32Array): StrugglePrediction {
  let maxIdx = 0;
  let maxProb = probs[0] ?? 0;
  let probSum = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = Math.max(0, probs[i] ?? 0);
    probSum += p;
    if (p > maxProb) {
      maxProb = p;
      maxIdx = i;
    }
  }

  let weighted = 0;
  if (probSum > 0) {
    for (let i = 0; i < probs.length; i++) {
      const p = Math.max(0, probs[i] ?? 0);
      const center = BUCKET_CENTERS[Math.min(i, BUCKET_CENTERS.length - 1)];
      weighted += (p / probSum) * center;
    }
  } else {
    weighted = BUCKET_CENTERS[Math.min(maxIdx, BUCKET_CENTERS.length - 1)];
  }

  const bucket = BUCKETS[Math.min(maxIdx, BUCKETS.length - 1)];
  return {
    score: clamp(Math.round(weighted * 100) / 100, 0, 100),
    confidence: clamp(maxProb, 0, 1),
    bucket,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
