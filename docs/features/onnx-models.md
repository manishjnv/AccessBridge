# Feature: On-Device ONNX Models

**Status:** Infrastructure shipping (Session 12, 2026-04-21). Real quantized weights for MiniLM + T5 and a custom-trained XGBoost struggle classifier are deferred to a follow-up session.

Session 12 delivers the **end-to-end wiring** for real on-device ONNX inference: runtime manager, model registry, IndexedDB cache, SHA-256 integrity check, per-tier toggles, popup + side-panel UI, observatory counters, and heuristic fallback on every path. The three model classes (`StruggleClassifier`, `MiniLMEmbeddings`, `T5Summarizer`) expose their final public interfaces; their internal tokenize / decode plumbing is stubbed with an explicit `return null` that triggers fallback, and a `TODO(session-13)` marker points at the exact line that needs real weights + tokenizer.

This means: **today**, every ONNX call returns null → the existing heuristic path runs, and observatory logs a "fallback" inference. **Tomorrow**, when the VPS CDN has real `.onnx` bytes, the runtime will transparently download them, cache them, and the model classes' predict/embed/summarize paths will produce real outputs with no further code churn.

## Architecture

```
┌──────────────────────────┐
│  @accessbridge/extension │
│  background SW           │
└────────────┬─────────────┘
             │
             ▼
    ┌────────────────────────────┐
    │  @accessbridge/onnx-runtime │
    │  ONNXRuntime (singleton)    │
    │  ├─ ortLoader (lazy)        │
    │  ├─ fetch + SHA-256 verify  │
    │  ├─ IDB cache               │
    │  └─ InferenceSession pool   │
    └────┬──────────┬──────────┬──┘
         │          │          │
         ▼          ▼          ▼
   Tier 0        Tier 1       Tier 2
   Struggle      MiniLM       T5-small
   Classifier    Embeddings   Summarizer
   (3 MB)        (80 MB)      (242 MB)
         │          │          │
         ▼          ▼          ▼
   ┌────────────┐ ┌────────────────┐
   │ Struggle   │ │ LocalAIProvider│
   │ Detector   │ │ .embed/        │
   │ .featurize │ │ .summarize     │
   │ .getScore  │ │                │
   │  Async     │ │                │
   └────────────┘ └────────────────┘
         │             │
         │             └─► AICache.generateKeyByEmbedding
         ▼                (semantic cache bucketing)
   Adaptation pipeline
```

## Three-tier loading strategy

| Tier | Model | Size | Auto-load | Purpose |
|------|-------|------|-----------|---------|
| 0 | `struggle-classifier-v1` | ~3 MB | ✅ 2s after SW start (if profile toggle on) | Blend into heuristic struggle score when classifier confidence > 0.7 |
| 1 | `minilm-l6-v2` | ~80 MB | Manual (popup Download button) | 384-dim sentence embeddings → semantic cache key + future dedup |
| 2 | `t5-small` | ~242 MB | Manual | Abstractive summarization when heuristic extractive isn't enough |

**Total footprint:** ~325 MB downloaded once, cached in IndexedDB under `accessbridge-onnx-cache`. Only Tier 0 is resident at startup; Tier 1 and 2 are opt-in.

## Fallback chain

Every on-device path **must** degrade cleanly. The contract:

1. Model loaded → run inference. If the output looks valid (correct shape, non-empty), return it.
2. Model loaded but inference throws → `recordFallback()`, return null.
3. Model not loaded → return null immediately without calling inference.
4. `profile.onnxForceFallback === true` (debug toggle) → skip every model call, return null.
5. Caller (StruggleDetector / LocalAIProvider) receives null → existing heuristic code runs unchanged.

This means: **no user-visible behaviour change** when a model isn't available. Every existing test keeps passing.

## Struggle score blending

`StruggleDetector.getStruggleScoreAsync()` adds the only non-trivial blend:

```
if classifier.confidence > 0.7:
  final.score = 0.6 * classifier.score + 0.4 * heuristic.score
  final.confidence = max(heuristic.confidence, classifier.confidence)
else:
  final = heuristic
```

The threshold guards against a low-confidence classifier dragging a good heuristic score off. The blend weights bias toward the classifier because its score integrates 60 features (rolling statistics per signal type) while the heuristic uses only current batch deviations.

## Feature vector layout (60 dimensions)

`StruggleDetector.featurize()` emits a `Float32Array(60)` in this stable order:

```
indices  signal type        stats (per signal: 6 values)
  0..5   SCROLL_VELOCITY    [current, mean, stddev, min, max, trend]
  6..11  CLICK_ACCURACY     [current, mean, stddev, min, max, trend]
 12..17  DWELL_TIME         [current, mean, stddev, min, max, trend]
 18..23  TYPING_RHYTHM      [current, mean, stddev, min, max, trend]
 24..29  BACKSPACE_RATE     [current, mean, stddev, min, max, trend]
 30..35  ZOOM_EVENTS        [current, mean, stddev, min, max, trend]
 36..41  CURSOR_PATH        [current, mean, stddev, min, max, trend]
 42..47  ERROR_RATE         [current, mean, stddev, min, max, trend]
 48..53  READING_SPEED      [current, mean, stddev, min, max, trend]
 54..59  HESITATION         [current, mean, stddev, min, max, trend]
```

All values are already normalized `[0, 1]` (current/mean/min/max/stddev) or `[-1, 1]` (trend). If a signal type has zero samples in the current 60-second window, its six slots are left at `0` — the classifier must treat that as "no signal" rather than "minimum signal."

**Invariant:** Any change to `SIGNAL_FEATURE_ORDER` or `STATS_PER_SIGNAL` requires bumping the model version (`struggle-classifier-v1` → `-v2`) and retraining. Tests pin `FEATURE_DIM === 60`.

## Privacy

- Models download over HTTPS from the same VPS nginx instance as `/api/version`. No third-party CDN. (The in-browser runtime fetches `http://72.61.227.64:8300/models/*.onnx` directly via the `<all_urls>` host permission already granted — no new manifest permission.)
- Model binaries are cached in IndexedDB on the user's machine. Nothing is ever uploaded back.
- Inference happens 100% on device. The struggle feature vector, the text being embedded, and the text being summarized **never leave the browser**. The only telemetry is a Laplace-noised per-tier inference count — opt-in, identical mechanism to existing observatory counters.

## Integrity

Once real model binaries ship, `MODEL_REGISTRY[id].sha256` will hold the hex SHA-256 of the ONNX bytes. The runtime verifies this after fetch and before storing in the IDB cache; mismatches reject the load with `integrity-mismatch:expected=... actual=...` and no session is created. In the MVP, `sha256` is `null` and the runtime logs `[onnx] model ... has no sha256 — integrity unverified` to warn operators.

## Deferred work

| Item | Why | Session |
|------|-----|---------|
| Custom XGBoost training script (`tools/train-struggle-classifier.py`) | Needs Python + xgboost + skl2onnx toolchain set up | 13 |
| Upload real `.onnx` binaries to `/opt/accessbridge/models/` | Depends on training + quantizing scripts | 13 |
| WordPiece tokenizer for MiniLM (`packages/onnx-runtime/src/models/tokenizer.ts`) | Bundle vocab.txt + trie; ~3 KLOC including BPE fallback | 13 |
| SentencePiece + beam-search decode for T5 | Non-trivial autoregressive decode loop with KV-cache | 13+ |
| WebGPU backend | Faster but CSP-constrained in MV3; WASM default works | 14+ |
| Re-train classifier on pilot data | Needs real user rollout | post-pilot |

## Testing

- **onnx-runtime package:** 26 tests (`runtime.test.ts` + `struggle-classifier.test.ts` + `model-registry.test.ts`) cover load path with mocked onnxruntime-web + IndexedDB + fetch + crypto.
- **core:** 12 new tests (`struggle-detector-classifier.test.ts`) cover `featurize()` layout + stats correctness + classifier blend math + fallback on null/throw.
- **ai-engine:** 18 new tests (`local-provider-onnx.test.ts`) cover `embed()` pseudo-fallback + T5 summarize path + force-fallback + timeout; plus 6 cache semantic-key tests.

Total Session 12 additions: **~62 tests**, running alongside the existing 629.

## Operations

**Toggle a tier on/off** — popup Settings → *On-Device AI Models*. Tier 0 is on by default; Tier 1/2 default off (bandwidth-aware).

**Check model status live** — side panel → *On-Device Models*. Shows loaded/loading/failed state per tier, cache size, fallback count, per-model inference count + average latency, and a **Force fallback** debug toggle for comparing ONNX vs. heuristic paths in demos.

**Clear the model cache** — popup Settings → *On-Device AI Models* → Clear Cache. Unloads all sessions and wipes the IDB store; next Download pulls fresh bytes.

**Troubleshoot a failed load** — the tier row in the popup shows the truncated error. Common ones:

| Error | Cause | Fix |
|-------|-------|-----|
| `ort-unavailable` | onnxruntime-web failed to load (CSP / missing WASM) | Check DevTools console for the ort import error |
| `fetch-status:404` | VPS doesn't yet have the `.onnx` at that path | Upload the binary to `/opt/accessbridge/models/` |
| `integrity-mismatch:...` | Fetched bytes don't match registered SHA-256 | Re-upload the binary OR update the hash in `model-registry.ts` |
| `session-create-failed:...` | ONNX bytes are corrupt or use an unsupported op | Re-export with a plain-CPU-friendly opset |
