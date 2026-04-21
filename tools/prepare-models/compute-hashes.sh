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
  printf '\n  }\n}\n'
} > "$MANIFEST"

echo ""
echo "Manifest written: $MANIFEST"
