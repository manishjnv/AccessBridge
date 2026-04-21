#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/output"
REMOTE_HOST="a11yos-vps"
REMOTE_DIR="/opt/accessbridge/models"
PUBLIC_BASE="http://72.61.227.64:8300/models"

# Validate source
if [[ ! -f "$OUTPUT_DIR/models-manifest.json" ]]; then
  echo "ERROR: $OUTPUT_DIR/models-manifest.json not found. Run prepare-models first." >&2
  exit 1
fi

# Collect files to upload
mapfile -t FILES < <(find "$OUTPUT_DIR" \( \
  -name "*.onnx" \
  -o -name "*tokenizer*.json" \
  -o -name "*-tokenizer-*.json" \
  -o -name "minilm-*.json" \
\) -type f | sort)

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "ERROR: No matching files in $OUTPUT_DIR" >&2
  exit 1
fi

# Upload manifest
echo "--- Uploading manifest ---"
SCP_FALLBACK=0
rsync -avz --progress "$OUTPUT_DIR/models-manifest.json" \
  "$REMOTE_HOST:$REMOTE_DIR/manifest.json" 2>&1 || SCP_FALLBACK=1
if [[ $SCP_FALLBACK -eq 1 ]]; then
  echo "rsync failed (BUG-011 dup() issue?), falling back to scp..."
  scp "$OUTPUT_DIR/models-manifest.json" "$REMOTE_HOST:$REMOTE_DIR/manifest.json"
fi

# Upload each model / tokenizer file
TOTAL_BYTES=0
FAILURES=()

for f in "${FILES[@]}"; do
  fname="$(basename "$f")"
  fsize="$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")"
  echo ""
  echo "--- Uploading $fname ($fsize bytes) ---"

  SCP_FALLBACK=0
  rsync -avz --progress "$f" "$REMOTE_HOST:$REMOTE_DIR/" 2>&1 || SCP_FALLBACK=1
  if [[ $SCP_FALLBACK -eq 1 ]]; then
    echo "rsync failed, falling back to scp..."
    scp "$f" "$REMOTE_HOST:$REMOTE_DIR/"
  fi

  TOTAL_BYTES=$(( TOTAL_BYTES + fsize ))

  # Health-check public URL
  PUBLIC_URL="$PUBLIC_BASE/$fname"
  if curl -sI "$PUBLIC_URL" | grep -q "200 OK"; then
    echo "  OK  $PUBLIC_URL"
  else
    echo "  FAIL $PUBLIC_URL — not reachable or non-200"
    FAILURES+=("$fname")
  fi
done

# ---------------------------------------------------------------------------
# Session 17 — indic-whisper ONNX artifacts
# Uploads quantized encoder + decoder (or merged) + tokenizer + language map.
# If the single-file encoder/decoder split was taken by download-indicwhisper.py
# both files are captured by the *.onnx glob above; the explicit list below
# also uploads the three JSON companions that the glob may miss.
# ---------------------------------------------------------------------------
IW_DIR="$OUTPUT_DIR/indic-whisper"
IW_FILES=(
  "indic-whisper-small-int8.onnx"
  "indic-whisper-small-encoder-int8.onnx"
  "indic-whisper-small-decoder-int8.onnx"
  "indic-whisper-tokenizer.json"
  "indic-whisper-tokens-to-language.json"
)

echo ""
echo "--- Uploading indic-whisper artifacts (Session 17) ---"
IW_UPLOADED=0
for iw_fname in "${IW_FILES[@]}"; do
  iw_path="$IW_DIR/$iw_fname"
  if [[ ! -f "$iw_path" ]]; then
    echo "  SKIP (not found): $iw_fname"
    continue
  fi
  fsize="$(stat -c%s "$iw_path" 2>/dev/null || stat -f%z "$iw_path")"
  echo ""
  echo "  Uploading $iw_fname ($fsize bytes) ..."
  SCP_FALLBACK=0
  rsync -avz --progress "$iw_path" "$REMOTE_HOST:$REMOTE_DIR/" 2>&1 || SCP_FALLBACK=1
  if [[ $SCP_FALLBACK -eq 1 ]]; then
    echo "  rsync failed, falling back to scp..."
    scp "$iw_path" "$REMOTE_HOST:$REMOTE_DIR/"
  fi
  TOTAL_BYTES=$(( TOTAL_BYTES + fsize ))
  IW_UPLOADED=$(( IW_UPLOADED + 1 ))

  PUBLIC_URL="$PUBLIC_BASE/$iw_fname"
  if curl -sI "$PUBLIC_URL" | grep -q "200 OK"; then
    echo "  OK  $PUBLIC_URL"
  else
    echo "  FAIL $PUBLIC_URL — not reachable or non-200"
    FAILURES+=("$iw_fname")
  fi
done
echo "  indic-whisper files uploaded: $IW_UPLOADED"

# ---------------------------------------------------------------------------
# Session 23 — Moondream2 ONNX artifacts (Feature #5 Tier 3 Vision Recovery)
# ---------------------------------------------------------------------------
MD_DIR="$OUTPUT_DIR/moondream"
MD_FILES=(
  "moondream2-vision-int8.onnx"
  "moondream2-text-int8.onnx"
  "moondream2-tokenizer.json"
  "moondream2-image-preprocessor.json"
)

echo ""
echo "--- Uploading moondream2 artifacts (Session 23) ---"
MD_UPLOADED=0
for md_fname in "${MD_FILES[@]}"; do
  md_path="$MD_DIR/$md_fname"
  if [[ ! -f "$md_path" ]]; then
    echo "  SKIP (not found): $md_fname"
    continue
  fi
  fsize="$(stat -c%s "$md_path" 2>/dev/null || stat -f%z "$md_path")"
  echo ""
  echo "  Uploading $md_fname ($fsize bytes) ..."
  SCP_FALLBACK=0
  rsync -avz --progress "$md_path" "$REMOTE_HOST:$REMOTE_DIR/" 2>&1 || SCP_FALLBACK=1
  if [[ $SCP_FALLBACK -eq 1 ]]; then
    echo "  rsync failed, falling back to scp..."
    scp "$md_path" "$REMOTE_HOST:$REMOTE_DIR/"
  fi
  TOTAL_BYTES=$(( TOTAL_BYTES + fsize ))
  MD_UPLOADED=$(( MD_UPLOADED + 1 ))

  PUBLIC_URL="$PUBLIC_BASE/$md_fname"
  if curl -sI "$PUBLIC_URL" | grep -q "200 OK"; then
    echo "  OK  $PUBLIC_URL"
  else
    echo "  FAIL $PUBLIC_URL — not reachable or non-200"
    FAILURES+=("$md_fname")
  fi
done
echo "  moondream2 files uploaded: $MD_UPLOADED"

# ---------------------------------------------------------------------------
# Session 14 loose end — t5-small.onnx
# Uploads t5-small.onnx if it was produced (Tier 2 model, may not exist yet).
# ---------------------------------------------------------------------------
T5_PATH="$OUTPUT_DIR/t5-small.onnx"
echo ""
echo "--- Uploading t5-small.onnx (Session 14 Tier 2 loose end) ---"
if [[ -f "$T5_PATH" ]]; then
  t5_size="$(stat -c%s "$T5_PATH" 2>/dev/null || stat -f%z "$T5_PATH")"
  echo "  Uploading t5-small.onnx ($t5_size bytes) ..."
  SCP_FALLBACK=0
  rsync -avz --progress "$T5_PATH" "$REMOTE_HOST:$REMOTE_DIR/" 2>&1 || SCP_FALLBACK=1
  if [[ $SCP_FALLBACK -eq 1 ]]; then
    echo "  rsync failed, falling back to scp..."
    scp "$T5_PATH" "$REMOTE_HOST:$REMOTE_DIR/"
  fi
  TOTAL_BYTES=$(( TOTAL_BYTES + t5_size ))
  PUBLIC_URL="$PUBLIC_BASE/t5-small.onnx"
  if curl -sI "$PUBLIC_URL" | grep -q "200 OK"; then
    echo "  OK  $PUBLIC_URL"
  else
    echo "  FAIL $PUBLIC_URL — not reachable or non-200"
    FAILURES+=("t5-small.onnx")
  fi
else
  echo "  SKIP: t5-small.onnx not found at $T5_PATH (Tier 2 not yet exported)."
fi

# Remote permissions
echo ""
echo "--- Setting remote permissions ---"
ssh "$REMOTE_HOST" "chmod 644 $REMOTE_DIR/*.onnx $REMOTE_DIR/*.json && chown -R root:root $REMOTE_DIR/"

# Summary
echo ""
echo "======================================="
echo "Upload complete"
echo "  Files uploaded : $(( ${#FILES[@]} + IW_UPLOADED + MD_UPLOADED + 1 ))"   # +1 for manifest
echo "  Total bytes    : $TOTAL_BYTES"
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo "  FAILURES (${#FAILURES[@]}):"
  for fail in "${FAILURES[@]}"; do
    echo "    - $fail"
  done
  exit 1
else
  echo "  Failures       : 0"
fi
