"""
download-hf-models.py  —  AccessBridge Session 14
Downloads pre-quantized ONNX artifacts for all-MiniLM-L6-v2 from Hugging Face.
Uses hf_hub_download (no transformers/optimum dependency).

Usage:
    pip install huggingface_hub
    python download-hf-models.py
"""

import os
import shutil
from pathlib import Path

try:
    from huggingface_hub import hf_hub_download
except ImportError:
    raise SystemExit(
        "ERROR: huggingface_hub not installed.\n"
        "  pip install huggingface_hub"
    )

REPO_ID = "Xenova/all-MiniLM-L6-v2"
OUTPUT_DIR = Path(__file__).parent / "output"
CACHE_DIR = OUTPUT_DIR / ".hf-cache"

# (repo_filename, output_filename)
ARTIFACTS = [
    ("onnx/model_quantized.onnx", "all-MiniLM-L6-v2-int8.onnx"),
    ("tokenizer.json",            "minilm-tokenizer.json"),
    ("tokenizer_config.json",     "minilm-tokenizer-config.json"),
    ("special_tokens_map.json",   "minilm-special-tokens.json"),
]

# TODO(session-15): T5 download once beam-search decoder lands

CURL_BASE = "https://huggingface.co/{repo}/resolve/main/{path}"


def download_and_copy(repo_file, out_name):
    dest = OUTPUT_DIR / out_name
    print(f"\n-> {repo_file}")
    try:
        cached = hf_hub_download(
            repo_id=REPO_ID,
            filename=repo_file,
            cache_dir=str(CACHE_DIR),
        )
    except Exception as exc:
        curl_url = CURL_BASE.format(repo=REPO_ID, path=repo_file)
        print(f"  ERROR: {exc}")
        print(f"  Fallback: curl -L \"{curl_url}\" -o {out_name}")
        return False

    shutil.copy2(cached, dest)

    size = dest.stat().st_size
    with open(dest, "rb") as fh:
        first100 = fh.read(100).hex()

    print(f"  Saved : {dest.name}")
    print(f"  Size  : {size:,} bytes ({size / 1_048_576:.2f} MB)")
    print(f"  Hex[0:100]: {first100}")
    return True


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Repo   : {REPO_ID}")
    print(f"Output : {OUTPUT_DIR.resolve()}")
    print(f"Cache  : {CACHE_DIR.resolve()}")

    results = []
    for repo_file, out_name in ARTIFACTS:
        ok = download_and_copy(repo_file, out_name)
        results.append((out_name, ok))

    print("\n--- Summary ---")
    for name, ok in results:
        status = "OK" if ok else "FAILED"
        print(f"  [{status}] {name}")

    failed = [n for n, ok in results if not ok]
    if failed:
        raise SystemExit(f"\n{len(failed)} artifact(s) failed. See fallback URLs above.")
    print("\nAll artifacts downloaded successfully.")


if __name__ == "__main__":
    main()
