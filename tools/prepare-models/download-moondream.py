#!/usr/bin/env python3
"""
download-moondream.py  —  AccessBridge Session 23 Part 1 (Feature #5 Tier 3 Vision Recovery)
Downloads Xenova/moondream2 (Apache 2.0, ONNX-native) from HuggingFace,
copies or quantizes the vision encoder + text decoder to INT8, extracts
the tokenizer, writes the image preprocessor config, and emits a metadata
manifest.

Upstream: Xenova/moondream2
License:  Apache 2.0

Usage:
    pip install transformers huggingface_hub onnx onnxruntime optimum[onnxruntime]
    python download-moondream.py [--output-dir ./output/moondream] [--skip-quantize] [--revision main]
"""

import argparse
import datetime
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

LOG = "[moondream]"

CHECKPOINT = "Xenova/moondream2"

# Static image preprocessor config (ImageNet normalisation, 378 px target).
IMAGE_PREPROCESSOR = {
    "target_size": 378,
    "mean": [0.485, 0.456, 0.406],
    "std":  [0.229, 0.224, 0.225],
    "resample": "bilinear",
}

# ---------------------------------------------------------------------------
# ONNX file-name patterns emitted by Xenova repos (priority order).
# The repo ships several variants; we prefer these.
# ---------------------------------------------------------------------------
VISION_CANDIDATES = [
    "vision_encoder.onnx",
    "vision_encoder_quantized.onnx",
    "vision_encoder_int8.onnx",
]

TEXT_CANDIDATES = [
    "decoder_model_merged.onnx",
    "text_decoder.onnx",
    "text_model.onnx",
    "decoder_model.onnx",
    "text_decoder_quantized.onnx",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def log(msg: str) -> None:
    print(f"{LOG} {msg}", flush=True)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def summarise_file(path: Path, label: str) -> None:
    size = path.stat().st_size
    digest = sha256_file(path)
    log(f"  {label}")
    log(f"    size   : {human_size(size)} ({size:,} bytes)")
    log(f"    sha256 : {digest}")


# ---------------------------------------------------------------------------
# HuggingFace snapshot download
# ---------------------------------------------------------------------------

def snapshot_download_model(checkpoint: str, revision: str, local_dir: Path) -> Path:
    """
    Downloads all files for the given HF repo into local_dir.
    Returns local_dir.
    """
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        raise SystemExit(
            f"{LOG} ERROR: huggingface_hub not installed.\n"
            "  pip install huggingface_hub"
        )

    log(f"Downloading snapshot: {checkpoint} @ {revision}")
    log("  NOTE: This may take several minutes — the repo contains ONNX binaries.")
    try:
        snapshot_download(
            repo_id=checkpoint,
            revision=revision,
            local_dir=str(local_dir),
            local_dir_use_symlinks=False,
        )
    except Exception as exc:
        raise SystemExit(
            f"{LOG} ERROR: snapshot_download failed: {exc}\n"
            "  Check your internet connection and HF token (if repo is gated)."
        )
    return local_dir


# ---------------------------------------------------------------------------
# INT8 quantization
# ---------------------------------------------------------------------------

def is_already_quantized(path: Path) -> bool:
    """
    Heuristic: if the filename contains 'quantized' or 'int8' it is likely
    already quantized by Xenova's pipeline; we copy rather than re-quantize.
    """
    stem = path.name.lower()
    return "quantized" in stem or "int8" in stem


def quantize_onnx(src: Path, dst: Path) -> None:
    try:
        from onnxruntime.quantization import quantize_dynamic, QuantType
    except ImportError:
        raise SystemExit(
            f"{LOG} ERROR: onnxruntime.quantization not available.\n"
            "  pip install onnxruntime"
        )
    log(f"  Quantizing {src.name} -> {dst.name} (int8 dynamic) ...")
    quantize_dynamic(
        model_input=str(src),
        model_output=str(dst),
        weight_type=QuantType.QInt8,
        optimize_model=False,
    )
    log("  Quantization done.")


# ---------------------------------------------------------------------------
# File selection from snapshot
# ---------------------------------------------------------------------------

def pick_onnx_file(snapshot_dir: Path, candidates: list, role: str) -> Path:
    """
    Walk snapshot_dir (and onnx/ sub-directory) looking for candidate names.
    Returns the first match.  Raises SystemExit listing what was found if none
    match — gives the user enough info to extend VISION_CANDIDATES/TEXT_CANDIDATES.
    """
    search_dirs = [snapshot_dir, snapshot_dir / "onnx"]
    for d in search_dirs:
        if not d.exists():
            continue
        for name in candidates:
            p = d / name
            if p.exists():
                log(f"  Found {role} file: {p.relative_to(snapshot_dir)}")
                return p

    # Not found — list what *.onnx files we do have so the user can debug.
    found = sorted(
        str(p.relative_to(snapshot_dir))
        for d in search_dirs if d.exists()
        for p in d.glob("*.onnx")
    )
    raise SystemExit(
        f"{LOG} WARN: No matching {role} ONNX file found in snapshot.\n"
        f"  Searched candidates: {candidates}\n"
        f"  ONNX files present : {found if found else '(none)'}\n"
        "  Extend VISION_CANDIDATES / TEXT_CANDIDATES in this script or "
        "file a bug."
    )


# ---------------------------------------------------------------------------
# Tokenizer extraction
# ---------------------------------------------------------------------------

def extract_tokenizer(checkpoint: str, revision: str, output_dir: Path) -> Path:
    """
    Downloads the HF processor/tokenizer and writes moondream2-tokenizer.json.
    Returns the path to the written file.
    """
    try:
        from transformers import AutoProcessor
    except ImportError:
        raise SystemExit(
            f"{LOG} ERROR: transformers not installed.\n"
            "  pip install transformers"
        )

    log(f"Downloading tokenizer/processor from {checkpoint} ...")
    proc = AutoProcessor.from_pretrained(checkpoint, revision=revision)
    tok = proc.tokenizer

    tok_dst = output_dir / "moondream2-tokenizer.json"
    tok.save_pretrained(str(output_dir))

    raw = output_dir / "tokenizer.json"
    if raw.exists():
        shutil.move(str(raw), str(tok_dst))
        log(f"  Moved tokenizer.json -> {tok_dst.name}")
    elif tok_dst.exists():
        pass  # already written by save_pretrained under our target name
    else:
        raise FileNotFoundError(
            "tokenizer.json was not written by AutoProcessor.tokenizer.save_pretrained()."
        )

    # Remove intermediate files we don't ship.
    for extra in (
        "tokenizer_config.json",
        "special_tokens_map.json",
        "vocab.json",
        "merges.txt",
        "added_tokens.json",
        "normalizer.json",
        "preprocessor_config.json",
    ):
        p = output_dir / extra
        if p.exists():
            p.unlink()
            log(f"  Removed intermediate file: {extra}")

    return tok_dst


# ---------------------------------------------------------------------------
# Image preprocessor config
# ---------------------------------------------------------------------------

def write_image_preprocessor(output_dir: Path) -> Path:
    out_path = output_dir / "moondream2-image-preprocessor.json"
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(IMAGE_PREPROCESSOR, fh, indent=2)
    log(f"Image preprocessor config written: {out_path.name}")
    return out_path


# ---------------------------------------------------------------------------
# Metadata manifest
# ---------------------------------------------------------------------------

def write_tokens_manifest(
    output_dir: Path,
    quantization: str,
    revision: str,
) -> Path:
    exported_at = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = {
        "checkpoint":    CHECKPOINT,
        "revision":      revision,
        "quantization":  quantization,
        "exported_at":   exported_at,
        "vision_file":   "moondream2-vision-int8.onnx",
        "text_file":     "moondream2-text-int8.onnx",
        "tokenizer":     "moondream2-tokenizer.json",
        "preprocessor":  "moondream2-image-preprocessor.json",
    }
    out_path = output_dir / "moondream2-tokens-to-manifest.json"
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    log(f"Metadata manifest written: {out_path.name}")
    return out_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Download Xenova/moondream2, copy or INT8-quantize the vision encoder "
            "and text decoder ONNX artifacts, extract the tokenizer, and write the "
            "AccessBridge moondream2 model artifacts."
        )
    )
    parser.add_argument(
        "--output-dir",
        default="./output/moondream",
        help="Directory to write all outputs (default: ./output/moondream)",
    )
    parser.add_argument(
        "--skip-quantize",
        action="store_true",
        help=(
            "Skip INT8 quantization — copy files as-is from the snapshot. "
            "Useful for fast iteration; outputs may be FP32 if the upstream "
            "repo ships FP32."
        ),
    )
    parser.add_argument(
        "--revision",
        default="main",
        help="HuggingFace revision / branch / tag to pin (default: main)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    log(f"Output directory : {output_dir.resolve()}")
    log(f"Checkpoint       : {CHECKPOINT}")
    log(f"Revision         : {args.revision}")
    log(f"Skip quantize    : {args.skip_quantize}")

    import tempfile

    with tempfile.TemporaryDirectory(prefix="moondream-snapshot-") as tmp_str:
        snapshot_dir = Path(tmp_str)

        # --- Step 1: Download snapshot ---
        log("Step 1/5: Downloading HuggingFace snapshot ...")
        snapshot_download_model(CHECKPOINT, args.revision, snapshot_dir)

        # --- Step 2: Vision encoder ---
        log("Step 2/5: Processing vision encoder ...")
        vision_src = pick_onnx_file(snapshot_dir, VISION_CANDIDATES, "vision encoder")

        if args.skip_quantize:
            vision_dst = output_dir / "moondream2-vision-int8.onnx"
            shutil.copy2(vision_src, vision_dst)
            log(f"  Copied (no quantize): {vision_dst.name}")
        elif is_already_quantized(vision_src):
            vision_dst = output_dir / "moondream2-vision-int8.onnx"
            shutil.copy2(vision_src, vision_dst)
            log(f"  Pre-quantized upstream file copied: {vision_dst.name}")
        else:
            vision_dst = output_dir / "moondream2-vision-int8.onnx"
            quantize_onnx(vision_src, vision_dst)

        # --- Step 3: Text decoder ---
        log("Step 3/5: Processing text decoder ...")
        text_src = pick_onnx_file(snapshot_dir, TEXT_CANDIDATES, "text decoder")

        if args.skip_quantize:
            text_dst = output_dir / "moondream2-text-int8.onnx"
            shutil.copy2(text_src, text_dst)
            log(f"  Copied (no quantize): {text_dst.name}")
        elif is_already_quantized(text_src):
            text_dst = output_dir / "moondream2-text-int8.onnx"
            shutil.copy2(text_src, text_dst)
            log(f"  Pre-quantized upstream file copied: {text_dst.name}")
        else:
            text_dst = output_dir / "moondream2-text-int8.onnx"
            quantize_onnx(text_src, text_dst)

    # --- Step 4: Tokenizer ---
    log("Step 4/5: Extracting tokenizer ...")
    tok_path = extract_tokenizer(CHECKPOINT, args.revision, output_dir)

    # --- Step 5: Preprocessor config + metadata manifest ---
    log("Step 5/5: Writing preprocessor config and metadata manifest ...")
    preprocessor_path = write_image_preprocessor(output_dir)
    quantization = "fp32-none" if args.skip_quantize else "int8-dynamic"
    manifest_path = write_tokens_manifest(output_dir, quantization, args.revision)

    # --- Final summary ---
    outputs = [
        (vision_dst,       "moondream2-vision-int8.onnx"),
        (text_dst,         "moondream2-text-int8.onnx"),
        (tok_path,         "moondream2-tokenizer.json"),
        (preprocessor_path, "moondream2-image-preprocessor.json"),
        (manifest_path,    "moondream2-tokens-to-manifest.json"),
    ]

    log("")
    log("=" * 60)
    log("Output summary:")
    for path, label in outputs:
        if path.exists():
            summarise_file(path, label)
        else:
            log(f"  {label} — NOT FOUND (check errors above)")

    log("")
    log("All outputs written. Ready to run compute-hashes.sh and upload-to-vps.sh")
    log("  cd tools/prepare-models && ./compute-hashes.sh && ./upload-to-vps.sh")


if __name__ == "__main__":
    main()
