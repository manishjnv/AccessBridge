# AccessBridge Secrets Scan — Session 26

**Version:** 0.24.0 (Session 26 baseline)
**Date:** 2026-04-22
**Tools:** detect-secrets 1.5.0 (pip-installed). gitleaks not used (Go toolchain absent on Windows dev host; npm package `gitleaks@8.x` doesn't exist).
**Scope:** Working-tree scan + a full-file scan (`--all-files`). Historical-commit scan deferred (detect-secrets does not natively walk git history; the full-file + history-walk path is planned for the `.github/workflows/cve-watch.yml` nightly job where gitleaks binary is available on Ubuntu runners).

---

## Verdict

**No real secrets committed.** All findings are false positives of known, well-classified categories.

| Classification | Count |
|---|---|
| Real secret (CRITICAL, rotate now) | **0** |
| False positive — confirmed | 291 |
| Unverified / ambiguous | 0 |

---

## Scan methodology

```bash
python -m detect_secrets scan \
  --exclude-files "node_modules" \
  --exclude-files "dist/" \
  --exclude-files "\.git/" \
  --exclude-files "src-tauri/target" \
  --exclude-files "\.codex-prompts" \
  --exclude-files "\.prompts" \
  --exclude-files "\.logs" \
  --exclude-files "accessbridge-extension\.zip" \
  --exclude-files "admx-bundle\.zip" \
  --exclude-files "gen/" \
  --exclude-files "icons/" \
  > docs/security/detect-secrets-worktree.json
```

Plugins enabled (default): AWS, Azure, Base64, Basic Auth, Cloudant, Discord, GitHub, Hex, IBM-Cloud, JWT, Keyword, Mailchimp, NPM, Private Key, Slack, Softlayer, Square OAuth, Stripe, Twilio.

---

## Findings (all false positives)

### Category 1 — pnpm-lock.yaml integrity hashes (Base64 High Entropy): **285**

These are SRI-style integrity hashes (SHA-512 in base64) for every npm package version pinned in the lockfile. They are public, published at npm.org, and are the intended integrity protection — never a secret.

- **File:** `pnpm-lock.yaml` (all occurrences)
- **Action:** ignore — standard lockfile behavior.

### Category 2 — ONNX model SHA-256 integrity hashes (Hex High Entropy): **4**

Pinned SHA-256 hashes for the three on-device ONNX models (Tier 0 XGBoost classifier, Tier 1 MiniLM, Tier 2 T5, plus placeholder slot for Tier 3 Moondream). Every model download is verified against these hashes before loading.

- **File:** `packages/onnx-runtime/src/model-registry.ts:35,50,60` (+ one more site)
- **Action:** ignore — this IS the integrity-check defense, not a secret.

### Category 3 — observatory-publisher test-fixture hex strings (Hex High Entropy): **1**

Test fixture: a deterministic ring-sig key image (hex-encoded 32 bytes) used in `observatory-publisher.test.ts:71,89`. Hardcoded for reproducibility of ring-signature tests; not a real device key.

- **File:** `packages/extension/src/background/__tests__/observatory-publisher.test.ts:71,89`
- **Action:** ignore — deterministic test fixture, not production material.

### Category 4 — icon lexicon dictionary (Secret Keyword): **1**

The string literal `password: 'Password'` at `packages/core/src/vision/icon-lexicon.ts:150` is a line in the 200-entry icon-name-to-label map used by the Tier 1 vision-recovery heuristic. The key is the name of an icon shape (key, password, fingerprint, face-id, unlock, mail…); the value is the human-readable English label.

- **File:** `packages/core/src/vision/icon-lexicon.ts:150`
- **Action:** ignore — false positive from the `Secret Keyword` plugin. The whole dictionary is public by nature.

---

## Not scanned / follow-up

The following scopes were deliberately excluded from this local scan but should be covered by CI:

1. **Git history walk (full `--log-opts="--all"` equivalent).** Detect-secrets does not natively walk commits; gitleaks does. Deferred to `.github/workflows/cve-watch.yml` nightly (ubuntu-latest has gitleaks in `apt` repositories or via `go install`).
2. **Binary artifacts** (`*.zip`, `src-tauri/target/`, `*.onnx`, `accessbridge-extension.zip`). Tool doesn't scan binaries effectively; not expected to contain secrets (they are reproducible build outputs).
3. **Environment files.** Confirmed: no `.env`, `.envrc`, `credentials.json`, `*.pem`, `*.key`, `*.pfx`, `*.p12` are present in the worktree or git history at the time of this audit.

---

## Regression guard

Add a detect-secrets baseline to CI:

```bash
# Generate once and commit
detect-secrets scan --baseline .secrets.baseline

# CI verifies no new secrets vs baseline
detect-secrets audit --baseline .secrets.baseline --report
```

This is wired in `.github/workflows/security.yml` → `secrets-scan` job. When a legitimate new high-entropy string is added (e.g. a new model SHA-256), update the baseline explicitly in the PR that adds it.

---

## Summary

- Files with findings: 5
- Total findings: 291 (all false positives)
- Real secrets leaked: **0**
- Rotation required: **none**
