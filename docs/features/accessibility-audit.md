# Accessibility Audit

## Overview

The Accessibility Audit feature provides automated, heuristic-based WCAG 2.1 scanning of any web page the user is visiting. It is part of **Layer 9 — Observability** in the AccessBridge 11-layer architecture and corresponds to **Deferred Feature #20** in the HANDOFF.md sprint log.

When triggered from the side panel, the audit:

1. Injects `collectAuditInput()` via the content script to walk the live DOM and capture element metadata, computed styles, bounding boxes, and structural information.
2. Passes the `AuditInput` payload to `AuditEngine.run()` in the `@accessbridge/core/audit` module, which evaluates 20 built-in WCAG rules.
3. **Session 18:** in parallel with (2), the sidepanel asks the content script to inject and run [axe-core](https://github.com/dequelabs/axe-core) against the live MAIN-world DOM. axe contributes ~90 additional WCAG + ARIA findings with canonical help URLs.
4. `mergeAuditFindings(customFindings, axeFindings)` deduplicates by `(wcagCriterion, elementSelector)` — overlapping flags are promoted to `source: 'both'`, axe-only findings get `source: 'axe'`, custom-only get `source: 'custom'`. The overall score is deducted against the merged (dedup'd) set, not both sources twice.
5. Returns an `AuditReport` containing scored findings with `source` badges, per-category scores, overall score, WCAG compliance percentages, and a `sources: { custom, axe, both }` tally.
6. Renders the report in `AuditPanel.tsx` inside the side panel — interactive, with severity badges, source badges, source filters, WCAG links, and element selectors.
7. Optionally exports the full report as a multi-page PDF via `pdf-generator.ts`.

This feature enables developers to get instant, in-browser accessibility feedback without leaving their workflow, and produces portable compliance artifacts for teams and stakeholders. The three-tier test pyramid (20 custom rules + axe-core industry standard + merge/dedup vitest coverage) is documented in [testing.md](../testing.md).

---

## WCAG Rules Reference

The following 20 rules are evaluated on every audit run.

| # | Rule ID | Rule Name | WCAG Criterion | Level | Severity |
|---|---------|-----------|---------------|-------|----------|
| 1 | `img-alt` | Images missing alt | 1.1.1 | A | critical |
| 2 | `empty-link` | Empty links | 2.4.4 | A | serious |
| 3 | `empty-button` | Empty buttons | 4.1.2 | A | serious |
| 4 | `form-label` | Form inputs missing labels | 3.3.2 | A | serious |
| 5 | `heading-order` | Heading hierarchy violations | 1.3.1 | AA | moderate |
| 6 | `contrast-aa` | Color contrast (AA) | 1.4.3 | AA | serious |
| 7 | `contrast-aaa` | Color contrast (AAA) | 1.4.6 | AAA | moderate |
| 8 | `target-size-aa` | Click targets under 24x24 | 2.5.8 | AA | moderate |
| 9 | `target-size-aaa` | Click targets under 44x44 | 2.5.5 | AAA | minor |
| 10 | `document-lang` | Missing document lang attribute | 3.1.1 | A | serious |
| 11 | `duplicate-id` | Duplicate IDs | 4.1.1 | A | serious |
| 12 | `table-headers` | Tables missing headers | 1.3.1 | A | serious |
| 13 | `keyboard-trap` | Keyboard trap heuristic | 2.1.2 | A | moderate |
| 14 | `autoplay-media` | Autoplay audio/video | 1.4.2 | A | serious |
| 15 | `flashing-content` | Flashing content heuristic | 2.3.1 | A | serious |
| 16 | `skip-link` | Missing skip link | 2.4.1 | A | moderate |
| 17 | `frame-title` | Frames missing title | 4.1.2 | A | serious |
| 18 | `focus-order` | Focus order violations | 2.4.3 | A | moderate |
| 19 | `link-purpose` | Generic link text | 2.4.4 | AA | minor |
| 20 | `redundant-title` | Redundant title attribute | 2.4.9 | AAA | info |

**Session 18 additions:** on every scan, axe-core contributes an additional ~90 WCAG + ARIA checks with canonical help URLs. These findings carry `source: 'axe'` (or `'both'` when the custom engine independently corroborates them). The `rawAxe` field preserves axe's original violation node for power-user debugging.

---

## axe-core integration

Session 18 added axe-core alongside the custom rules. axe cannot run in the extension's ISOLATED content-script world because it introspects `window.axe`, so the flow is:

1. Sidepanel button → `chrome.runtime.sendMessage({ type: 'AUDIT_RUN_AXE' })`.
2. Background forwards to the active tab's content script via `chrome.tabs.sendMessage`.
3. Content script ([content/audit/axe-runner.ts](../../packages/extension/src/content/audit/axe-runner.ts)) injects `axe.min.js` into the page's MAIN world via `<script src="chrome-extension://.../axe.min.js">`. The file lives in `manifest.web_accessible_resources`.
4. A second inline `<script>` runs `await window.axe.run()` and posts the results back via `window.postMessage({ type: 'AB_AXE_RESULT', nonce, results })`. The nonce is a `crypto.randomUUID()` — a page-level `MutationObserver` attacker cannot guess it ahead of time.
5. Content script resolves the promise, background returns to sidepanel.
6. Sidepanel maps `AxeResults → AuditFinding[]` via `mapAxeViolationsToFindings`, merges via `mergeAuditFindings`, and rebuilds the scored report via `rebuildReportWithMergedFindings`.

**axe-core is never imported from `@accessbridge/core` or bundled into the content-script chunk.** It lives only as a file copy (`packages/extension/node_modules/axe-core/axe.min.js` → `dist/axe.min.js`). This keeps the content-script IIFE safe from BUG-008/BUG-012-class regressions and avoids a ~564 KB per-page-load tax.

### Coverage comparison

| Source | Count | Strengths | Weaknesses |
| --- | --- | --- | --- |
| Custom rules | 20 | Domain-aware, offline, fast, integrated with our UI copy | Small rule count, heuristic |
| axe-core | ~90 | Industry standard, canonical WCAG mappings, help URLs | ~564 KB on-demand, depends on page MAIN-world |
| Merged | de-dup'd | Best of both | — |

### WCAG criterion extraction

axe-core emits tags like `wcag111` (1.1.1), `wcag143` (1.4.3), and `wcag1410` (1.4.10). The extractor's regex is `^wcag(\d)(\d)(\d+)$` — principle and guideline are always single digits (WCAG has 4 principles × ≤5 guidelines), so the criterion is the only component that can exceed one digit. See [packages/core/src/audit/axe-integration.ts](../../packages/core/src/audit/axe-integration.ts) for implementation + regression tests.

---

## Scoring Methodology

Each rule that fires deducts points from a baseline score of **100**. Deductions are weighted by severity:

| Severity | Points deducted per finding |
|----------|-----------------------------|
| critical | 25 |
| serious  | 10 |
| moderate | 5  |
| minor    | 2  |
| info     | 0  |

The deductions are summed and subtracted from 100. The result is **clamped to [0, 100]**:

```
score = clamp(100 - Σ(deduction_per_finding), 0, 100)
```

Per-category scores (perceivable / operable / understandable / robust) apply the same formula but only against findings belonging to that WCAG principle.

### WCAG Compliance Calculation

WCAG compliance percentages (`wcagCompliance.A`, `AA`, `AAA`) represent the fraction of rules at each level that did **not** fire any findings on the current page:

```
compliance[level] = (rules[level] with 0 findings) / (total rules at level) × 100
```

This gives a per-level pass rate, independent of how many elements were flagged — a single rule either fired or it did not.

---

## PDF Export Format

The exported PDF uses jsPDF with Helvetica (no custom fonts or embedded images). Layout:

### Page 1 — Cover
- Title: "AccessBridge Accessibility Audit" (bold, 24pt)
- Subtitle: page URL (truncated to 80 chars) and formatted scan date
- Large centered score circle (48pt number, color-coded: green ≥80, amber 50–79, red <50)
- Score label: Good / Fair / Poor
- WCAG compliance strip: `A: N%  ·  AA: N%  ·  AAA: N%`
- Summary count band: Critical / Serious / Moderate / Minor / Info counts

### Page 2 — Executive Summary + Category Scores
- Four horizontal bars, one per WCAG principle with percentage and color
- Auto-generated paragraph identifying the lowest-scoring principle, finding counts, and top severity category

### Pages 3+ — Findings
- Grouped by WCAG principle (perceivable → operable → understandable → robust)
- Within each group: sorted critical → info
- Each finding printed as:
  - Severity badge + "WCAG {criterion} — {rule}"
  - Element selector
  - Human-readable message
  - Actionable suggestion
  - HTML snippet (≤120 chars) in a shaded monospace box
- Automatic page breaks when the y-cursor exceeds 270 mm

### Last Page — Compliance Statement
- "Generated by AccessBridge v{version} on {date}."
- "This report identifies {N} potential accessibility issues based on WCAG 2.1 heuristics."
- "It is a developer aid and does not constitute formal certification."

---

## Use Cases

### Developer Feedback Loop
Run the audit during development to catch regressions before they ship. The side-panel integration means there is no context switch — developers can audit, inspect findings, fix code, reload, and re-audit without leaving the browser.

### Compliance Reporting
Export a PDF artifact to share with project managers, clients, or accessibility reviewers. The cover page's overall score and WCAG compliance percentages give non-technical stakeholders a clear picture of current status.

### Accessibility Audit Archival
Store dated PDFs as audit snapshots. Comparing reports across versions provides a documented paper trail showing accessibility progress over time — useful for legal compliance and internal quality gates.

### Test Fixtures
The `AuditInput` and `AuditReport` JSON shapes are serializable. Capture them during a browser run and replay them in unit tests against `AuditEngine.run()` without needing a browser environment, enabling regression testing of scoring logic.

---

## Integration with the Observability Layer

```
Side Panel
  └── AuditPanel.tsx
        │
        ├── (click "Run Audit")
        │     │
        │     └── chrome.tabs.sendMessage → content script
        │                │
        │                └── collectAuditInput()   ← audit-collector.ts
        │                      returns AuditInput
        │
        ├── AuditEngine.run(input)                 ← @accessbridge/core/audit
        │     applies 20 WCAG rules
        │     returns AuditReport
        │
        ├── Renders findings via:
        │     ScoreRing.tsx      — animated score ring
        │     WCAGBadge.tsx      — level/severity chips
        │     CategoryBar.tsx    — per-principle progress bars
        │     FindingItem.tsx    — expandable finding rows
        │
        └── (optional) generateAuditPDF / downloadAuditPDF
                                                   ← pdf-generator.ts
```

This connects to **Deferred Feature #20** in HANDOFF.md: the audit was scoped during the Day 6 Shift 3 UX overhaul and deferred to permit the parallel implementation of the audit engine and PDF export. The integration point is fully wired in `AuditPanel.tsx` and the content-script message handler in `content/index.ts`.

---

## Implementation File Map

| File | Package | Purpose |
|------|---------|---------|
| `packages/core/src/audit/types.ts` | `@accessbridge/core` | All shared TypeScript interfaces (AuditNode, AuditReport, etc.) |
| `packages/core/src/audit/rules.ts` | `@accessbridge/core` | 20 WCAG rule implementations |
| `packages/core/src/audit/engine.ts` | `@accessbridge/core` | AuditEngine orchestrator — runs rules, computes scores |
| `packages/core/src/audit/index.ts` | `@accessbridge/core` | Barrel re-export for `@accessbridge/core/audit` |
| `packages/extension/src/content/audit-collector.ts` | `@accessbridge/extension` | DOM walker — collects AuditInput from the live page |
| `packages/extension/src/sidepanel/audit/AuditPanel.tsx` | `@accessbridge/extension` | React UI — displays AuditReport with interactive findings |
| `packages/extension/src/sidepanel/audit/ScoreRing.tsx` | `@accessbridge/extension` | Animated SVG score ring component |
| `packages/extension/src/sidepanel/audit/WCAGBadge.tsx` | `@accessbridge/extension` | WCAG level and severity badge chips |
| `packages/extension/src/sidepanel/audit/CategoryBar.tsx` | `@accessbridge/extension` | Horizontal bar for per-principle scores |
| `packages/extension/src/sidepanel/audit/FindingItem.tsx` | `@accessbridge/extension` | Expandable finding row with selector and suggestion |
| `packages/extension/src/sidepanel/audit/pdf-generator.ts` | `@accessbridge/extension` | jsPDF-based report generator and download trigger |
| `packages/extension/src/sidepanel/audit/audit.css` | `@accessbridge/extension` | Scoped styles for the audit panel |

---

## Dependencies

- **jsPDF** (`^2.5.2`) — PDF generation, already declared in `packages/extension/package.json`
- **@accessbridge/core** (`workspace:*`) — shared types and rule engine
- No additional runtime dependencies required

---

## Performance Notes

- `collectAuditInput()` caps at 5000 elements collected while keeping `totalElements` accurate for the full DOM count.
- A single `forEach` pass over the element list builds all secondary indexes (landmarks, headings, tables, frames, forms, focusOrder, etc.) to keep total runtime under ~500ms on typical pages.
- Bounding rects and computed styles are read inside the same iteration — no second layout pass.
- HTML snippets are capped at 200 characters and `data:image/` URIs are redacted to keep the serialized payload small.
