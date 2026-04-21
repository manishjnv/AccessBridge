# Moondream2 Model Preparation — AccessBridge Feature #5 Tier 3

Prepares the `Xenova/moondream2` (Apache 2.0) ONNX artifacts for the
AccessBridge Tier 3 Vision Recovery pipeline (Session 23).

## Prerequisites

```bash
pip install transformers huggingface_hub onnx onnxruntime optimum[onnxruntime] Pillow numpy
```

Python 3.10+ required (tested on 3.14).

## Step 1 — Download & quantize

```bash
cd tools/prepare-models
python download-moondream.py
# Optional flags:
#   --output-dir ./output/moondream   (default)
#   --skip-quantize                   copy upstream files without re-quantizing
#   --revision main                   pin a specific HF commit/tag
```

Output files written to `output/moondream/`:

| File | Description |
|------|-------------|
| `moondream2-vision-int8.onnx` | Vision encoder, INT8 dynamic quantized |
| `moondream2-text-int8.onnx` | Text decoder, INT8 dynamic quantized |
| `moondream2-tokenizer.json` | HF fast tokenizer |
| `moondream2-image-preprocessor.json` | mean/std/target_size config (378 px, ImageNet) |
| `moondream2-tokens-to-manifest.json` | Checkpoint + quantization metadata |

## Step 2 — Evaluate quality / latency

```bash
python evaluate-moondream.py
# Optional flags:
#   --model-dir ./output/moondream    (default)
#   --out ./moondream-quality-report.json
```

Generates 20 synthetic UI screenshots (buttons, icon buttons, menus,
dialogs, form inputs) and benchmarks token-overlap accuracy and inference
latency.  If models are absent the script writes a `skipped` report and
exits 0 (CI-safe).

## Step 3 — Hash & upload

```bash
./compute-hashes.sh        # updates output/models-manifest.json
./upload-to-vps.sh         # rsyncs artifacts to VPS /opt/accessbridge/models/
```

Both scripts are safe to re-run; missing Moondream files produce WARNs
and are skipped rather than crashing.

## Architecture note

The runtime in the desktop agent loads `moondream2-vision-int8.onnx` first
to embed the screenshot, then passes the embedding to `moondream2-text-int8.onnx`
for caption generation.  The `moondream2-image-preprocessor.json` config is
consumed by the JS/Rust pre-processing layer (resize to 378 px, ImageNet
normalisation).
