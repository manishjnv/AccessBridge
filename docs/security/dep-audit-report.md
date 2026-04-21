# AccessBridge Dependency Audit — Session 26

**Version:** 0.24.0 (Session 26 baseline)
**Date:** 2026-04-22
**Tools:** pnpm audit (Node), cargo audit (Rust), pip-audit (Python), docker scout (deferred)

---

## Summary

| Ecosystem | Advisories | Critical | High | Moderate | Low |
|---|---|---|---|---|---|
| Node (pnpm)    | 17 | 2 | 8 | 7 | 0 |
| Rust (cargo)   | 19 warnings (0 vulns) | 0 | 0 | 2 unsound | 17 unmaintained |
| Python (pip)   | 0 project advisories | 0 | 0 | 0 | 0 |
| Docker         | (deferred to CI) | — | — | — | — |

---

## Node (pnpm audit) — ACTION REQUIRED

**Dep chain (from `pnpm why`):**

```
@accessbridge/extension@0.25.1
└── jspdf@2.5.2            (direct prod dep)
    └── dompurify@2.5.9    (transitive, bundled inside jspdf)
```

Both vulnerabilities originate from a single direct dependency (`jspdf 2.5.2`) in `packages/extension/package.json`. The `dompurify` exposure is entirely transitive — `dompurify` is not a direct dep of any workspace package.

### Critical (2)

| # | Package | Installed | GHSA | CVE | Title | Patched |
|---|---|---|---|---|---|---|
| 1 | jspdf | 2.5.2 | GHSA-f8cm-6447-x5h2 | — | Path Traversal via Local File Inclusion | >=4.0.0 |
| 2 | jspdf | 2.5.2 | GHSA-wfv2-pwc8-crg5 | — | HTML Injection in New Window paths | >=4.2.1 |

**GHSA-f8cm-6447-x5h2:** jsPDF allows Local File Inclusion / Path Traversal when user-controlled values are passed to PDF generation methods. An attacker with control over rendered content could read arbitrary local files during server-side PDF generation.

**GHSA-wfv2-pwc8-crg5:** jsPDF allows HTML injection in New Window output paths. Unsanitized input in window path construction enables persistent HTML injection, potentially leading to stored XSS in downstream viewers.

**Action:** Upgrade `jspdf` to `>=4.2.1` (the highest advisory requires `>=4.2.1`; this single version bump resolves both CRITICAL advisories and all 8 HIGH advisories below).

### High (8)

| # | Package | Installed | GHSA | Title (short) | Patched |
|---|---|---|---|---|---|
| 1 | jspdf | 2.5.2 | GHSA-w532-jxjh-hjhj | ReDoS via malicious data-URL in addImage/html/addSvgAsImage | >=3.0.1 |
| 2 | jspdf | 2.5.2 | GHSA-8mvj-3j78-4qmw | DoS via uncontrolled resource consumption | >=3.0.2 |
| 3 | jspdf | 2.5.2 | GHSA-pqxr-3g65-p328 | PDF Injection in AcroFormChoiceField (arbitrary JS exec) | >=4.1.0 |
| 4 | jspdf | 2.5.2 | GHSA-95fx-jjr5-f39c | DoS via unvalidated BMP image dimensions | >=4.1.0 |
| 5 | jspdf | 2.5.2 | GHSA-9vjf-qc39-jprp | PDF Object Injection via unsanitized input in addJS method | >=4.2.0 |
| 6 | jspdf | 2.5.2 | GHSA-67pg-wm7f-q7fj | Client/Server DoS via malicious SVG/image in html() method | >=4.2.0 |
| 7 | jspdf | 2.5.2 | GHSA-p5xg-68wr-hm3m | PDF Injection in AcroForm module (arbitrary JS execution) | >=4.2.0 |
| 8 | jspdf | 2.5.2 | GHSA-7x6v-j9x4-qf24 | PDF Object Injection via FreeText annotation color field | >=4.2.1 |

### Moderate (7)

| # | Package | Installed | GHSA | CVE | Title (short) | Patched |
|---|---|---|---|---|---|---|
| 1 | dompurify | 2.5.9 | GHSA-vhxf-7vqr-mrjg | CVE-2025-26791 | XSS via incorrect SAFE_FOR_TEMPLATES regex | >=3.2.4 |
| 2 | dompurify | 2.5.9 | GHSA-h8r8-wccr-v5f2 | — | mutation-XSS via re-contextualization | >=3.3.2 |
| 3 | dompurify | 2.5.9 | GHSA-cjmm-f4jc-qw8r | — | ADD_ATTR predicate skips URI validation | >=3.3.2 |
| 4 | dompurify | 2.5.9 | GHSA-cj63-jhhr-wcxv | — | USE_PROFILES prototype pollution allows event handlers | >=3.3.2 |
| 5 | dompurify | 2.5.9 | GHSA-39q2-94rc-95cp | — | ADD_TAGS short-circuit bypasses FORBID_TAGS | >=3.4.0 |
| 6 | jspdf | 2.5.2 | GHSA-vm32-vv63-w422 | — | Stored XMP Metadata Injection (spoofing + integrity bypass) | >=4.1.0 |
| 7 | jspdf | 2.5.2 | GHSA-cjw8-79x6-5cj4 | — | Shared State Race Condition in addJS plugin | >=4.1.0 |

### Remediation Plan

The complete fix requires one version bump to `jspdf` (which carries a bundled `dompurify`). Because `dompurify` is not a direct dep in any workspace `package.json`, we must also add a `pnpm.overrides` entry to force the bundled copy to a safe version.

**Steps:**

1. Upgrade `jspdf` in `packages/extension/package.json` from `"^2.5.2"` to `"^4.2.1"`. This resolves all 12 jspdf advisories (2 CRITICAL + 8 HIGH + 2 MODERATE).

2. Add a `pnpm.overrides` block to the root `package.json` to force the transitive `dompurify` used by jspdf (and any other future transitive consumer) to `>=3.4.0`, resolving all 5 dompurify advisories:
   ```json
   "pnpm": {
     "overrides": {
       "dompurify": "^3.4.0"
     }
   }
   ```

3. Run `pnpm install` to update `pnpm-lock.yaml`.

4. Run `pnpm --filter @accessbridge/extension build` to confirm jspdf 4.x API is compatible with the current PDF export usage in the extension.

5. Run `pnpm --filter @accessbridge/extension test` and `npx vitest run` to confirm no regressions.

6. Re-run `pnpm audit --prod` — expected result: 0 advisories.

**Note on jspdf 2.x → 4.x breaking changes:** jsPDF 4.x dropped several deprecated APIs. If the extension's `audit-export.ts` (or equivalent) uses `doc.addFont()`, `doc.fromHTML()`, or positional `output()` signatures that changed in 3.x/4.x, minor source updates may be required alongside the version bump. Review the jsPDF changelog for `fromHTML` → `html()` migration if applicable.

### Per-Advisory Detail

| Advisory ID | GHSA | Package | Installed | Patched | Severity | CVE |
|---|---|---|---|---|---|---|
| 1103308 | GHSA-w532-jxjh-hjhj | jspdf | 2.5.2 | >=3.0.1 | HIGH | CVE-2025-29907 |
| 1105772 | GHSA-vhxf-7vqr-mrjg | dompurify | 2.5.9 | >=3.2.4 | MODERATE | CVE-2025-26791 |
| 1107412 | GHSA-8mvj-3j78-4qmw | jspdf | 2.5.2 | >=3.0.2 | HIGH | — |
| 1112264 | GHSA-f8cm-6447-x5h2 | jspdf | 2.5.2 | >=4.0.0 | CRITICAL | — |
| 1112801 | GHSA-pqxr-3g65-p328 | jspdf | 2.5.2 | >=4.1.0 | HIGH | — |
| 1112802 | GHSA-95fx-jjr5-f39c | jspdf | 2.5.2 | >=4.1.0 | HIGH | — |
| 1112803 | GHSA-vm32-vv63-w422 | jspdf | 2.5.2 | >=4.1.0 | MODERATE | — |
| 1112804 | GHSA-cjw8-79x6-5cj4 | jspdf | 2.5.2 | >=4.1.0 | MODERATE | — |
| 1113310 | GHSA-9vjf-qc39-jprp | jspdf | 2.5.2 | >=4.2.0 | HIGH | — |
| 1113324 | GHSA-67pg-wm7f-q7fj | jspdf | 2.5.2 | >=4.2.0 | HIGH | — |
| 1114396 | GHSA-p5xg-68wr-hm3m | jspdf | 2.5.2 | >=4.2.0 | HIGH | — |
| 1114950 | GHSA-7x6v-j9x4-qf24 | jspdf | 2.5.2 | >=4.2.1 | HIGH | — |
| 1114974 | GHSA-wfv2-pwc8-crg5 | jspdf | 2.5.2 | >=4.2.1 | CRITICAL | — |
| 1115529 | GHSA-h8r8-wccr-v5f2 | dompurify | 2.5.9 | >=3.3.2 | MODERATE | — |
| 1115921 | GHSA-cjmm-f4jc-qw8r | dompurify | 2.5.9 | >=3.3.2 | MODERATE | — |
| 1115922 | GHSA-cj63-jhhr-wcxv | dompurify | 2.5.9 | >=3.3.2 | MODERATE | — |
| 1116663 | GHSA-39q2-94rc-95cp | dompurify | 2.5.9 | >=3.4.0 | MODERATE | — |

---

## Rust (cargo audit)

**Lockfile:** 636 dependencies scanned.
**Database:** 1050 advisories, last updated 2026-04-21.

### Vulnerabilities: 0

No exploitable vulnerabilities found.

### Warnings

#### Unsound (2)

| Crate | Version | RUSTSEC | Title | Origin |
|---|---|---|---|---|
| glib | 0.18.5 | RUSTSEC-2024-0429 | Unsoundness in `Iterator` and `DoubleEndedIterator` impls | Tauri GTK3 bindings (Linux only) |
| rand | 0.7.3 | RUSTSEC-2026-0097 | Unsound with a custom logger using `rand::rng()` | Transitive via Tauri/desktop-agent |

**RUSTSEC-2024-0429 (glib 0.18.5):** The `Iterator` and `DoubleEndedIterator` implementations in `glib 0.18.x` contain unsound code that can trigger undefined behavior. This crate is pulled in transitively via `atk 0.18.2 → glib 0.18.5` as part of the gtk-rs GTK3 binding chain. It only affects Linux builds. No direct fix available until Tauri migrates off GTK3.

**RUSTSEC-2026-0097 (rand 0.7.3):** Using `rand::rng()` with a custom global logger can trigger unsound behavior. `rand 0.7.3` is a transitive dep. Tauri 2.x ships `rand 0.8.x` for most paths; check `cargo tree -i rand` to confirm whether 0.7.3 is still active or can be bumped with `cargo update -p rand`.

#### Unmaintained (17)

**gtk-rs GTK3 bindings (11 crates):** All archived upstream; no new versions planned.

| Crate | Version | RUSTSEC |
|---|---|---|
| atk | 0.18.2 | RUSTSEC-2024-0413 |
| atk-sys | 0.18.2 | RUSTSEC-2024-0416 |
| gdk | 0.18.2 | RUSTSEC-2024-0412 |
| gdk-sys | 0.18.2 | RUSTSEC-2024-0418 |
| gdkwayland-sys | 0.18.2 | RUSTSEC-2024-0411 |
| gdkx11 | 0.18.2 | RUSTSEC-2024-0417 |
| gdkx11-sys | 0.18.2 | RUSTSEC-2024-0414 |
| gtk | 0.18.2 | RUSTSEC-2024-0415 |
| gtk-sys | 0.18.2 | RUSTSEC-2024-0420 |
| gtk3-macros | 0.18.2 | RUSTSEC-2024-0419 |
| fxhash | 0.2.1 | RUSTSEC-2025-0057 |

**unic-* text processing crates (5 crates):** Deprecated; replacements are `unicode-ident` and `unicode-width`.

| Crate | Version | RUSTSEC |
|---|---|---|
| unic-char-property | 0.9.0 | RUSTSEC-2025-0081 |
| unic-char-range | 0.9.0 | RUSTSEC-2025-0075 |
| unic-common | 0.9.0 | RUSTSEC-2025-0080 |
| unic-ucd-ident | 0.9.0 | RUSTSEC-2025-0100 |
| unic-ucd-version | 0.9.0 | RUSTSEC-2025-0098 |

**proc-macro-error (1 crate):**

| Crate | Version | RUSTSEC |
|---|---|---|
| proc-macro-error | 1.0.4 | RUSTSEC-2024-0370 |

### Remediation Plan

1. **gtk-rs GTK3 / glib / rand (unsound + unmaintained):** These are all transitive via Tauri 2's Linux backend. No direct action available in this repo. Track the Tauri 2.x roadmap for gtk4-rs migration. Run `cargo update` periodically and re-audit. Add a suppress block in `packages/desktop-agent/src-tauri/deny.toml` with expiry `2026-10-22` for all RUSTSEC-2024-04xx IDs.

2. **unic-* crates:** Run `cargo tree -i unic-char-property` to identify the direct dependent. If it is a Tauri transitive, the same suppress approach applies. If it is a direct dep of desktop-agent code, replace with `unicode-ident` + `unicode-width`.

3. **proc-macro-error:** Entirely a build-time proc-macro — no runtime risk. Suppress in `deny.toml`.

4. **rand 0.7.3:** Run `cargo update -p rand --precise 0.8.5` to see if the tree resolves cleanly. If not, it is forced by a Tauri transitive and must wait for an upstream bump.

---

## Python

`pip-audit` was run against the project's Python tooling. No `requirements.txt` was found in `tools/prepare-models/` — the scripts (`download-hf-models.py`, `train-struggle-classifier.py`, etc.) list their imports inline but do not declare a pinned requirements file.

System Python 3.14.3 has `lxml 6.0.2` (CVE-2026-41066, fixed in 6.1.0), but `lxml` is not used by any AccessBridge Python script. The system-level advisory does not affect the project.

**Deployment ops item:** Verify that `lxml` is absent from the `accessbridge-api` FastAPI Docker image (`python:3.11-slim` base). If `lxml` appears in the VPS image's pip list, upgrade the container's `lxml` to `>=6.1.0` before the next VPS redeploy.

**Recommendation:** Add a `tools/prepare-models/requirements.txt` that pins all model-tool deps. This enables future `pip-audit` runs to produce a definitive project-scoped result.

---

## Docker

`docker scout cves` is not available in this development environment. Scan is deferred to CI.

**Base images to scan when the CI security workflow runs:**

| Service | Base Image |
|---|---|
| accessbridge-api | python:3.11-slim |
| accessbridge-observatory | node:20-slim |
| accessbridge-nginx | nginx:alpine |

Wire `docker/scout-action` into `.github/workflows/security.yml` (create this workflow if it does not exist). Recommended trigger: `schedule: cron: '0 3 * * 1'` (weekly Mondays 03:00 UTC).

---

## Automation

Dependabot is configured at `.github/dependabot.yml`. See that file for full configuration. Key coverage:

- npm (pnpm-compat) at repo root — weekly Mondays
- npm per workspace package (core, extension, ai-engine, onnx-runtime, desktop-agent, observatory) — weekly Mondays
- cargo for `packages/desktop-agent/src-tauri/` — weekly Mondays
- github-actions at root — weekly Mondays

Note: no `requirements.txt` exists yet for `tools/prepare-models/`, so pip ecosystem coverage is pending creation of that file.
