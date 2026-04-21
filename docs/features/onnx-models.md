# Feature: On-Device ONNX Models

**Status:** Tier 0 functional + bundled with the extension (Session 14, 2026-04-21). Tier 1 weights live on the CDN with SHA pinning; functional inference requires the WordPiece tokenizer + embedding pooling code still being deferred. Tier 2 (T5 beam-search decoder) remains deferred to Session 15.

Session 14 closed the loop on the Session 12/13 infrastructure:

- **Real XGBoost struggle classifier** trained on 5 000 synthetic 60-dim feature vectors (weighted-sum labels mirroring the heuristic) and exported through `onnxmltools.convert_xgboost` to a ~0.9 MB ONNX file. Ships **bundled** in the extension zip under `dist/models/` — no network fetch at startup, works offline.
- **All-MiniLM-L6-v2 int8** downloaded from `Xenova/all-MiniLM-L6-v2` (HF) and uploaded to the VPS CDN at `http://72.61.227.64:8300/models/all-MiniLM-L6-v2-int8.onnx` (~22 MB quantized, well below the planned 80 MB). Registry SHA-256 pinned; integrity-verified on every fetch.
- **`onnxruntime-web/wasm` bundled** into the extension (~72 KB JS + 12 MB WASM under `dist/ort/`). Runtime configures `env.wasm.wasmPaths = chrome.runtime.getURL('ort/')` so inference stays fully offline once the extension is installed.
- **Manifest CSP** adds `'wasm-unsafe-eval'`; `web_accessible_resources` exposes `models/*.onnx`, `ort/*.wasm`, `ort/*.mjs` to the page origin only where needed.

The prepare-models toolchain lives under `tools/prepare-models/`: `train-struggle-classifier.py`, `download-hf-models.py`, `compute-hashes.sh`, `upload-to-vps.sh`, plus `tools/validate-models.sh` for post-upload verification. Re-running the five scripts in sequence regenerates every binary + the `models-manifest.json` (committed — the manifest is the single source of truth for hash values copied into `model-registry.ts`).

**Tier 2 summarization still returns null → heuristic extractive fallback.** The T5 registry entry keeps `sha256: null` so the integrity gate stays armed once real weights arrive.

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

| Tier | Model | Source | Size | Auto-load | Purpose |
|------|-------|--------|------|-----------|---------|
| 0 | `struggle-classifier-v1` | Bundled in extension (`dist/models/`) | ~0.85 MB | ✅ 2s after SW start (if profile toggle on) | Blend into heuristic struggle score when classifier confidence > 0.7 |
| 1 | `minilm-l6-v2` | VPS CDN, int8 quantized | ~22 MB | Manual (popup Download button) | 384-dim sentence embeddings → semantic cache key + future dedup |
| 2 | `t5-small` | VPS CDN (deferred to Session 15) | ~242 MB planned | Manual | Abstractive summarization when heuristic extractive isn't enough |
| 3 | `indic-whisper-small` | VPS CDN (Session 17 infra; real weights + hash Session 18) | ~80 MB planned | Manual (popup Download button) | Speech-to-text for all 22 Indian languages. Upstream is `openai/whisper-small` (MIT, 99-language multilingual) branded `indic-whisper-*` to preserve the option to swap to AI4Bharat IndicConformer once a Conformer ONNX export path exists. Decoder loop (language-forcing tokens + autoregressive beam search) lands Session 18. |

**Total CDN footprint:** ~22 MB today (Tier 1 only). Tier 0 ships in the extension zip — no download, no network. Tier 2 + Tier 3 placeholders keep the registry four-tier for forward compatibility. After Session 18 decoder + Session 18 upload, the CDN footprint becomes ~22 MB (Tier 1) + ~242 MB (Tier 2) + ~80 MB (Tier 3) ≈ 345 MB total.

## Session 17 — Indic Whisper STT infrastructure

What shipped:

- `@accessbridge/onnx-runtime`: `IndicWhisper` wrapper class, `audio-preprocessor` utilities (`preprocessAudio`, `resample`, `chunkAudio`, `normalizeFloat32`), `BCP47_TO_WHISPER` 22-language map, `FALLBACK_LANGUAGES` set for the 7 non-native codes that map to nearest-script cousins (Konkani→Marathi, Kashmiri→Urdu, etc.).
- `@accessbridge/onnx-runtime` `MODEL_REGISTRY[INDIC_WHISPER_ID]`: loadTier 3, url + tokenizer metadata pinned, `sha256: null` until first upload.
- Extension background: `INDIC_WHISPER_TRANSCRIBE` + `VOICE_TIER_RECORD` message handlers. Tier 3 slotted into the existing `ONNX_LOAD_TIER` / `ONNX_GET_STATUS` / `ONNX_UNLOAD_TIER` path. `IndicWhisper` singleton wired into `wireOnnxModelsIntoPipeline`.
- Extension content: `TieredSTT` class (`packages/extension/src/content/motor/tiered-stt.ts`) picks Tier A vs B via a pure `pickTier()` function driven by preference + language + recent-confidence rolling window.
- Extension popup: `VoiceTierPanel` on the Motor tab — tier strategy select + IndicWhisper download button + status pill. Download is gated by a runtime warning noting the sha is null until weights upload.
- Observatory: per-tier voice counters (`voice_tier_counts: {'a','b','c'}`), Laplace-noised in the daily bundle. Server-side canonicalization of the new field is deferred to the next observatory deploy — the client intentionally does NOT fold `voice_tier_counts` into the merkle root to stay compatible with the currently-deployed server (matches the Session 12 approach for `onnx_inferences`).
- Profile: `MotorProfile.voiceQualityTier` + `MotorProfile.indicWhisperEnabled`; `AccessibilityProfile.onnxModelsEnabled.indicWhisper` toggle.
- Tests: audio-preprocessor (22), indic-whisper (34 incl. proto-pollution guard), tiered-stt (20). Observatory-publisher regression still green (14).
- Python prep: `tools/prepare-models/download-indicwhisper.py` + `evaluate-indicwhisper.py`, plus extensions to `upload-to-vps.sh` + `compute-hashes.sh` + `models-manifest.json`. Scripts are artifacts — user runs them when ready to generate the ~80 MB quantized ONNX.

What is deferred to Session 18:

- Whisper decoder autoregressive loop with language-forcing tokens.
- Actually running `download-indicwhisper.py` + uploading the real weights to the VPS CDN + populating the real sha256.
- Content-side TieredSTT wire-in (instantiation in `content/index.ts` + live profile-update propagation).
- Voice Lab side-panel demo surface.
- Server-side canonicalization for `voice_tier_counts` so the counters enter the merkle tree.

Until Session 18 lands, calling `IndicWhisper.transcribe()` on a loaded model returns `{real: false, text: '', confidence: 0, latencyMs: <preprocess wall clock>}` — the wrapper surface + observability + tiered fallback can all be tested end-to-end without real transcription.

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

- Tier 0 weights ship **inside the extension** — zero network access at startup or inference. Packaged under `dist/models/struggle-classifier-v1.onnx`, referenced via `chrome.runtime.getURL`.
- Tier 1 downloads from the VPS nginx CDN over HTTP (same host + port as `/api/version`, covered by existing `<all_urls>` host permission — no new manifest permission). HTTP trust is backstopped by SHA-256 integrity: any MITM-altered bytes fail the hash compare before `InferenceSession.create()` runs.
- Model binaries are cached in IndexedDB (`accessbridge-onnx-cache`). Nothing is ever uploaded back.
- Inference happens 100 % on device. The 60-dim struggle feature vector, the text being embedded, and the text being summarized **never leave the browser**. The only telemetry is a Laplace-noised per-tier inference count — opt-in, identical mechanism to existing observatory counters.

## Integrity

`MODEL_REGISTRY[id].sha256` holds the lower-case hex SHA-256 of the ONNX bytes for every model with a real binary. The runtime computes `crypto.subtle.digest('SHA-256', buffer)` after fetch and before writing to the IDB cache; a mismatch rejects the load with `integrity-mismatch:expected=... actual=...` and no session is created. Current pinned hashes (2026-04-21):

| Model | SHA-256 | Size |
|-------|---------|------|
| `struggle-classifier-v1` | `174695b3a7c3b2e1b42aa4ce72b827ea58e982954aa7a5fa434d2f780d810589` | 868 691 bytes |
| `minilm-l6-v2` | `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1` | 22 972 370 bytes |
| `minilm-tokenizer.json` (companion) | `da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0` | 711 661 bytes |
| `t5-small` | `null` (deferred) | planned ~242 MB |

These come from `tools/prepare-models/output/models-manifest.json` and are copy-verified into the TypeScript registry at commit time.

## Model provenance

- **Struggle classifier (Tier 0)** — own-trained via `tools/prepare-models/train-struggle-classifier.py`. XGBoost `multi:softprob`, n_estimators=100, max_depth=6, lr=0.1, 4-class softmax (`none / low / medium / high`). Synthetic data only, 5 000 samples with a weighted-sum label formula that mirrors the heuristic (bias toward CLICK_ACCURACY / DWELL_TIME / BACKSPACE_RATE / ERROR_RATE). License MIT. Will be retrained on real pilot data post-launch.
- **MiniLM (Tier 1)** — `Xenova/all-MiniLM-L6-v2`, `onnx/model_quantized.onnx` variant. Upstream license Apache-2.0 (sentence-transformers). Companion tokenizer from the same HF repo.
- **T5-small (Tier 2, deferred)** — `Xenova/t5-small` planned. Upstream license Apache-2.0.

## Deferred work

| Item | Why | Session |
|------|-----|---------|
| WordPiece tokenizer for MiniLM inference | Needs vocab.txt + trie; mean-pooling over last_hidden_state | 15 |
| T5 SentencePiece tokenizer + beam-search decode | Non-trivial autoregressive loop with KV-cache | 15 |
| Upload real T5-small int8 `.onnx` + tokenizer | Gated on decode implementation | 15 |
| WebGPU backend | Faster but CSP-constrained in MV3; WASM SIMD default works | 16+ |
| Re-train classifier on pilot data | Needs real user rollout | post-pilot |

## Prepare-models toolchain

```text
tools/prepare-models/
├── train-struggle-classifier.py   # synth data + XGBoost + ONNX export (seed=42 for determinism)
├── download-hf-models.py          # hf_hub_download of Xenova/all-MiniLM-L6-v2 pre-quantized
├── compute-hashes.sh              # sha256sum + size → output/models-manifest.json
├── upload-to-vps.sh               # rsync with scp fallback (BUG-011), chmod 644, public curl smoke
└── output/                        # gitignored — regenerate via the scripts above

tools/
└── validate-models.sh             # curl each URL, compare HTTP / Content-Length / SHA-256 / CORS
```

Run order after every model change: `train → download → hash → upload → validate`. Hashes from the freshly computed manifest get copy-verified into [packages/onnx-runtime/src/model-registry.ts](packages/onnx-runtime/src/model-registry.ts).

## Testing

- **onnx-runtime package:** 41 tests (`runtime.test.ts` 16 + `struggle-classifier.test.ts` 15 + `model-registry.test.ts` 10) cover load path with mocked onnxruntime-web + IndexedDB + fetch + crypto, integrity gating, `wasmPathBase`, `bundledUrlResolver`, and the Tier 0 bundled-path code path.
- **core:** 12 tests (`struggle-detector-classifier.test.ts`) cover `featurize()` layout + stats correctness + classifier blend math + fallback on null/throw.
- **ai-engine:** 18 tests (`local-provider-onnx.test.ts`) cover `embed()` pseudo-fallback + T5 summarize path + force-fallback + timeout; plus 6 cache semantic-key tests.

Total on-device-ONNX tests (Session 12 + 14): **~77**, running alongside the remaining 750+ tests.

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
