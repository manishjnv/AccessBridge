#!/usr/bin/env python3
"""
download-indicwhisper.py  —  AccessBridge Session 17
Downloads openai/whisper-small from HuggingFace, exports to ONNX, applies
int8 dynamic quantization, and writes the language-map manifest.

Output filenames are branded indic-whisper-* per AccessBridge spec even
though the upstream checkpoint is openai/whisper-small (MIT license,
99-language multilingual, covers all 22 Indian languages needed).

Usage:
    pip install transformers optimum[onnxruntime] onnxruntime
    python download-indicwhisper.py [--output-dir ./output/indic-whisper] [--skip-quantize]
"""

import argparse
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

LOG = "[indic-whisper]"

# ---------------------------------------------------------------------------
# Language table
# 15 languages Whisper supports natively (ISO 639-1).
# 7 languages without dedicated Whisper tokens — mapped to nearest script
# family and flagged with native_support=False.
# ---------------------------------------------------------------------------
LANGUAGES = [
    # BCP-47,       whisper_code, display_name,        native, notes
    ("hi-IN",  "hi",  "Hindi",          True,  None),
    ("bn-IN",  "bn",  "Bengali",        True,  None),
    ("ta-IN",  "ta",  "Tamil",          True,  None),
    ("te-IN",  "te",  "Telugu",         True,  None),
    ("mr-IN",  "mr",  "Marathi",        True,  None),
    ("gu-IN",  "gu",  "Gujarati",       True,  None),
    ("kn-IN",  "kn",  "Kannada",        True,  None),
    ("ml-IN",  "ml",  "Malayalam",      True,  None),
    ("pa-IN",  "pa",  "Punjabi",        True,  None),
    ("ur-IN",  "ur",  "Urdu",           True,  None),
    ("as-IN",  "as",  "Assamese",       True,  None),
    ("sa-IN",  "sa",  "Sanskrit",       True,  None),
    ("ne-IN",  "ne",  "Nepali",         True,  None),
    ("or-IN",  "or",  "Odia",           True,  None),
    ("si-IN",  "si",  "Sinhala",        True,  None),
    # --- fallback mappings ---
    ("kok",    "mr",  "Konkani",        False,
     "Whisper has no Konkani token; falls back to Marathi script family"),
    ("ks",     "ur",  "Kashmiri",       False,
     "Whisper has no Kashmiri token; falls back to Urdu (Perso-Arabic script family)"),
    ("mni",    "hi",  "Manipuri",       False,
     "Whisper has no Manipuri token; falls back to Hindi"),
    ("brx",    "hi",  "Bodo",           False,
     "Whisper has no Bodo token; falls back to Hindi"),
    ("sat",    "hi",  "Santali",        False,
     "Whisper has no Santali token; falls back to Hindi"),
    ("mai",    "hi",  "Maithili",       False,
     "Whisper has no Maithili token; falls back to Hindi"),
    ("doi",    "hi",  "Dogri",          False,
     "Whisper has no Dogri token; falls back to Hindi"),
    ("sd",     "ur",  "Sindhi",         False,
     "Whisper has no Sindhi token; falls back to Urdu (Perso-Arabic script family)"),
]

CHECKPOINT = "openai/whisper-small"


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
# ONNX export via optimum
# ---------------------------------------------------------------------------

def export_onnx(checkpoint: str, export_dir: Path) -> None:
    """
    Calls optimum-cli to export the Whisper encoder+decoder to ONNX.
    Optimum for Whisper always emits at minimum:
        encoder_model.onnx / decoder_model.onnx / decoder_model_merged.onnx
    We prefer decoder_model_merged.onnx when present (covers all decoding
    paths in one file).
    """
    log(f"Exporting {checkpoint} to ONNX via optimum-cli ...")
    log("  NOTE: This step takes ~10-20 minutes on CPU and needs ~8 GB RAM.")

    cmd = [
        sys.executable, "-m", "optimum.exporters.onnx",
        "--model", checkpoint,
        "--task", "automatic-speech-recognition",
        str(export_dir),
    ]
    log(f"  Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=False)
    if result.returncode != 0:
        raise RuntimeError(
            f"optimum ONNX export failed with exit code {result.returncode}. "
            "Install with: pip install optimum[onnxruntime]"
        )


def pick_decoder_onnx(export_dir: Path) -> Path:
    """
    Return the best single decoder file emitted by optimum.
    Priority: decoder_model_merged.onnx > decoder_model.onnx
    """
    merged = export_dir / "decoder_model_merged.onnx"
    plain  = export_dir / "decoder_model.onnx"
    if merged.exists():
        log("  Found decoder_model_merged.onnx (preferred — covers all decode paths).")
        return merged
    if plain.exists():
        log("  WARNING: decoder_model_merged.onnx not found; using decoder_model.onnx.")
        log("  The extension's WhisperSession must load encoder+decoder separately.")
        return plain
    raise FileNotFoundError(
        f"Neither decoder_model_merged.onnx nor decoder_model.onnx found in {export_dir}"
    )


# ---------------------------------------------------------------------------
# int8 quantization
# ---------------------------------------------------------------------------

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
        optimize_model=False,   # keep graph identical; optimum already optimises
    )
    log(f"  Quantization done.")


# ---------------------------------------------------------------------------
# Tokenizer extraction
# ---------------------------------------------------------------------------

def extract_tokenizer(checkpoint: str, output_dir: Path) -> Path:
    """
    Downloads the HF tokenizer and writes a single tokenizer.json to output_dir.
    Returns the path to the written file.
    """
    try:
        from transformers import AutoProcessor
    except ImportError:
        raise SystemExit(
            f"{LOG} ERROR: transformers not installed.\n"
            "  pip install transformers"
        )
    log(f"Downloading tokenizer from {checkpoint} ...")
    proc = AutoProcessor.from_pretrained(checkpoint)
    # AutoProcessor wraps WhisperProcessor; .tokenizer holds the fast tokenizer.
    tok = proc.tokenizer

    tok_json_path = output_dir / "indic-whisper-tokenizer.json"
    tok.save_pretrained(str(output_dir))

    # HF saves tokenizer.json in the directory; rename if needed.
    raw = output_dir / "tokenizer.json"
    if raw.exists():
        shutil.move(str(raw), str(tok_json_path))
        log(f"  Moved tokenizer.json -> {tok_json_path.name}")
    elif tok_json_path.exists():
        pass  # already in place
    else:
        raise FileNotFoundError(
            "tokenizer.json was not written by AutoProcessor.tokenizer.save_pretrained()."
        )

    # Clean up extra files saved by save_pretrained that we don't need.
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

    return tok_json_path


# ---------------------------------------------------------------------------
# Language manifest
# ---------------------------------------------------------------------------

def write_language_manifest(output_dir: Path, quantization: str) -> Path:
    exported_at = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    lang_entries = []
    for bcp47, whisper_code, name, native, notes in LANGUAGES:
        lang_entries.append({
            "bcp47":          bcp47,
            "whisper_code":   whisper_code,
            "name":           name,
            "native_support": native,
            "notes":          notes,
        })

    manifest = {
        "checkpoint":    CHECKPOINT,
        "quantization":  quantization,
        "exported_at":   exported_at,
        "languages":     lang_entries,
    }

    # Emit warnings for non-native languages.
    fallbacks = [(e["bcp47"], e["whisper_code"], e["name"])
                 for e in lang_entries if not e["native_support"]]
    if fallbacks:
        log("  WARNING: The following languages lack a native Whisper token.")
        log("  Quality may degrade — evaluation recommended before production use:")
        for bcp47, wcode, dname in fallbacks:
            log(f"    {bcp47} ({dname}) -> mapped to whisper code '{wcode}'")

    out_path = output_dir / "indic-whisper-tokens-to-language.json"
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    log(f"Language manifest written: {out_path.name}")
    return out_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Download openai/whisper-small, export to ONNX, apply int8 "
            "quantization, and write the AccessBridge indic-whisper artifacts."
        )
    )
    parser.add_argument(
        "--output-dir",
        default="./output/indic-whisper",
        help="Directory to write all outputs (default: ./output/indic-whisper)",
    )
    parser.add_argument(
        "--skip-quantize",
        action="store_true",
        help="Skip int8 quantization — useful for fast iteration; outputs full-precision ONNX.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    log(f"Output directory : {output_dir.resolve()}")
    log(f"Checkpoint       : {CHECKPOINT}")
    log(f"Skip quantize    : {args.skip_quantize}")

    # --- Step 1: ONNX export ---
    with tempfile.TemporaryDirectory(prefix="indic-whisper-export-") as tmp_str:
        export_dir = Path(tmp_str)
        log("Step 1/4: ONNX export ...")
        export_onnx(CHECKPOINT, export_dir)

        # --- Step 2: Copy / quantize encoder ---
        encoder_src = export_dir / "encoder_model.onnx"
        if not encoder_src.exists():
            raise FileNotFoundError(
                f"encoder_model.onnx not found in {export_dir}. "
                "Check optimum-cli output above."
            )

        decoder_src = pick_decoder_onnx(export_dir)

        log("Step 2/4: Processing encoder model ...")
        if args.skip_quantize:
            encoder_dst = output_dir / "indic-whisper-small-encoder-fp32.onnx"
            shutil.copy2(encoder_src, encoder_dst)
            log(f"  Copied (no quantize): {encoder_dst.name}")
        else:
            encoder_dst = output_dir / "indic-whisper-small-encoder-int8.onnx"
            quantize_onnx(encoder_src, encoder_dst)

        log("Step 3/4: Processing decoder model ...")
        if args.skip_quantize:
            decoder_dst = output_dir / "indic-whisper-small-decoder-fp32.onnx"
            shutil.copy2(decoder_src, decoder_dst)
            log(f"  Copied (no quantize): {decoder_dst.name}")
        else:
            decoder_dst = output_dir / "indic-whisper-small-decoder-int8.onnx"
            quantize_onnx(decoder_src, decoder_dst)

        # Also write a canonical "small-int8.onnx" symlink/copy pointing to
        # the merged/decoder file — some callers expect a single-file name.
        canonical_dst = output_dir / (
            "indic-whisper-small-int8.onnx"
            if not args.skip_quantize
            else "indic-whisper-small-fp32.onnx"
        )
        if not canonical_dst.exists():
            shutil.copy2(decoder_dst, canonical_dst)
            log(
                f"  NOTE: Single-file alias '{canonical_dst.name}' points to decoder "
                f"('{decoder_dst.name}'). Extension must also load encoder "
                f"('{encoder_dst.name}') separately."
            )

    # --- Step 3: Tokenizer ---
    log("Step 3/4: Extracting tokenizer ...")
    tok_path = extract_tokenizer(CHECKPOINT, output_dir)

    # --- Step 4: Language manifest ---
    log("Step 4/4: Writing language manifest ...")
    quantization = "fp32-none" if args.skip_quantize else "int8-dynamic"
    manifest_path = write_language_manifest(output_dir, quantization)

    # --- Final summary ---
    outputs = [
        (canonical_dst,  "indic-whisper-small-int8.onnx (decoder / canonical)"),
        (encoder_dst,    "indic-whisper-small-encoder-int8.onnx"),
        (decoder_dst,    "indic-whisper-small-decoder-int8.onnx"),
        (tok_path,       "indic-whisper-tokenizer.json"),
        (manifest_path,  "indic-whisper-tokens-to-language.json"),
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
    log("All outputs written. Ready to run upload-to-vps.sh")
    log("  cd tools/prepare-models && ./upload-to-vps.sh")


if __name__ == "__main__":
    main()
