#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/output"
MANIFEST="$OUTPUT_DIR/models-manifest.json"

T0_FILE="struggle-classifier-v1.onnx"
T1_MODEL="all-MiniLM-L6-v2-int8.onnx"
T1_TOK="minilm-tokenizer.json"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

size_of() {
  if [[ "$(uname)" == "Darwin" ]]; then
    stat -f %z "$1"
  else
    stat -c %s "$1"
  fi
}

hash_and_print() {
  local path="$1" label="$2" hash size
  hash=$(sha256_of "$path")
  size=$(size_of "$path")
  echo "  $label: sha256=$hash  bytes=$size"
  # Set globals (declared in caller scope).
  eval "${label//[^a-zA-Z0-9]/_}_HASH=\"\$hash\""
  eval "${label//[^a-zA-Z0-9]/_}_SIZE=\"\$size\""
}

# Tier 0 — required
if [[ ! -f "$OUTPUT_DIR/$T0_FILE" ]]; then
  echo "ERROR: Tier 0 file missing: $OUTPUT_DIR/$T0_FILE" >&2
  exit 1
fi

echo "Hashing Tier 0 model..."
T0_HASH=$(sha256_of "$OUTPUT_DIR/$T0_FILE")
T0_SIZE=$(size_of "$OUTPUT_DIR/$T0_FILE")
echo "  struggle-classifier-v1: sha256=$T0_HASH  bytes=$T0_SIZE"

T1_HASH=""; T1_SIZE=0; T1_TOK_HASH=""; T1_TOK_SIZE=0

if [[ -f "$OUTPUT_DIR/$T1_MODEL" ]]; then
  echo "Hashing Tier 1 model..."
  T1_HASH=$(sha256_of "$OUTPUT_DIR/$T1_MODEL")
  T1_SIZE=$(size_of "$OUTPUT_DIR/$T1_MODEL")
  echo "  minilm-l6-v2: sha256=$T1_HASH  bytes=$T1_SIZE"
else
  echo "WARN: Tier 1 model missing (non-fatal): $T1_MODEL" >&2
fi

if [[ -f "$OUTPUT_DIR/$T1_TOK" ]]; then
  echo "Hashing Tier 1 tokenizer..."
  T1_TOK_HASH=$(sha256_of "$OUTPUT_DIR/$T1_TOK")
  T1_TOK_SIZE=$(size_of "$OUTPUT_DIR/$T1_TOK")
  echo "  minilm-tokenizer: sha256=$T1_TOK_HASH  bytes=$T1_TOK_SIZE"
else
  echo "WARN: Tier 1 tokenizer missing (non-fatal): $T1_TOK" >&2
fi

# ---------------------------------------------------------------------------
# Session 17 — indic-whisper ONNX artifacts
# Encoder and decoder are always separate (optimum never merges Whisper into
# one file reliably); the canonical alias is a copy of the decoder.
# ---------------------------------------------------------------------------
IW_DIR="$OUTPUT_DIR/indic-whisper"
IW_ENC="indic-whisper-small-encoder-int8.onnx"
IW_DEC="indic-whisper-small-decoder-int8.onnx"
IW_CANONICAL="indic-whisper-small-int8.onnx"
IW_TOK="indic-whisper-tokenizer.json"
IW_LANGMAP="indic-whisper-tokens-to-language.json"

IW_ENC_HASH=""; IW_ENC_SIZE=0
IW_DEC_HASH=""; IW_DEC_SIZE=0
IW_CANONICAL_HASH=""; IW_CANONICAL_SIZE=0
IW_TOK_HASH=""; IW_TOK_SIZE=0
IW_LANGMAP_HASH=""; IW_LANGMAP_SIZE=0

if [[ -f "$IW_DIR/$IW_ENC" ]]; then
  echo "Hashing indic-whisper encoder..."
  IW_ENC_HASH=$(sha256_of "$IW_DIR/$IW_ENC")
  IW_ENC_SIZE=$(size_of "$IW_DIR/$IW_ENC")
  echo "  indic-whisper-encoder: sha256=$IW_ENC_HASH  bytes=$IW_ENC_SIZE"
else
  echo "WARN: indic-whisper encoder missing (non-fatal): $IW_ENC" >&2
fi

if [[ -f "$IW_DIR/$IW_DEC" ]]; then
  echo "Hashing indic-whisper decoder..."
  IW_DEC_HASH=$(sha256_of "$IW_DIR/$IW_DEC")
  IW_DEC_SIZE=$(size_of "$IW_DIR/$IW_DEC")
  echo "  indic-whisper-decoder: sha256=$IW_DEC_HASH  bytes=$IW_DEC_SIZE"
else
  echo "WARN: indic-whisper decoder missing (non-fatal): $IW_DEC" >&2
fi

if [[ -f "$IW_DIR/$IW_CANONICAL" ]]; then
  echo "Hashing indic-whisper canonical alias..."
  IW_CANONICAL_HASH=$(sha256_of "$IW_DIR/$IW_CANONICAL")
  IW_CANONICAL_SIZE=$(size_of "$IW_DIR/$IW_CANONICAL")
  echo "  indic-whisper-small-int8 (canonical): sha256=$IW_CANONICAL_HASH  bytes=$IW_CANONICAL_SIZE"
else
  echo "WARN: indic-whisper canonical file missing (non-fatal): $IW_CANONICAL" >&2
fi

if [[ -f "$IW_DIR/$IW_TOK" ]]; then
  echo "Hashing indic-whisper tokenizer..."
  IW_TOK_HASH=$(sha256_of "$IW_DIR/$IW_TOK")
  IW_TOK_SIZE=$(size_of "$IW_DIR/$IW_TOK")
  echo "  indic-whisper-tokenizer: sha256=$IW_TOK_HASH  bytes=$IW_TOK_SIZE"
else
  echo "WARN: indic-whisper tokenizer missing (non-fatal): $IW_TOK" >&2
fi

if [[ -f "$IW_DIR/$IW_LANGMAP" ]]; then
  echo "Hashing indic-whisper language map..."
  IW_LANGMAP_HASH=$(sha256_of "$IW_DIR/$IW_LANGMAP")
  IW_LANGMAP_SIZE=$(size_of "$IW_DIR/$IW_LANGMAP")
  echo "  indic-whisper-tokens-to-language: sha256=$IW_LANGMAP_HASH  bytes=$IW_LANGMAP_SIZE"
else
  echo "WARN: indic-whisper language map missing (non-fatal): $IW_LANGMAP" >&2
fi

GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Emit manifest. Plain printf (no jq dependency).
{
  printf '{\n'
  printf '  "generatedAt": "%s",\n' "$GENERATED_AT"
  printf '  "models": {\n'
  printf '    "struggle-classifier-v1": { "file": "%s", "sha256": "%s", "sizeBytes": %s, "loadTier": 0 }' \
    "$T0_FILE" "$T0_HASH" "$T0_SIZE"
  if [[ -n "$T1_HASH" ]]; then
    printf ',\n    "minilm-l6-v2": { "file": "%s", "sha256": "%s", "sizeBytes": %s, "loadTier": 1' \
      "$T1_MODEL" "$T1_HASH" "$T1_SIZE"
    if [[ -n "$T1_TOK_HASH" ]]; then
      printf ', "tokenizer": "%s", "tokenizerSha256": "%s", "tokenizerSizeBytes": %s' \
        "$T1_TOK" "$T1_TOK_HASH" "$T1_TOK_SIZE"
    fi
    printf ' }'
  fi
  # indic-whisper block (Session 17)
  if [[ -n "$IW_CANONICAL_HASH" || -n "$IW_ENC_HASH" ]]; then
    printf ',\n    "indic-whisper-small-int8": {'
    printf ' "checkpoint": "openai/whisper-small", "quantization": "int8-dynamic", "loadTier": 2'
    if [[ -n "$IW_CANONICAL_HASH" ]]; then
      printf ', "file": "%s", "sha256": "%s", "sizeBytes": %s' \
        "$IW_CANONICAL" "$IW_CANONICAL_HASH" "$IW_CANONICAL_SIZE"
    fi
    if [[ -n "$IW_ENC_HASH" ]]; then
      printf ', "encoderFile": "%s", "encoderSha256": "%s", "encoderSizeBytes": %s' \
        "$IW_ENC" "$IW_ENC_HASH" "$IW_ENC_SIZE"
    fi
    if [[ -n "$IW_DEC_HASH" ]]; then
      printf ', "decoderFile": "%s", "decoderSha256": "%s", "decoderSizeBytes": %s' \
        "$IW_DEC" "$IW_DEC_HASH" "$IW_DEC_SIZE"
    fi
    if [[ -n "$IW_TOK_HASH" ]]; then
      printf ', "tokenizer": "%s", "tokenizerSha256": "%s", "tokenizerSizeBytes": %s' \
        "$IW_TOK" "$IW_TOK_HASH" "$IW_TOK_SIZE"
    fi
    if [[ -n "$IW_LANGMAP_HASH" ]]; then
      printf ', "languageMap": "%s", "languageMapSha256": "%s", "languageMapSizeBytes": %s' \
        "$IW_LANGMAP" "$IW_LANGMAP_HASH" "$IW_LANGMAP_SIZE"
    fi
    printf ' }'
  fi
  printf '\n  }\n}\n'
} > "$MANIFEST"

echo ""
echo "Manifest written: $MANIFEST"
