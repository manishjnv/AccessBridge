#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/prepare-models/output/models-manifest.json"
PUBLIC_BASE="http://72.61.227.64:8300/models"
TMP_DIR="${TMPDIR:-/tmp}/validate-models-tmp"

trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR"

if [[ ! -f "$MANIFEST" ]]; then
  echo "ERROR: manifest not found at $MANIFEST" >&2
  exit 1
fi

PY=python
command -v python >/dev/null 2>&1 || PY=python3

PARSE_PY="$TMP_DIR/parse_manifest.py"
cat > "$PARSE_PY" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    m = json.load(f)
for mid, meta in m["models"].items():
    print("{}\t{}\t{}".format(meta["file"], meta["sizeBytes"], meta["sha256"]))
    if "tokenizer" in meta:
        print("{}\t{}\t{}".format(meta["tokenizer"], meta["tokenizerSizeBytes"], meta["tokenizerSha256"]))
PYEOF

ENTRIES=$("$PY" "$PARSE_PY" "$MANIFEST" | tr -d '\r')

printf "\n%-45s %-6s %-6s %-5s %-20s %-8s\n" "File" "HTTP" "Size" "SHA" "Content-Type" "CORS"
printf '%0.s-' {1..95}; echo ""

PASS=0; FAIL=0

while IFS=$'\t' read -r file expected_size expected_sha; do
  [[ -z "$file" ]] && continue
  url="$PUBLIC_BASE/$file"
  tmp_file="$TMP_DIR/$file"
  mkdir -p "$(dirname "$tmp_file")"

  http_code=$(curl -sS -w "%{http_code}" \
    -H "Origin: https://accessbridge.space" \
    -o "$tmp_file" "$url" 2>/dev/null || echo "000")
  [[ "$http_code" == "200" ]] && h="OK" || h="FAIL($http_code)"

  actual_size=$(stat -c%s "$tmp_file" 2>/dev/null || stat -f%z "$tmp_file" 2>/dev/null || echo 0)
  [[ "$actual_size" == "$expected_size" ]] && sz="OK" || sz="FAIL($actual_size)"

  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha=$(sha256sum "$tmp_file" | awk '{print $1}')
  else
    actual_sha=$(shasum -a 256 "$tmp_file" | awk '{print $1}')
  fi
  [[ "$actual_sha" == "$expected_sha" ]] && sh="OK" || sh="FAIL"

  headers=$(curl -sI -H "Origin: https://accessbridge.space" "$url" 2>/dev/null || true)
  ct=$(echo "$headers" | grep -i "^content-type:" | head -1 | awk -F': ' '{print $2}' | tr -d '\r\n' || true)
  cors=$(echo "$headers" | grep -i "^access-control-allow-origin:" | head -1 | awk -F': ' '{print $2}' | tr -d '\r\n' || true)

  if [[ -z "$ct" ]]; then
    cth="FAIL(none)"
  elif echo "$ct" | grep -qiE "octet-stream|onnx|json"; then
    cth="OK"
  else
    cth="WARN($ct)"
  fi
  [[ -n "$cors" ]] && ch="OK" || ch="MISSING"

  printf "%-45s %-6s %-6s %-5s %-20s %-8s\n" "$file" "$h" "$sz" "$sh" "$cth" "$ch"

  if [[ "$h" == "OK" && "$sz" == "OK" && "$sh" == "OK" ]]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
  fi
done <<< "$ENTRIES"

echo ""
echo "Results: $PASS passed (HTTP+Size+SHA), $FAIL failed"
echo "Note: Content-Type WARN and CORS MISSING are advisory; hash + size are the integrity gates."
[[ $FAIL -eq 0 ]]
