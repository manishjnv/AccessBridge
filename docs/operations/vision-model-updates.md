# Vision Model Updates — Operator Runbook

> **Target audience:** VPS operators refreshing the Moondream2 (or successor) on-device vision-language model that powers Tier 3 Vision-Assisted Semantic Recovery (Feature #5).
> **Related docs:** [vision-recovery.md](../features/vision-recovery.md), [onnx-models.md](../features/onnx-models.md).

## Model identity

| Field | Value |
|---|---|
| Upstream checkpoint | `Xenova/moondream2` (Apache 2.0, HuggingFace) |
| Local alias | `moondream2-int8` |
| Tier | 4 (opt-in; requires explicit user download) |
| Quantization | INT8 dynamic (onnxruntime.quantization) |
| Files | `moondream2-vision-int8.onnx` (~90 MB), `moondream2-text-int8.onnx` (~90 MB), `moondream2-tokenizer.json` (~2 MB), `moondream2-image-preprocessor.json` (<1 KB) |
| CDN base | `http://72.61.227.64:8300/models/` |
| Integrity | SHA-256 pinned in `packages/onnx-runtime/src/model-registry.ts` + `tools/prepare-models/output/models-manifest.json` |

## Refresh procedure

The model refresh is a four-stage pipeline. The local Windows dev box produces artifacts; the VPS operator ships them; the extension picks them up on next SW start.

### Stage 1 — Produce new quantized artifacts (local dev box)

```bash
cd tools/prepare-models
pip install transformers huggingface_hub onnx onnxruntime optimum[onnxruntime] Pillow numpy

# Pin the upstream revision. Default is main; always pin for repeatability.
python download-moondream.py --revision <commit-sha-or-tag> \
  --output-dir ./output/moondream
```

This emits the 4 files listed above under `output/moondream/`. The script refuses to silently overwrite existing outputs — delete or move them first.

### Stage 2 — Evaluate quality

```bash
python evaluate-moondream.py \
  --model-dir ./output/moondream \
  --out ./moondream-quality-report.json
```

The evaluator runs 20 synthetic UI screenshots (buttons, icons, menus, dialogs, forms) through the quantized model and writes a quality report. **Reject the new model** if any of:

- `token_overlap_pct < 60` (quality regression)
- `p95_latency_ms > 800` (too slow to be useful)
- `mean_latency_ms > 500` across full 20-case run
- Model size total > 220 MB (size regression; quantization must have silently fallen back to FP16/FP32)
- Any case crashes with a non-`null` error in `per_case[i].error`

Keep the prior verified model on disk until the new one is ratified.

### Stage 3 — Hash + manifest + upload

```bash
# Recompute SHA-256 + emit models-manifest.json
bash compute-hashes.sh

# Upload artifacts + manifest to VPS /opt/accessbridge/models/
bash upload-to-vps.sh
```

`upload-to-vps.sh` uses rsync with scp-fallback (see RCA BUG-011). Each file is hash-verified via curl after upload and listed with OK/FAIL status.

### Stage 4 — Update registry + validate

Update `packages/onnx-runtime/src/model-registry.ts` — replace the `sha256: null` placeholders on the `moondream2-int8` entry with the new hashes from `output/moondream/models-manifest.json`. Same for `sizeBytes` if they changed.

Then:

```bash
pnpm build         # rebuild extension
pnpm -r test       # all tests must still pass
pnpm typecheck     # strict typecheck, all packages
bash tools/validate-models.sh    # confirms each pinned hash matches the VPS-hosted artifact
```

Commit via `./deploy.sh` — the deploy pipeline will ship the rebuilt extension zip alongside the new registry.

## Retention policy

- The prior model MUST remain on the VPS until the new one has been deployed AND at least 24 hours have elapsed AND no BUG-XXX entries have been filed against it in `RCA.md`.
- Old model files live at `/opt/accessbridge/models/moondream2-*-v<N-1>.onnx` (if a version suffix is added on next rollout). For the current single-version layout, the rollback is `git revert` of the registry commit + re-upload of the old files.

## Hot-swap during runtime

The extension verifies `sha256` on every model load. When a user's cached-in-IndexedDB copy's hash no longer matches the registry, the runtime:

1. Treats the cache entry as stale, evicts it.
2. Re-fetches from the VPS CDN.
3. Verifies the new hash.
4. Re-opens the InferenceSession.

No extension restart is required. The user sees a brief "Updating on-device model…" progress row in Settings → On-Device AI Models.

## Rollback triggers

Roll back (registry commit revert + old model re-upload) if any of:

- **Regression RCA:** a `BUG-XXX` entry is filed in `RCA.md` whose symptom section references Tier 3 / Moondream / on-device VLM.
- **Hash mismatch storm:** more than 1 % of `wasm-unsafe-eval` failures in the Observatory error bucket within the first 24 h.
- **Latency regression:** mean Tier 3 latency jumps > 30 % in the observability `feature-usage` endpoint vs the pre-rollout 7-day baseline.
- **Quality regression:** Vision Lab user curation shows a statistically significant increase in `status: rejected` for Tier 3 labels (tracked via the Session 24+ domain-learning loop).

## Privacy invariants — do not violate

- **Never host user screenshots on the VPS.** The VPS only ever serves model weights. All inference happens on-device.
- **Never ship a model whose SHA-256 is `null` in a release.** The integrity gate must always be armed.
- **Never serve the model over plain HTTP that could be MITMed.** Port 8300 sits behind Cloudflare (shared edge); TLS is enforced by the edge. If the edge is removed, switch to HTTPS on a direct port before merging.
- **Never bundle the 180 MB model into `accessbridge-extension.zip`.** It stays on the CDN. Users opt-in explicitly in Settings.

## See also

- [docs/features/vision-recovery.md](../features/vision-recovery.md) — feature architecture
- [docs/features/onnx-models.md](../features/onnx-models.md) — generic ONNX tier infrastructure
- [tools/prepare-models/README-moondream.md](../../tools/prepare-models/README-moondream.md) — script-level reference
- [RCA.md](../../RCA.md) — precedent bugs: BUG-010 (Cloudflare cache), BUG-011 (deploy.sh rsync), BUG-012 (chunk imports)
