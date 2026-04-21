# Python Security Audit — AccessBridge v0.24.0

**Date:** 2026-04-22  
**Auditor:** Claude Code (Opus 4.7 manual pass; Codex quota-exhausted)  
**Scope:** All `*.py` in the repo (10 files, 3 356 lines of code)  
**Tools:** bandit 1.9.4 · pip-audit 2.10.0 · manual grep sweeps  

---

## Files Audited

| File | Lines | Purpose |
|---|---|---|
| `scripts/vps/main.py` | 145 | FastAPI VPS service (port 8100) |
| `tools/prepare-models/download-hf-models.py` | 93 | HF MiniLM artifact download (Session 14) |
| `tools/prepare-models/download-indicwhisper.py` | 386 | Whisper ONNX export + quantize (Session 17) |
| `tools/prepare-models/download-moondream.py` | 400 | Moondream2 ONNX download (Session 23) |
| `tools/prepare-models/evaluate-indicwhisper.py` | 437 | Whisper ONNX evaluation |
| `tools/prepare-models/evaluate-moondream.py` | 529 | Moondream ONNX evaluation |
| `tools/prepare-models/train-struggle-classifier.py` | 128 | XGBoost → ONNX classifier |
| `generate-test-cases.py` | 907 | Test-case Word doc generator |
| `generate_presentation.py` | 580 | PPTX presentation generator |
| `scripts/update_presentation_v2.py` | 751 | PPTX surgical updater |

**`tools/pilot/`** — contains only `.ts` files (enroll-batch.ts, generate-report.ts). No Python. Nothing to audit there.

---

## Findings

### MEDIUM severity

#### FINDING-PY-001 — HF download without revision pinning (3 instances)
**CWE-494** (Download of Code Without Integrity Check) · Bandit B615 · MEDIUM confidence HIGH

`hf_hub_download()` and two `AutoProcessor.from_pretrained()` calls omit a `revision=` parameter, so they always resolve to the `main` branch HEAD. If the HuggingFace repo is compromised or the `main` pointer is moved, poisoned weights are silently downloaded and loaded.

| # | File | Line | Call |
|---|---|---|---|
| a | `tools/prepare-models/download-hf-models.py` | 44 | `hf_hub_download(repo_id=REPO_ID, filename=repo_file, …)` — no `revision=` |
| b | `tools/prepare-models/download-indicwhisper.py` | 194 | `AutoProcessor.from_pretrained(checkpoint)` — no `revision=` |
| c | `tools/prepare-models/evaluate-indicwhisper.py` | 191 | `WhisperFeatureExtractor.from_pretrained("openai/whisper-small")` — no `revision=` |

Note: `download-moondream.py` accepts `--revision` CLI flag and passes it through (line 207) — **correctly handled**; not a finding.

**Recommendation:** Pin each call to a specific commit SHA:
```python
# download-hf-models.py:44
cached = hf_hub_download(
    repo_id=REPO_ID,
    filename=repo_file,
    revision="9e6cf6b5ed08ea40898ee5d0ad67ab19de79a2a7",  # pin to known-good commit
    cache_dir=str(CACHE_DIR),
)

# download-indicwhisper.py:194
proc = AutoProcessor.from_pretrained(checkpoint, revision="<commit-sha>")

# evaluate-indicwhisper.py:191
fe = WhisperFeatureExtractor.from_pretrained("openai/whisper-small", revision="<commit-sha>")
```

---

#### FINDING-PY-002 — SHA-256 computed but never verified against expected value
**CWE-494** · Manual · MEDIUM

Both `download-indicwhisper.py` and `download-moondream.py` compute SHA-256 digests of output files after quantization (via `sha256_file()`, lines 82–87 and 65–70 respectively) and print them, but **never compare the digest against a known-good expected value**. The SHA is informational only. An attacker who can MITM the HuggingFace CDN or corrupt the local cache can substitute arbitrary model weights; the script will log the bad hash but proceed normally.

**Recommendation:** Ship a `hashes.txt` alongside the scripts with expected SHA-256 values for each pinned revision, and fail-fast if the digest mismatches:
```python
EXPECTED_HASHES = {
    "indic-whisper-small-encoder-int8.onnx": "abc123…",
    …
}
actual = sha256_file(encoder_dst)
if EXPECTED_HASHES.get(encoder_dst.name) and actual != EXPECTED_HASHES[encoder_dst.name]:
    raise RuntimeError(f"Hash mismatch for {encoder_dst.name}: got {actual}")
```

---

#### FINDING-PY-003 — CORS `allow_origins=["*"]` in production FastAPI service
**CWE-346** (Origin Validation Error) · Manual · MEDIUM

`scripts/vps/main.py:37–40`:
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
```

`allow_credentials` is not set (defaults to `False`), so the known "wildcard + credentials" CORS vuln does not apply. However, `allow_origins=["*"]` means any website can silently call `/version`, `/updates.xml`, or `/health` and read the response. For the current public read-only API this is acceptable (BUG-010 explicitly requires CDN cache-busting), but should be documented as intentional so a future route added without reconsideration does not accidentally expose sensitive data.

**Recommendation:** Restrict to `["https://accessbridge.space"]` (and localhost for dev), or add a comment clearly stating "public read-only API — wildcard CORS is intentional per BUG-010."

---

#### FINDING-PY-004 — uvicorn `host="0.0.0.0"` (direct execution path)
**CWE-605** · Bandit B104 · MEDIUM confidence MEDIUM

`scripts/vps/main.py:144`:
```python
uvicorn.run(app, host="0.0.0.0", port=8100)
```

This only runs when `python main.py` is invoked directly. In Docker it is overridden by the `CMD`/`ENTRYPOINT` in `docker-compose.yml`. Confirmed the VPS deploys via Docker behind nginx on port 8300 (per ARCHITECTURE.md / BUG-002), so the 0.0.0.0 bind is not exposed to the public internet in production.

**Residual risk:** If someone accidentally runs `python main.py` directly on the VPS host, port 8100 binds to all interfaces — bypassing nginx's proxy. Change to `host="127.0.0.1"` as a defense-in-depth measure.

---

### LOW severity

#### FINDING-PY-005 — subprocess call with fully-controlled argument list
**CWE-78** · Bandit B603 · LOW

`tools/prepare-models/download-indicwhisper.py:121–128`:
```python
cmd = [
    sys.executable, "-m", "optimum.exporters.onnx",
    "--model", checkpoint,
    "--task", "automatic-speech-recognition",
    str(export_dir),
]
result = subprocess.run(cmd, capture_output=False)
```

`checkpoint` is the hardcoded constant `CHECKPOINT = "openai/whisper-small"` (line 71). `export_dir` is a `tempfile.TemporaryDirectory` path. No user input flows into the argument list. `shell=False` (default). **Not exploitable in current form.** Flagged because if `checkpoint` is ever made a CLI argument (`--checkpoint`), an attacker could inject arbitrary module paths.

**Recommendation:** If a `--checkpoint` flag is ever added, validate the value against an allowlist of known-safe checkpoint IDs before passing to subprocess.

---

#### FINDING-PY-006 — `assert` used for shape validation (compiled-away in optimized mode)
**CWE-703** · Bandit B101 · LOW

Two files use `assert` for runtime shape checks:
- `tools/prepare-models/evaluate-indicwhisper.py:208` — `assert hidden.ndim == 3`
- `tools/prepare-models/train-struggle-classifier.py:125–126` — `assert probs.shape == (1, 4)` / `assert abs(probs.sum() - 1.0) < 1e-4`

Both are off-line developer tools, not server code, so the practical risk is near-zero (nobody runs model-prep scripts with `python -O`). Flagged for completeness.

**Recommendation:** Replace with explicit `if`/`raise` where shape validation is security-critical. Low priority for offline scripts.

---

#### FINDING-PY-007 — `zipfile.ZipFile` used on operator-controlled path without zip-slip guard
**CWE-22** · Manual · LOW

`scripts/vps/main.py:80–82`:
```python
with zipfile.ZipFile(ZIP_PATH) as z:
    with z.open("manifest.json") as f:
        manifest = json.load(f)
```

`ZIP_PATH = Path("/docs/downloads/accessbridge-extension.zip")` — this is a hardcoded Docker bind-mount path, not user-supplied. The code only calls `z.open("manifest.json")` (a specific named member), never `extractall()`. **Zip-slip does not apply here.** Included as a note because a future developer adding `extractall()` to this block without a path-guard would introduce CWE-22.

**Recommendation:** Add a comment above the `with zipfile.ZipFile(...)` block noting that `extractall()` must never be used here without member-path validation.

---

### INFORMATIONAL / Known-good

The following patterns were explicitly swept and found absent or safe:

| Pattern | Result |
|---|---|
| `pickle.load` / `marshal.load` / `joblib.load` / `dill.load` | **Not present** |
| `subprocess(shell=True)` | **Not present** |
| `os.system` / `os.popen` | **Not present** |
| `yaml.load` (unsafe) | **Not present** (no yaml usage at all) |
| `eval()` / `exec()` | **Not present** |
| `tempfile.mktemp` (race-prone) | **Not present** (both scripts use `TemporaryDirectory`, correct) |
| `random.*` for secrets/tokens | **Not present** |
| `requests.get(verify=False)` / TLS disabled | **Not present** |
| Hardcoded `HF_TOKEN`, `api_key`, `sk-*`, `AKIA*` | **Not present** |
| SQL queries (sqlite3, f-string SQL injection) | **Not present** (no database access) |
| `xml.etree.parse` / `minidom` without defusedxml | **Not present** |
| `allow_credentials=True` with `allow_origins=["*"]` | **Not present** (`allow_credentials` defaults False) |
| CSV injection (`=`, `+`, `-`, `@` cells from user data) | **Not present** (no CSV writes from user input) |
| Log injection (user input directly to logger) | **Not present** (no logging module usage; print only) |
| `X-Forwarded-For` trust for client IP | **Not present** (no IP-based logic in main.py) |
| `zipfile.extractall()` without zip-slip guard | **Not present** (only `z.open(specific_file)`) |

---

## Dependency Vulnerability (pip-audit)

pip-audit 2.10.0 found **1 known CVE** in the system Python environment:

```
Name  Version  ID              Fix Versions
----  -------  --------------  ------------
lxml  6.0.2    CVE-2026-41066  6.1.0
```

**CVE-2026-41066** — lxml 6.0.2 is vulnerable; fix is 6.1.0.  
**Applicability:** lxml is a system-level package, not a direct AccessBridge dependency (not imported in any audited `.py` file, no `requirements.txt` in the repo). The VPS Docker container uses its own Python environment managed by `docker-compose.yml`; confirm lxml is not installed there. No `requirements.txt` was found in `tools/prepare-models/` — if one is added it should track lxml >= 6.1.0.

---

## Summary

| Severity | Count | Findings |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 4 | PY-001 (HF revision pinning ×3), PY-002 (hash not verified), PY-003 (CORS wildcard), PY-004 (0.0.0.0 bind) |
| LOW | 3 | PY-005 (subprocess future risk), PY-006 (assert shape checks), PY-007 (zipfile note) |
| INFO/ADVISORY | 1 | lxml CVE-2026-41066 (indirect) |

**Priority order for remediation:**
1. **PY-001 + PY-002** (together): pin HF `revision=` to commit SHAs AND enforce hash comparison before loading. These are the only findings with an active supply-chain attack surface.
2. **PY-004**: change `host="127.0.0.1"` in the direct-run path — 5-minute fix, pure upside.
3. **PY-003**: document or restrict CORS origins — low urgency while API is read-only.
4. **PY-005/006/007**: informational, address opportunistically.

**No CRITICAL or HIGH findings.** The codebase has no unsafe deserialization, no shell injection, no hardcoded secrets, no SQL injection surface, and no TLS bypass. The model-prep scripts are developer-only offline tools, not server code, which lowers the practical severity of all tools/ findings.

---

## Appendix A — Bandit Output (verbatim)

```
Run started: 2026-04-22 04:07:11.198531+00:00
Python version: 3.14.3

Issue: [B104] Possible binding to all interfaces.
  Severity: Medium  Confidence: Medium  CWE: CWE-605
  Location: scripts/vps/main.py:144:26

Issue: [B615] Unsafe HuggingFace Hub download without revision pinning in hf_hub_download()
  Severity: Medium  Confidence: High  CWE: CWE-494
  Location: tools/prepare-models/download-hf-models.py:44:17

Issue: [B404] Consider possible security implications with subprocess module.
  Severity: Low  Confidence: High  CWE: CWE-78
  Location: tools/prepare-models/download-indicwhisper.py:22:0

Issue: [B603] subprocess call - check for execution of untrusted input.
  Severity: Low  Confidence: High  CWE: CWE-78
  Location: tools/prepare-models/download-indicwhisper.py:128:13

Issue: [B615] Unsafe HuggingFace Hub download without revision pinning in from_pretrained()
  Severity: Medium  Confidence: High  CWE: CWE-494
  Location: tools/prepare-models/download-indicwhisper.py:194:11

Issue: [B615] Unsafe HuggingFace Hub download without revision pinning in from_pretrained()
  Severity: Medium  Confidence: High  CWE: CWE-494
  Location: tools/prepare-models/evaluate-indicwhisper.py:191:13

Issue: [B101] Use of assert detected.
  Severity: Low  Confidence: High  CWE: CWE-703
  Location: tools/prepare-models/evaluate-indicwhisper.py:208:8

Issue: [B101] Use of assert detected.
  Severity: Low  Confidence: High  CWE: CWE-703
  Location: tools/prepare-models/train-struggle-classifier.py:125:0

Issue: [B101] Use of assert detected.
  Severity: Low  Confidence: High  CWE: CWE-703
  Location: tools/prepare-models/train-struggle-classifier.py:126:0

Total issues: Low=5  Medium=4  High=0
Total lines scanned: 3 356
Files skipped: 0
```

## Appendix B — pip-audit Output (verbatim)

```
WARNING: pip-audit will run pip against system Python (3.14.3).
Found 1 known vulnerability in 1 package
Name  Version  ID              Fix Versions
----  -------  --------------  ------------
lxml  6.0.2    CVE-2026-41066  6.1.0
```

---

*Audit scope is read-only. No code was changed. All findings are recommendations only.*
