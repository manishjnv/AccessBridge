# E2E tests (Playwright)

```bash
pnpm test:e2e          # headless-ish run (CI default)
pnpm test:e2e:ui       # interactive inspector
pnpm test:e2e:debug    # PWDEBUG=1 step-through
```

See [docs/testing.md](../docs/testing.md) for the full test pyramid.

## Philosophy

Playwright covers **golden-path** flows that cross module boundaries (popup → content → background). Unit-testable logic lives in vitest — E2E is for regressions that only appear when the real Chromium + MV3 service worker + content script triad is wired up.

## Adding a spec

1. Drop a file in `specs/`, import `{ test, expect }` from `../fixtures.js`.
2. Use helpers from `utils/extension-helpers.ts` rather than re-implementing.
3. If a test hits an AI provider, the `installAiMocks` fixture already intercepts Gemini/Anthropic/Bedrock. Run against real providers with `AB_E2E_REAL_AI=1` locally (never in CI).

## Extension-loading caveat

MV3 extensions can't run in traditional headless mode. The config launches a persistent context with `--load-extension=...`. CI uses `xvfb-run` to make this work headlessly. If you're debugging flake locally, remove `headless: false` from `playwright.config.ts` use-block and watch the real window.
