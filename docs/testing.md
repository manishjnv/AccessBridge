# Testing

AccessBridge ships three test tiers. Each catches a different class of regression; all three must stay green before a release.

```
┌─────────────────────────────────────────────────────────┐
│            Playwright E2E  —  ~20 specs                 │  slow · high-signal
│   popup/sidepanel lifecycle · audit+axe · PDF export    │  runs Chromium + MV3
│   sensory adapter · reload recovery · simplifier        │  cross-module
├─────────────────────────────────────────────────────────┤
│            Vitest unit  —  900+ tests                   │  fast · focused
│   core engines · AI providers · crypto · gestures       │  pure TS, no DOM
│   audit rules · axe-integration merge · WCAG extraction │
├─────────────────────────────────────────────────────────┤
│            TypeScript strict  —  every package          │  fastest · structural
│   `pnpm typecheck` — runs tsc --noEmit in all packages  │
└─────────────────────────────────────────────────────────┘
```

## Running locally

```bash
pnpm typecheck              # structural correctness (seconds)
pnpm -r test                # full vitest suite (900+ tests, ~15 s)
pnpm test:e2e               # Playwright (~5 min, needs Chromium install)
pnpm test:all               # everything — pre-push gate
```

E2E-specific variants:

```bash
pnpm test:e2e:ui            # Playwright UI mode (interactive)
pnpm test:e2e:debug         # PWDEBUG=1 — step through each action
AB_E2E_REAL_AI=1 pnpm test:e2e   # hit real AI providers (local only, burns credits)
```

First E2E run needs browser install:

```bash
pnpm exec playwright install --with-deps chromium
```

## Test tiers — what goes where

### TypeScript / `pnpm typecheck`

Catches type drift, bad refactors, missing exports. Free — runs in milliseconds. If typecheck is red, fix before anything else.

### Vitest (unit)

Location: `packages/*/src/**/__tests__/*.test.ts`.

Covers:
- Pure logic: decision engine, struggle detector, audit rules, fusion, crypto, i18n.
- Mappers + adapters: AI providers (mocked), profile store, axe-integration merge/dedup.
- Structural invariants: WCAG criterion extraction, proto-pollution guards, severity mapping.

Does **not** cover:
- DOM behavior (no jsdom — tests run in Node).
- Real Chromium extension runtime.
- Cross-module flows (popup → background → content).

Adding a unit test: drop a `*.test.ts` next to the file under test. No config — vitest finds it automatically.

### Playwright (E2E)

Location: [e2e/specs/](../e2e/specs/). Fixtures: [e2e/fixtures.ts](../e2e/fixtures.ts). Helpers: [e2e/utils/](../e2e/utils/).

Covers:
- **Popup + sidepanel lifecycle** — opens, tabs switch, no console errors, cold-open latency.
- **Sensory adapter** — slider change persists to profile; toggle state survives reopen.
- **Reload recovery** — BUG-005 guard: profile survives popup close + storage round-trips.
- **Cognitive simplifier** — focus mode + distraction shield toggles don't throw on real pages.
- **Accessibility audit + axe-core** — merged findings render with source badges (custom / axe / both); PDF export produces a valid `%PDF-…%%EOF` file.

Does **not** cover (deferred to future "hard-to-test surfaces" session):
- Voice commands (Web Speech API mocking in a content script from Playwright is brittle — unit tests already cover the command parser).
- Gestures (touch + trackpad simulation is flaky in Chromium headless).
- Indian-language transliteration (unicode input paths need dedicated fixtures).
- Observatory ZK-attestation flows (mocked VPS crypto endpoints — 63 crypto tests cover the invariants).
- Domain connectors (need per-domain fixture HTML pages).

**Extension-loading caveat.** MV3 extensions can't run in traditional headless mode — Playwright launches Chromium with `--load-extension=packages/extension/dist/`. CI wraps this in `xvfb-run`. If you're debugging flake locally, drop `headless: false` in [playwright.config.ts](../playwright.config.ts) and watch the real window.

**AI mocking.** [e2e/utils/mock-ai.ts](../e2e/utils/mock-ai.ts) intercepts Gemini / Anthropic / Bedrock fetches by default. Set `AB_E2E_REAL_AI=1` to disable mocking (local only — never in CI).

Adding an E2E test: drop `<feature>.spec.ts` in `e2e/specs/`, import `{ test, expect }` from `../fixtures.js`, use role/text selectors (not CSS) for resilience.

## The accessibility-audit triad

The audit engine is notable for combining three sources:

1. **Custom rules** — 20 hand-rolled WCAG heuristics in `@accessbridge/core/audit/rules` (contrast, alt text, heading order, tap targets, …). Domain-aware, fast, offline.
2. **axe-core** — industry standard, injected into the active tab's MAIN world via a `<script src>` tag from [web_accessible_resources](../packages/extension/manifest.json). ~90 WCAG + ARIA checks with canonical descriptions + help URLs.
3. **Pa11y / HTML_CodeSniffer** — not integrated in-extension; reserved for developer batch eval against URL lists (future `tools/pa11y/` addition).

Findings from (1) and (2) are merged in `mergeAuditFindings(customFindings, axeFindings)` by `(wcagCriterion, elementSelector)` dedup key. When both engines flag the same element under the same criterion the finding becomes `source: 'both'` and the axe-core raw node is preserved under `rawAxe` for power-user debugging.

See [features/accessibility-audit.md](features/accessibility-audit.md) for the full rule list + scoring methodology + axe mapping details.

## CI workflows

Two workflows, split so a flaky E2E doesn't block the cheap green path:

- [.github/workflows/ci.yml](../.github/workflows/ci.yml) — typecheck + unit tests + build + IIFE guard (BUG-008/012) + zip manifest cross-check (BUG-011) + axe.min.js bundle check. Fast path.
- [.github/workflows/e2e.yml](../.github/workflows/e2e.yml) — Playwright over `xvfb-run`. Slower. Uploads the HTML report + traces + videos on failure.

## Debugging tips

- Playwright test flakes locally but passes on my machine: check time-sensitive assertions. Extension SW boot takes ~1 s; use `await context.waitForEvent('serviceworker')` rather than fixed timeouts.
- Audit test fails with "content script unreachable": the persistent context hasn't finished loading the extension yet. The `openPopup` / `openSidePanel` helpers wait for `domcontentloaded`; add `await page.waitForTimeout(300)` before the first message-send if debugging.
- axe integration test fails with "axe-core timed out after 30s": the page's CSP blocks inline `<script>`. axe injection falls back to graceful failure — the test should assert `error` path not `results` path. See `AxeResultsEnvelope` in [content/audit/axe-runner.ts](../packages/extension/src/content/audit/axe-runner.ts).
