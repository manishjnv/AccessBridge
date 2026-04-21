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
    echo "  ✓ $PUBLIC_URL"
  else
    echo "  ✗ $PUBLIC_URL — not reachable or non-200"
    FAILURES+=("$fname")
  fi
done

# Remote permissions
echo ""
echo "--- Setting remote permissions ---"
ssh "$REMOTE_HOST" "chmod 644 $REMOTE_DIR/*.onnx $REMOTE_DIR/*.json && chown -R root:root $REMOTE_DIR/"

# Summary
echo ""
echo "======================================="
echo "Upload complete"
echo "  Files uploaded : $(( ${#FILES[@]} + 1 ))"   # +1 for manifest
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
