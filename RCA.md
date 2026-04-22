# AccessBridge — Root Cause Analysis (RCA) Log

Track every bug fix: what broke, why, how it was fixed, and how to prevent recurrence.

---

## BUG-001: Popup/Sidepanel HTML absolute paths break Chrome sideload

| Field | Detail |
|-------|--------|
| **Date** | 2026-04-06 |
| **Severity** | Critical |
| **Symptom** | Extension popup and side panel show blank white page when sideloaded in Chrome |
| **Root Cause** | Vite default `base: '/'` generates absolute paths (`/assets/popup-xxx.js`) in HTML. Chrome extensions serve from `chrome-extension://` origin where `/assets/` resolves to nothing |
| **Fix** | Added `base: ''` to `vite.config.ts` so HTML uses relative paths (`../../assets/popup-xxx.js`) |
| **Files Changed** | `packages/extension/vite.config.ts` |
| **Commit** | `1d5413e` |
| **Prevention** | Never remove `base: ''` from Vite config. Any new HTML entry point must verify relative paths in `dist/` after build |

---

## BUG-002: Update checker fetches raw API port (8100) instead of nginx proxy

| Field | Detail |
|-------|--------|
| **Date** | 2026-04-06 |
| **Severity** | High |
| **Symptom** | Update check fails silently — no update banner shown even when version mismatch exists |
| **Root Cause** | `UPDATE_SERVER` pointed to `http://72.61.227.64:8100` (direct API). Port 8100 is not exposed through firewall; only nginx ports (8080/8300/9090) are accessible externally |
| **Fix** | Changed `UPDATE_SERVER` to `http://72.61.227.64:8300/api` (nginx proxy path). Download URL points to `http://72.61.227.64:8300/downloads/...` |
| **Files Changed** | `packages/extension/src/background/index.ts` |
| **Commit** | `b09b5a1` |
| **Prevention** | All external URLs from extension must go through nginx proxy (port 8300). Never reference internal Docker ports (8100, 8200) in client code |

---

## BUG-003: Extension version mismatch — manifest says 0.1.0 while API says 0.1.1

| Field | Detail |
|-------|--------|
| **Date** | 2026-04-06 |
| **Severity** | Medium |
| **Symptom** | Update banner always shows even after fresh install from latest zip, because manifest.json still had old version |
| **Root Cause** | `CURRENT_VERSION` in VPS API was bumped to `0.1.1` but `manifest.json` was not updated to match |
| **Fix** | Bumped `manifest.json` version to `0.1.1` |
| **Files Changed** | `packages/extension/manifest.json` |
| **Commit** | `105dd0f` |
| **Prevention** | Version bump checklist: (1) `manifest.json`, (2) VPS API `CURRENT_VERSION`, (3) rebuild + rezip + upload. All three must match |

---

## BUG-004: Landing page shows hardcoded version and stale team name

| Field | Detail |
|-------|--------|
| **Date** | 2026-04-06 |
| **Severity** | Medium |
| **Symptom** | Footer shows "v0.1.0" and "Manish Kumar & Team" after version bump and name correction |
| **Root Cause** | Version and team name were hardcoded in `deploy/index.html`. Multiple copies of the file existed (local edits vs VPS), causing stale values to persist after SCP uploads |
| **Fix** | (1) Changed footer version span to `id="app-version"`, (2) JS fetches `/api/version` on load and updates dynamically, (3) Download button `href` also set from API response, (4) Fixed team name to "Manish Kumar" |
| **Files Changed** | `deploy/index.html` |
| **Commits** | `7eb30cb`, `2c59e02` |
| **Prevention** | Landing page must never hardcode version. All version/download info comes from `/api/version` at runtime. Team name: always "Manish Kumar" — no "& Team" |

---

## BUG-005: Master toggle (enable/disable) does not work

| Field | Detail |
|-------|--------|
| **Date** | 2026-04-06 |
| **Severity** | High |
| **Symptom** | Clicking the On/Off toggle in popup header has no visible effect. Extension always appears enabled. After closing and reopening popup, toggle resets to On |
| **Root Cause** | Three issues: (1) `enabled` state initialized to `true` with no persistence — resets every popup open, (2) toggling Off sends `REVERT_ALL` but toggling On doesn't restore anything, (3) tab content still visible and interactive when disabled |
| **Fix** | (1) Persist `enabled` to `chrome.storage.local`, restore on popup open, (2) When Off: `REVERT_ALL` + gray out UI with "disabled" message + block pointer events, (3) When On: user manually re-enables desired features |
| **Files Changed** | `packages/extension/src/popup/App.tsx` |
| **Commit** | `cb65e59` |
| **Prevention** | Any popup state that must survive popup close/reopen MUST use `chrome.storage.local`, never React `useState` alone. Test toggle by: open popup → toggle off → close popup → reopen → verify state persisted |

---

## Checklist: Before Every Bug Fix

1. **Read this RCA log** — ensure the fix doesn't reintroduce a previous bug
2. **Check related fixes** — e.g. if touching Vite config, re-verify BUG-001
3. **Build + test** — `pnpm build && npx vitest run` must pass
4. **Verify in Chrome** — reload extension, test the specific fix AND related features
5. **Update this log** — add new entry with root cause and prevention

## BUG-006: Stale hardcoded versions cause false positives in update check

| Field | Detail |
|-------|--------|
| **Date** | 2026-04-06 |
| **Severity** | Medium |
| **Symptom** | Side panel shows "v0.1.0" after version bump. Package.json files out of sync with manifest. Potential false positive update banners |
| **Root Cause** | Version was hardcoded in 4 places: `manifest.json`, 3x `package.json`, sidepanel `const VERSION`. Only manifest was bumped to 0.1.1, the rest stayed at 0.1.0 |
| **Fix** | (1) Bumped all package.json to 0.1.1, (2) Sidepanel now reads `chrome.runtime.getManifest().version` dynamically, (3) Popup already used `chrome.runtime.getManifest().version` |
| **Files Changed** | `packages/core/package.json`, `packages/ai-engine/package.json`, `packages/extension/package.json`, `packages/extension/src/sidepanel/index.tsx` |
| **Commit** | (pending) |
| **Prevention** | NEVER hardcode version strings in code. Always use `chrome.runtime.getManifest().version` in extension code. `manifest.json` is the single source of truth. Use version bump checklist below |

---

## BUG-007: Sensory sliders (font scale, contrast, etc.) have no effect on page

| Field | Detail |
|-------|--------|
| **Date** | 2026-04-06 |
| **Severity** | High |
| **Symptom** | Moving Font Scale slider to 2.0x has no visible effect on Wikipedia text. Same for contrast, line height, letter spacing |
| **Root Cause** | Two issues: (1) `PROFILE_UPDATED` message handler in content script was a no-op — acknowledged but never called SensoryAdapter methods with the new values. (2) Font scaling CSS used `font-size: inherit !important` on `*` selector which Wikipedia's deeply specific selectors override |
| **Fix** | (1) `PROFILE_UPDATED` handler now reads `profile.sensory` and calls each `sensory.apply*()` method. (2) Replaced `font-size: inherit` with CSS `zoom` property which works universally across all sites |
| **Files Changed** | `packages/extension/src/content/index.ts`, `packages/extension/src/content/styles.css` |
| **Commit** | `4f0ff17` |
| **Prevention** | Any new popup slider/toggle MUST verify the message reaches the content script AND the content script actually applies it. Test on Wikipedia (complex CSS) not just simple pages. Use `zoom` for scaling, never `font-size: inherit` |

---

## BUG-008: ALL features broken — content script var collision from IIFE chunk inlining

| Field | Detail |
|-------|--------|
| **Date** | 2026-04-07 |
| **Severity** | Critical |
| **Symptom** | No features work at all — focus mode, sensory sliders, voice commands, everything broken. No console errors visible in popup, but page console shows SyntaxError |
| **Root Cause** | Vite minifies shared chunks using short var names (R, I, etc). The custom `copyManifestPlugin` inlines all chunks into one IIFE. Two chunks both declared `var R = ...` — `SyntaxError: Identifier 'R' has already been declared` kills the entire content script on load |
| **Fix** | Wrap each inlined chunk in its own IIFE that returns exports via a namespace object. Import bindings aliased from namespace. No variable leaks between chunks |
| **Files Changed** | `packages/extension/vite.config.ts` |
| **Commit** | `de27d15` |
| **Prevention** | After ANY change to `vite.config.ts` or adding new shared imports in content script, ALWAYS run `node -c packages/extension/dist/src/content/index.js` to syntax-check the built output. Add this to the build verification checklist |

---

## BUG-009: Landing navbar stat pills overlap right-side nav links

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-20 |
| **Severity** | Medium |
| **Symptom** | On 1280–1440 px viewports (common 13–15″ laptops), the three "28 Languages / 7.0 B Speakers / 87% of World" quick-stat pills visually butted into the first right-side nav link ("Reach"), obscuring it |
| **Root Cause** | `.navbar-inner` used `justify-content: space-between` with no `gap`, so once the combined width of (brand + 3 pills) plus (7 nav links + version pill + Install button) exceeded the container, the two flex halves simply touched. The stat-pill hide breakpoint was set at 900 px, far narrower than the overlap threshold |
| **Fix** | (1) `.navbar-inner` now has `gap: 16px` as a guaranteed minimum separator. (2) `.navbar-links` gap trimmed 28 → 20 px (still 4 px rhythm). (3) Stat-pill breakpoints raised: shrink at ≤ 1400 px (was 1100), hide at ≤ 1280 px (was 900). Hero-stats strip below still carries the same data. (4) Replaced three hardcoded `v0.1.1` placeholders in the HTML with `v…` so the pre-JS render flash never shows a stale version — BUG-004 prevention re-asserted |
| **Files Changed** | `deploy/index.html` |
| **Commit** | `8828476` |
| **Prevention** | Any `flex` container using `justify-content: space-between` MUST also set a `gap` so overflow still leaves visual separation between children. Whenever adding elements to `.navbar-inner`, re-measure at 1280 px and 1440 px viewports. Any hardcoded `v…` version string in `deploy/index.html` is a bug — use `v…` as the loading placeholder; `/api/version` populates the real value |

---

## BUG-010: Cloudflare edge caches the zip URL — users get stale artifact for up to 4 h after every release

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-21 |
| **Severity** | High |
| **Symptom** | After v0.5.0 deploy, `/api/version` correctly reported `0.5.0`, VPS disk had the v0.5.0 zip (423 KB), but `GET /downloads/accessbridge-extension.zip` returned the v0.4.0 zip (417 KB, `Age: 1388`, `Cache-Control: max-age=14400`). The extension's self-update banner showed "0.5.0 available", but clicking Update re-installed v0.4.0. Landing-page download button same problem. |
| **Root Cause** | Site is fronted by Cloudflare (`Server: cloudflare`, `cf-ray` headers). Static asset responses get a 4-hour edge cache by default. After uploading a new zip to the origin, the Cloudflare edge continues serving the old cached response until its TTL expires — origin-side Caddy reload + container restart can't clear it. Manual Cloudflare dashboard purge works but wasn't part of deploy pipeline. The zip URL was a stable `/downloads/accessbridge-extension.zip` with no per-version query string, so every release collided with its predecessor's cache entry. |
| **Fix** | [scripts/vps/main.py](scripts/vps/main.py) — `/version` and `/updates.xml` endpoints now append `?v={manifest.version}` to the download URL. Distinct query strings are distinct cache keys for Cloudflare (default behaviour), so every release fetches a fresh object at the edge. Clients that consume `download_url` from `/api/version` (landing page download button, extension self-update check) automatically pick up the new URL with no code change. |
| **Files Changed** | `scripts/vps/main.py` |
| **Commit** | (pending — Session 7 post-deploy hotfix) |
| **Prevention** | Any CDN-fronted artifact URL MUST be version-keyed if the origin filename is stable. Never rely on edge purges as part of the deploy pipeline — assume you can't touch the edge. If a future CDN change disables query-key cache differentiation, fall back to versioned filenames (e.g. `accessbridge-extension-0.5.0.zip`). Deploy sanity check: after every release, curl the download URL (no cache-bust flags) and verify `Content-Length` matches the freshly built zip's size; if they diverge, the URL layout needs cache-busting. |

---

## BUG-011: `./deploy.sh` ships stale zip on auto-bump; rsync runtime failure does not fall back to scp

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-21 |
| **Severity** | High |
| **Symptom** | Session 8 deploy of v0.6.0 (`feat(deploy)` triggered minor bump from v0.5.0). Pipeline reported "✓ build passed" then died on `[3/6] Syncing artifacts to VPS` with `rsync: connection unexpectedly closed (0 bytes received so far) [sender=3.4.1]` and `dup() in/out/err failed`. After manual scp recovery + container restart, `/api/version` reported `0.4.0` not `0.6.0` — three releases behind. Ditto local `accessbridge-extension.zip` on disk: manifest claimed `0.4.0`. |
| **Root Cause** | Two compounding defects: (1) **No re-zip on bump.** `[0/6] Auto-bump version` updates `manifest.json` and `package.json` files, then `[1/6]` runs `pnpm build` which refreshes `dist/`. But the script never repackages `dist/` into `accessbridge-extension.zip` — that step is implicit/manual elsewhere in the workflow. So the deploy uploads whichever stale zip happens to be on disk (in our case the v0.4.0 zip from an earlier session). The new `/api/version` end-to-end zip cross-check (added this same session in [deploy.sh:230-260](deploy.sh#L230)) WOULD have caught this — but never executed because step 3 died first. (2) **rsync fallback gates on installed-vs-not, not runtime success.** [deploy.sh:142](deploy.sh#L142) uses `command -v rsync` to choose between rsync path and scp+tar fallback. On Git Bash for Windows, `rsync` IS installed but its progress reporting collides with the parent shell's stdio (`dup() in/out/err failed`), failing every invocation. The script has no `||` fallback for this case. |
| **Fix** | Manual recovery this session: rebuilt zip from `dist/` after bump, scp'd zip + CHANGELOG + main.py to VPS, `docker restart accessbridge-api`. End-to-end verified `/api/version` returns 0.6.0 and `/downloads/accessbridge-extension.zip?v=0.6.0` returns the 423120-byte v0.6.0 zip. Permanent fixes deferred to a follow-up: (a) add `[1.5/6] Re-zip dist` step after build, before VPS sync; (b) wrap rsync invocation in a try-with-scp-fallback so runtime failures degrade gracefully on Windows. |
| **Files Changed** | None this session — code fix deferred. Artifacts re-uploaded manually. |
| **Commit** | Recovery commits this session document the workaround; `deploy.sh` patch is open for next session. |
| **Prevention** | (a) Until deploy.sh is patched: after any `[0/6] Auto-bump` run, **manually verify** the zip's manifest version matches the bump target before proceeding — `python -c "import zipfile,json; print(json.loads(zipfile.ZipFile('accessbridge-extension.zip').read('manifest.json').decode())['version'])"`. (b) On Windows Git Bash, prefer `./deploy.sh --skip-bump` followed by manual zip rebuild + scp until rsync fallback is hardened. (c) The end-to-end zip cross-check from this session's `feat(deploy)` commit IS the right floor — it catches the symptom even if the root cause persists. Make sure step 3 doesn't crash before step 5 runs. |

---

## BUG-012: Content-script IIFE wrap leaks nested chunk imports — SyntaxError

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-21 |
| **Severity** | Critical |
| **Symptom** | After Session 10's Vision Recovery work, `pnpm build` succeeded but `node -c packages/extension/dist/src/content/index.js` failed: `SyntaxError: Unexpected token '{'` at the line `var __ab_chunk0=(function(){…import{A as p}from"./adaptation-Qwg4dGjT.js"…})()`. Chrome would have refused to load the content script at all, killing every feature — the exact symptom class as BUG-008. |
| **Root Cause** | The `copyManifestPlugin` in [packages/extension/vite.config.ts](packages/extension/vite.config.ts) only rewrote **top-level** import statements from `dist/src/content/index.js` into IIFE-namespaced aliases. Nested imports **inside** inlined chunks (e.g. a `styles-*.js` chunk whose body itself did `import{A as p}from"./adaptation-*.js"`) were never stripped or rewritten. Pre-Session-10 the module graph was shallow enough that rollup only produced top-level imports, so the bug was latent. Session 10's new `@accessbridge/core` imports (VisionRecoveryEngine, DEFAULT_VISION_CONFIG, etc.) expanded the graph → rollup split core across multiple chunks → inter-chunk imports appeared inside inlined bodies → IIFE wrap produced illegal `import` inside a function body. |
| **Fix** | Rewrote the plugin to: (1) recursively `loadChunk()` every transitively-imported chunk, recording its body + exports + deps; (2) topologically DFS-post-order the chunks so deps always come before dependents; (3) emit each as `var __ab_chunkN=(function(){aliasLines;body;return{exports}})();` where `aliasLines` bind this chunk's nested-import bindings to the already-declared `__ab_chunkM.exportName` of each dependency; (4) continue to bind top-level content-script imports as before. Post-fix `node -c` passes both `dist/src/content/index.js` and `dist/src/background/index.js`. |
| **Files Changed** | `packages/extension/vite.config.ts` — plugin rewritten from a 2-pass linear inliner into a recursive topo-sort + chunk-scoped namespace emitter. |
| **Commit** | (pending — Session 10 combined commit) |
| **Prevention** | The latent class of bug is: **any post-build transform that processes only `depth==1` imports will break as soon as the module graph deepens**. (a) `node -c` on the built content + background bundles MUST stay in the deploy pipeline (already is, per Session 8's BUG-008 prevention). (b) If future plugin work re-introduces a depth-limited pass, a regression test must build a fixture with a 2-deep chunk chain (module A imports B imports C, content imports A) and assert `node -c` passes. (c) Whenever a new `@accessbridge/*` workspace dep is added to the content script, rebuild immediately and `node -c` before merging — the graph shape is the trigger, not the new code's contents. |

---

## BUG-013: FusionEngine `_recentIngestTimes` grows unbounded until `getStats()` is called

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-21 |
| **Severity** | Medium (memory leak, not a correctness bug) |
| **Symptom** | Found by the Session 11 Opus-solo adversarial pass (codex:rescue was unavailable — quota exhausted). The `FusionEngine._recentIngestTimes` array was appended-to on every `ingest()` but only pruned inside `getStats()`. On tabs where the popup / sidepanel Intelligence tab is never opened, `getStats()` is never called, so the array grew without bound at content-script mousemove rates (~20 events/s × hours = 72k entries/hour). No visible symptom in short-lived testing; caught by adversarial audit before the feature shipped. |
| **Root Cause** | Design oversight: eventsPerSec was computed from the ring inside `getStats()` so pruning lived there too. The ingest path had no reason to touch it, but ingest is the only path that APPENDS to it — so in long-running sessions without observers it became a one-way-grow buffer. |
| **Fix** | `packages/core/src/fusion/fusion-engine.ts:84-91` — added an inline tail-prune in `ingest()`: `const ingestCutoff = now - 1000; if (this._recentIngestTimes.length > 0 && this._recentIngestTimes[0]! < ingestCutoff) { this._recentIngestTimes = this._recentIngestTimes.filter((t) => t >= ingestCutoff); }` — the bounded window is now enforced on the write path, not the read path. All 114 fusion tests still pass (the invariant exercised by `eventsPerSec updates correctly` was unchanged). |
| **Files Changed** | `packages/core/src/fusion/fusion-engine.ts` |
| **Commit** | (pending — combined Session 11 commit) |
| **Prevention** | **Any time a member buffer is appended-to on one code path and pruned on another, treat it as a leak candidate.** A useful invariant for sliding-window data structures: pruning belongs on the write path; reads must be idempotent queries over an already-bounded state. Adversarial-pass checklist for future sessions adds a grep: `find appends (`push`/`unshift`) → confirm every appending path also enforces the bound`. Also: when `codex:rescue` is blocked, Opus MUST still perform the adversarial questions; this bug would not have been caught by happy-path testing alone. |

---

## BUG-016: axe-core WCAG criterion regex silently mis-parsed every 2-digit success criterion (1.4.10, 1.4.11, 2.5.5, …)

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-21 |
| **Severity** | High (silent user-visible data corruption; caught pre-production by Session 18 Opus-solo adversarial pass) |
| **Symptom** | `extractWcagCriterion(['wcag1410'])` returned `'1.41.0'` instead of `'1.4.10'`. Same miscoding for every WCAG 2.1 AA criterion with a 2-digit success-criterion number: 1.4.11, 1.4.12, 1.4.13, 2.5.5, 2.5.6, 3.2.3, 3.2.4 — axe-core emits `wcagNMM` where N = principle (1-4), M = guideline (1-4), MM = criterion (1-13). Wrong criterion would appear on every source:`axe` finding for these violations; the per-criterion `wcagCompliance` counters would also miscategorize. |
| **Root Cause** | The initial regex `/^wcag(\d)(\d+)(\d+)$/i` was greedy-ambiguous. On input `wcag1410`, the first `(\d+)` greedily tried `410`, backtracked to `41` to let the trailing `(\d+)$` match `0`, and reported `1.41.0`. WCAG guarantees principle and guideline are always single digits (4 principles × ≤5 guidelines each), so only the criterion component can be 2 digits. The fix is structural: `(\d)(\d)(\d+)` forces single-digit groups 1+2, variable-digit group 3. |
| **Fix** | [packages/core/src/audit/axe-integration.ts](packages/core/src/audit/axe-integration.ts) — regex changed to `/^wcag(\d)(\d)(\d+)$/i`. Comment added explaining the WCAG dimensional invariant + the exact greedy-backtrack failure mode. Same commit widened `extractWcagCriterion` / `extractWcagLevel` parameter types `string[] | undefined` → `unknown` with `Array.isArray` + per-element `typeof === 'string'` gates — prevents throws on malformed input (matches BUG-015 defensive style). Five new regression tests in [packages/core/src/audit/__tests__/axe-integration.test.ts](packages/core/src/audit/__tests__/axe-integration.test.ts): `wcag1410→1.4.10`, `wcag1411`, `wcag1413`, `wcag255`, `wcag324`. Four new proto-pollution-guard tests: non-array tags, string tags, null, non-string elements inside an array. |
| **Files Changed** | `packages/core/src/audit/axe-integration.ts`, `packages/core/src/audit/__tests__/axe-integration.test.ts` |
| **Commit** | (pending — Session 18 combined commit) |
| **Prevention** | **Any regex designed to parse fixed-width structured data MUST explicitly encode the width constraint — never rely on greedy/non-greedy quantifiers to guess widths correctly.** Anti-pattern: `(\d+)(\d+)` when both groups are numeric and one has a known width. Correct pattern: `(\d{K})(\d+)` for a K-wide prefix. Adversarial-pass checklist for future string-parsing work: unit-test with the MINIMUM number of digits that could confuse the greedy engine — for this class, always test a 4-digit suffix against any `wcag\d{4}` pattern. Second lesson: **Opus-solo adversarial pass IS non-skippable when codex:rescue is unavailable.** `feedback_rescue_fallback` memory exists for this reason. If Session 18 had skipped this pass (as a "no time, CI will catch it" shortcut), the bug would have shipped — CI tests didn't previously exist for `wcag1410` and happy-path unit tests covered only `wcag111` + `wcag143`. |

---

## BUG-015: IndicWhisper language gate used `in` operator — inherited keys like `toString` bypass the 22-language allowlist

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-21 |
| **Severity** | Low (caught pre-production; Session 17 adversarial pass) |
| **Symptom** | `IndicWhisper.isSupported('toString')` returned `true`. `isSupported('hasOwnProperty')`, `'__proto__'`, `'constructor'` all also returned `true`. The `INDIC_WHISPER_TRANSCRIBE` background handler used the same `in` operator to gate payload.language — so an attacker-controlled content-script sending `{language: 'toString'}` would pass both gates, reach `indicWhisper.transcribe()`, and then the Session-18 decoder would deref `BCP47_TO_WHISPER['toString']` which is a function, not a language code → decoder crash / potentially malformed inference path. Caught BEFORE any decoder code exists, so never reached production. |
| **Root Cause** | `BCP47_TO_WHISPER` is created with `Object.freeze({...})`. Its prototype is still `Object.prototype`, so the `in` operator ("is this key reachable via the prototype chain?") returns `true` for inherited keys. The gate intended to check "is this a real BCP-47 entry?" but was testing the wrong property. |
| **Fix** | [packages/onnx-runtime/src/models/indic-whisper.ts:125-138](packages/onnx-runtime/src/models/indic-whisper.ts#L125-L138) — `isSupported()` now uses `Object.prototype.hasOwnProperty.call(BCP47_TO_WHISPER, language)`. Same fix in [packages/extension/src/background/index.ts](packages/extension/src/background/index.ts) `INDIC_WHISPER_TRANSCRIBE` handler's language check. New vitest case `returns false for Object.prototype keys (proto-pollution guard)` in [packages/onnx-runtime/src/__tests__/indic-whisper.test.ts](packages/onnx-runtime/src/__tests__/indic-whisper.test.ts) covers `'toString'`, `'hasOwnProperty'`, `'__proto__'`, `'constructor'`. |
| **Files Changed** | `packages/onnx-runtime/src/models/indic-whisper.ts`, `packages/extension/src/background/index.ts`, `packages/onnx-runtime/src/__tests__/indic-whisper.test.ts` |
| **Commit** | (pending — Session 17 combined commit) |
| **Prevention** | **Any `in` check against a static lookup object backed by a plain `{}` literal is a bug.** Canonical alternatives: (a) `Object.prototype.hasOwnProperty.call(obj, key)` — most portable; (b) `Object.hasOwn(obj, key)` — cleaner (ES2022+); (c) replace the literal with a `Map` and use `map.has(key)` which ignores the prototype chain by construction. Same class of bug would arise for any future 22-language / N-language allowlist — add a repo-wide grep as part of adversarial review: `in BCP47_TO_WHISPER`, `in SUPPORTED_LANGUAGES`, `in FEATURE_FLAGS`, etc. — if the target is an object literal, flag the check. |

---

## BUG-014: Ring-signature keyImage domain included ringHash → mid-day ring rotation enabled double-publish

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-21 |
| **Severity** | Medium (counter inflation, bounded by DP noise; not catastrophic) |
| **Symptom** | A client device enrolled in the observatory could publish twice on the same date by signing one attestation against the pre-rotation ring snapshot (ring v1) and another against the post-rotation ring (ring v2) when a new enrollment landed mid-day. Both signatures verify; both keyImages differ (because `H_p(date, ringHash_v1) ≠ H_p(date, ringHash_v2)`); the server's UNIQUE(date, key_image) constraint therefore doesn't fire; `aggregated_daily` inflates by 2×. Caught by the Session-16 Opus-solo adversarial pass before deploy — NOT hit in production. |
| **Root Cause** | Session 16's first-draft `attestationKeyImageDomain(date, ringHash)` used `"accessbridge-obs-v1:" + date + ":" + ringHash`. The intent was per-(device, date, ring) linkability, but that accidentally relaxes per-device-per-day uniqueness: same secret key + two distinct ringHash values → two distinct keyImages → two distinct DB rows. |
| **Fix** | Changed the keyImage domain to `"accessbridge-obs-v1:" + date` (date only). The `ringHash` parameter is retained in the signature for source-compat but ignored. The attestation's *message bytes* still include `ringHash` + `ringVersion`, so the signature continues to bind the ring identity; only the keyImage derivation was decoupled. Applied in three places for byte-identical behavior: [packages/core/src/crypto/ring-signature/commitment.ts](packages/core/src/crypto/ring-signature/commitment.ts), [ops/observatory/crypto-verify.js](ops/observatory/crypto-verify.js), [ops/observatory/public/verifier.js](ops/observatory/public/verifier.js). One vitest case (`domain encodes both date and ringHash`) was inverted to codify the safer behavior (`domain is scoped by date only`). 52 TS + 11 Node cross-check tests re-ran green. |
| **Files Changed** | `packages/core/src/crypto/ring-signature/commitment.ts`, `packages/core/src/crypto/ring-signature/__tests__/commitment-verifier.test.ts`, `ops/observatory/crypto-verify.js`, `ops/observatory/public/verifier.js` |
| **Commit** | (pending — Session 16 combined commit) |
| **Prevention** | When designing a domain-separation scheme for a linkable identifier (ring-sig keyImages, HIBE tags, VRF outputs): the domain must fix EVERY dimension the "same-event" check wants to collapse. If the server uses `UNIQUE(X, tag)` to prevent duplicates, then `tag` MUST depend ONLY on quantities in `X` plus the device secret — NOT on anything the client can vary. Adversarial review checklist: for every `UNIQUE(...)` SQL constraint downstream of a client-chosen cryptographic value, trace the derivation of that value and confirm no client-controlled field alters it. Also: inversions of "what should be the same" tests are a red flag during review — a test that expects *different* output from the same secret key with only a public-parameter change is often encoding a bug as an invariant. |

---

## BUG-017: `write_key_to_file` chmod-after-write race — 32-byte DB/PSK key briefly world-readable on multi-user Unix

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-21 |
| **Severity** | Medium (caught pre-production by Session 21 Opus-solo adversarial pass; codex:rescue quota-exhausted until 2026-04-26) |
| **Symptom** | When the OS keyring was unavailable and `get_or_create_db_key_with_store` fell back to the file-based key store, `write_key_to_file` called `std::fs::write(path, encoded)` first and THEN ran `std::fs::set_permissions(path, 0o600)` in a `#[cfg(unix)]` block. Between those two syscalls the file existed with the process's umask permissions — typically `0o644` on macOS and most Linux dev boxes. On a multi-user host (shared dev server, macOS account shared by admin + user) a co-resident user could `cat ~/Library/Application\ Support/AccessBridge/db.key` during that microsecond window and read the base64-encoded 32-byte SQLCipher master key. With the key, the user's `profile.db` becomes decryptable. Same class applies to the `pair-psk` file via `load_or_create_psk_via_keyring`. |
| **Root Cause** | Classic POSIX chmod-after-open race. `std::fs::write` opens with mode-from-umask; `std::fs::set_permissions` subsequently narrows it. No exploit was possible in single-user-account scenarios (only one user can reach the file anyway), but the code shipped without the defense-in-depth mode-on-create step that the Unix standard library supports via `std::os::unix::fs::OpenOptionsExt::mode(0o600)`. |
| **Fix** | `packages/desktop-agent/src-tauri/src/crypto.rs` `write_key_to_file` — rewritten so that on Unix the file is opened via `OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)` BEFORE any bytes are written. The file therefore never exists at any other mode. A follow-up `set_permissions(0o600)` still runs to cover the case where the file pre-existed with broader permissions (OpenOptionsExt::mode only applies on file creation, not on truncate-open of an existing file). Windows uses `std::fs::write` unchanged since NTFS inherits the per-user ACL from the parent `%LOCALAPPDATA%\AccessBridge\` directory. |
| **Files Changed** | `packages/desktop-agent/src-tauri/src/crypto.rs` |
| **Commit** | (pending — Session 21 combined commit) |
| **Prevention** | **Any time a sensitive file is written on Unix, the 0o600 perm bit MUST be set at creation time via `OpenOptionsExt::mode`, not after-the-fact via `set_permissions`.** The `std::fs::write` convenience function is NEVER safe for secret material on multi-user hosts. Adversarial-pass checklist for future Rust work: grep for `fs::write\|fs::OpenOptions::.*write\|fs::File::create` where the target path holds a secret (`.key`, `.psk`, `secret.*`, `token.*`); confirm the open uses `.mode(0o600)` at creation. Also: when `codex:rescue` is quota-exhausted (it hit daily usage limit on 2026-04-21, recovers 2026-04-26), the `feedback_rescue_fallback` memory mandates an immediate Opus-solo adversarial pass; skipping it because "codex is unavailable" would have shipped this bug. The pass also re-verified no PRAGMA-key SQL leak, no AppleScript injection on the hardcoded Settings URL, no CFRelease/CFRetain imbalance in the macOS AX revert path, and no unbounded-HashMap DoS beyond the single-PSK-authenticated client. |

---

## BUG-018: kdeglobals symlink attack surface — agent would truncate symlinked targets on KDE font-scale apply/revert

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-21 |
| **Severity** | Medium (caught pre-production by Session 22 Opus-solo adversarial pass after the `codex:codex-rescue` subagent returned an abrupt "forwarded" summary without findings; `feedback_rescue_fallback` memory mandated the Opus-solo pass) |
| **Symptom** | On KDE Plasma, `apply_font_scale_kde` and its revert counterpart `kde_set_font_size` both called `std::fs::read_to_string(~/.config/kdeglobals)` followed by `std::fs::write(...)` with the updated content. Both APIs **follow symlinks**. A malicious process running as the same user (via e.g. a compromised KDE extension or a prior partial compromise) could replace `~/.config/kdeglobals` with a symlink to `/etc/passwd` (or any file the user has write access to). The agent would then read the target through the symlink, edit the font-size line (which on an arbitrary target produces garbage), and **truncate + overwrite** the target file with the modified content. No information leak (the agent doesn't transmit file contents off-host), but destructive data-loss of the pointed-at file. Matches the defense-in-depth spirit of BUG-017. |
| **Root Cause** | `std::fs::read_to_string` and `std::fs::write` both resolve and follow symlinks by design on Unix. Neither `apply_font_scale_kde` nor `kde_set_font_size` pre-checked with `symlink_metadata()` (which does NOT follow) to assert the target was a regular file owned by the current user. The KDE dispatch path was introduced in Session 22 Wave 1 and shipped through Phase 3 Opus review without this specific defense; the adversarial pass caught it by pattern-matching against the BUG-017 recipe. |
| **Fix** | `packages/desktop-agent/src-tauri/src/platform/linux.rs` — new helper `refuse_if_symlink(path: &Path) -> AdapterResult<()>` which calls `path.symlink_metadata()` (does not follow) and returns `AdapterError::PlatformError("refusing to read/write <path>: target is a symlink (potential symlink attack)")` if the target is a symlink. Called at the top of both `apply_font_scale_kde` (before the read) and `kde_set_font_size` (before the read). Four new tests in the `#[cfg(test)] mod tests` block cover the helper's behaviour on: (a) non-existent path → `Ok`, (b) regular file → `Ok`, (c) Unix symlink → `Err` with "symlink" in the message, plus a garbage-input sanity test for `parse_kde_font_size`. |
| **Files Changed** | `packages/desktop-agent/src-tauri/src/platform/linux.rs` |
| **Commit** | (pending — Session 22 combined commit) |
| **Prevention** | **Any time an accessibility adapter or other helper writes to a user-owned config file whose path is conventional (`~/.config/*`, `~/.local/share/*`, `~/Library/*`), pre-check with `symlink_metadata()` before I/O and refuse if the target is a symlink.** Adversarial-pass checklist for future Rust file-I/O work: grep for `fs::read_to_string` / `fs::write` / `fs::File::create` where the target path is under `~/.config`, `~/.local`, or an XDG-resolved path; confirm either (i) a `refuse_if_symlink`-style pre-check runs first, or (ii) the open uses `O_NOFOLLOW` via `OpenOptionsExt`. Also: when `codex:rescue` returns an empty / incomplete summary (as happened this session — 64s duration, 23k tokens, no findings body), trigger the Opus-solo adversarial pass IMMEDIATELY per `feedback_rescue_fallback` memory; do not push with an unreviewed security-adjacent surface. |

---

## BUG-019: `ipc_server::load_or_create_pair_key` umask-chmod race — BUG-017 regression in a sibling function

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-21 |
| **Severity** | Medium (caught pre-production by Session 22 Opus-solo adversarial pass; exposure is real on multi-user Linux hosts when `$XDG_RUNTIME_DIR` is unset) |
| **Symptom** | `ipc_server::load_or_create_pair_key` used the exact pattern that BUG-017 filed against `crypto::write_key_to_file`: `std::fs::write(&path, file.to_json()?)?` (creates the file at `0o666 & !umask`, typically `0o644`) followed by `set_permissions(0o600)` under `#[cfg(unix)]` to narrow it. BUG-017's fix was applied ONLY to `write_key_to_file` (via `OpenOptions::new().mode(0o600).open(...)`); the sibling function `load_or_create_pair_key`, which writes the agent ↔ extension PSK, was not migrated. On Session 22's Linux push this PSK file moved to `$XDG_RUNTIME_DIR/accessbridge/pair.key` — `XDG_RUNTIME_DIR` is typically a tmpfs at `0o700` owner-only, so the race window is not exploitable there. But when `$XDG_RUNTIME_DIR` is unset (minimal distros, some headless configurations, some container runtimes), `xdg_paths::psk_path()` falls back to `~/.cache/accessbridge/pair.key` — and `~/.cache` on most distros is `0o755` (world-traversable). During the microsecond between `std::fs::write` and `set_permissions(0o600)`, any co-resident user on a shared host could `cat` the PSK file and read the base64-encoded 32 random bytes that authenticate the extension ↔ agent handshake. With the PSK in hand, an attacker-process on the same host could impersonate the extension to the agent over the loopback socket. |
| **Root Cause** | When BUG-017 was fixed in Session 21, the maintainer (Opus-solo pass + in-session Sonnet dispatch) applied the `OpenOptionsExt::mode(0o600)` correction to `crypto::write_key_to_file` only, because that was the specific call-site flagged by the adversarial pass. The prevention-rule authored in the RCA entry reads: "Any time a sensitive file is written on Unix, the 0o600 perm bit MUST be set at creation time via `OpenOptionsExt::mode`". That rule WAS documented, but the sibling function `ipc_server::load_or_create_pair_key` was not audited for the same pattern. Session 22's XDG refactor moved the PSK path into a fallback chain where the race window materially matters, elevating what would have been a low-severity defense-in-depth issue into a real multi-user exposure. |
| **Fix** | `packages/desktop-agent/src-tauri/src/ipc_server.rs` — extracted a `write_pair_key_at(path, key_json)` helper using the same `#[cfg(unix)]` pattern as `crypto::write_key_to_file`: `std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)` then `write_all(json.as_bytes())`, followed by a belt-and-braces `set_permissions(0o600)` in case the file pre-existed with broader perms (OpenOptionsExt::mode only applies on file creation, not on truncate-open of an existing file). `load_or_create_pair_key` now calls this helper instead of the raw `fs::write` + `set_permissions` sequence. One new Unix-only test asserts `file.metadata().permissions().mode() & 0o777 == 0o600` after a fresh write through the helper. |
| **Files Changed** | `packages/desktop-agent/src-tauri/src/ipc_server.rs` |
| **Commit** | (pending — Session 22 combined commit) |
| **Prevention** | **When fixing a class-of-bug defect like BUG-017, grep the ENTIRE codebase for the same anti-pattern at the time of the fix, not just the specific call-site that was flagged.** Concrete pattern: `fs::write\|fs::OpenOptions::.*write\|fs::File::create` where the target path holds a secret (`.key`, `.psk`, `secret.*`, `token.*`, `pair.key`) — if ANY such call-site doesn't use `.mode(0o600)` at creation, flag it. The Session-21 BUG-017 entry's "Prevention" field already documented this rule but didn't trigger a repo-wide sweep at the time. Session 22's pre-push adversarial checklist added an explicit item "grep for fs::write of `.key`/`.psk`/`pair.key` targets and verify creation-time mode" which caught this. Also: when an XDG refactor changes the file-system path of a sensitive artifact (PSK, master key, credential), re-audit the mode-on-creation invariant for the NEW path's permission environment — `~/.config` and `~/.cache` and `/tmp` and `$XDG_RUNTIME_DIR` all have different default directory modes and different multi-user exposure profiles. |

---

## BUG-020: `deploy.sh` never syncs observatory source — any Node-side endpoint change silently stays dev-local until manual scp + container restart

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-22 |
| **Severity** | High (caught post-deploy during Session 25 smoke test; the Session 25 pilot orchestrator shipped to git but did NOT land on the VPS for ~2 minutes until the operator ran manual scp) |
| **Symptom** | Session 25 deploy pipeline reported clean end-to-end at v0.25.0: typecheck + build + test green, zip re-packaged, `accessbridge-api restarted`, `/api/version` health check → 0.25.0. But a post-deploy probe of `/observatory/api/pilot/1/status` returned **HTTP 404** — the new `/api/pilot/*` endpoints were NOT live. Root cause: `deploy.sh` only syncs `scripts/vps/main.py` (FastAPI) via `scp_main_py` + `docker restart accessbridge-api`. The **observatory** container (`accessbridge-observatory`, port 8200, bind-mount `/opt/accessbridge/observatory:/app`) is a separate container with a separate source tree at `ops/observatory/` that the deploy script has no code path for. Any server.js / enterprise-endpoint.js / public/pilot.\* change stays dev-local. The landing page rsync (`rsync -az --delete deploy/ $REMOTE:$WWW_DIR/`) also doesn't touch `ops/observatory/`. A historical artifact of this gap: `enterprise-endpoint.js` (added Session 20) was also never deployed — my container-restart attempt surfaced the latent MODULE_NOT_FOUND because the old pre-Session-20 server.js was running without the require on line 891. |
| **Root Cause** | `deploy.sh` was authored Session-by-Session for each new deliverable (Session 19 `--with-agent`, Session 20 `--with-enterprise`, Session 21 `--with-agent-all-platforms`, Session 22 `--with-agent-linux`) — each shipped its own build step + rsync target. Nobody authored a `--with-observatory` step when Session 16 introduced the observatory container, so every subsequent observatory change has been either (a) quietly not deployed, (b) manually scp'd by whoever noticed, or (c) discovered broken at the next restart. This is the same class of silent-deploy-gap pattern as BUG-011 (auto-bump didn't re-zip), BUG-003 (version mismatch between API + manifest), BUG-006 (version hardcoded in multiple places). |
| **Fix** | Manual recovery this session: `scp ops/observatory/server.js ops/observatory/enterprise-endpoint.js ops/observatory/public/pilot.{html,js,css} a11yos-vps:/opt/accessbridge/observatory/` then `ssh a11yos-vps docker restart accessbridge-observatory`. Confirmed all 7 `/api/pilot/*` endpoints live + dashboard `/observatory/pilot.html` serves HTTP 200. The permanent fix (deploy.sh step `[3.5/6] Sync observatory source if changed`) is open for a future session — should rsync `ops/observatory/{server.js,crypto-verify.js,enterprise-endpoint.js,public/,__tests__/}` to `$REMOTE:/opt/accessbridge/observatory/` when any of those files have changed since the last tag, then `docker restart accessbridge-observatory` on the VPS. Gate it behind a hash check so non-observatory sessions skip the restart (container restart costs ~5s of dashboard downtime). |
| **Files Changed** | None this session — code fix deferred. VPS artifacts re-uploaded manually. |
| **Commit** | Recovery documented in Session 25 HANDOFF; `deploy.sh` patch is open for the next session. |
| **Prevention** | (a) Until `deploy.sh` is patched: after any change under `ops/observatory/`, manually run `scp ops/observatory/server.js a11yos-vps:/opt/accessbridge/observatory/ && ssh a11yos-vps docker restart accessbridge-observatory` + re-probe `/observatory/api/health`. (b) Add a post-deploy smoke test to the health-check step that probes at least one known observatory endpoint (`/observatory/api/health` or `/observatory/api/summary`) — a 5xx or MODULE_NOT_FOUND here flags the gap before the operator leaves the terminal. (c) The general rule for future container-per-session splits: every new container MUST have a corresponding `deploy.sh` step wired in the same commit that introduces it; if the container has source-code volumes, `rsync` + `docker restart` must be part of the deploy pipeline, not a separate hand-run command. Pattern parallel: Session 20 `--with-enterprise` ships `deploy/enterprise/*` via the landing-page rsync because the target is static HTML; Session 25 should have done the same for `ops/observatory/` but didn't because the observatory isn't a simple static-file case (volume-mount Node server). |

---

## BUG-021: Observatory attestation + model-CDN endpoints transmitted over plaintext HTTP — ring-sig anonymity partially defeatable by network observer

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-22 |
| **Severity** | High (caught in Session 26 security audit by Sonnet extension-TS adversarial pass; no known exploitation in production) |
| **Symptom** | `packages/extension/src/background/observatory-publisher.ts:19-26` defined `OBSERVATORY_ENDPOINT`, `OBSERVATORY_ENROLL_ENDPOINT`, `OBSERVATORY_RING_ENDPOINT` as plain `http://72.61.227.64:8300/observatory/api/*`. Each daily publish transmits a Ristretto255 public key, the ring of all enrolled device public keys (on first fetch), the ring-signed attestation bundle (including `org_hash`, `pilot_id`, `merkle_root`, Laplace-noised counters). A network observer (on-path LAN, corporate proxy, compromised coffee-shop Wi-Fi, rogue ISP) can passively record the ring for a given enterprise tenant, then correlate publish timing across devices + source IPs → partial deanonymization of the ring signature despite its cryptographic anonymity guarantee. Also affected: `packages/onnx-runtime/src/model-registry.ts:17` hardcoded `VPS_MODEL_BASE = 'http://72.61.227.64:8300/models'`, so model-download integrity relies only on SHA-256 (good) but transport is plaintext (bad — passive model-registry observer learns which user downloaded which Tier 1/2/3 model, a weaker but real fingerprinting signal). Also: `sidepanel/index.tsx:1493,1500` + `popup/App.tsx:1326,1548` constructed bare-IP HTTP URLs for clipboard + `<a href>` (verifier-link copy, observatory dashboard link). |
| **Root Cause** | Session 16 (ring signatures) and Session 10 (observatory) pre-dated the Caddy/Cloudflare edge being fully trusted; the bare-IP HTTP was a development-era stopgap that was never bumped to the HTTPS Caddy-fronted hostname. BUG-002 (Session 6) established the pattern of going through `https://accessbridge.space` via nginx for update-check, but that pattern was not extended to Observatory when it shipped. The prevention rule from BUG-002 ("All external URLs from extension must go through nginx proxy (port 8300). Never reference internal Docker ports (8100, 8200) in client code") was partially observed — port 8300 was used — but the **HTTPS leg** of the rule was dropped. |
| **Fix** | Swapped 3 observatory endpoint constants + `VPS_MODEL_BASE` + 4 UI sites to `https://accessbridge.space/observatory/api/*` and `https://accessbridge.space/models`. Added regression tests in `observatory-publisher.test.ts` (asserts every endpoint starts `https://accessbridge.space/`) and `model-registry.test.ts` (asserts every URL matches `/^https:\/\/accessbridge\.space\/models\//` and never bare-IP). Curl-verified that the new endpoints resolve 200 with CF-Ray headers (Cloudflare-proxied). |
| **Files Changed** | `packages/extension/src/background/observatory-publisher.ts`, `packages/extension/src/popup/App.tsx`, `packages/extension/src/sidepanel/index.tsx`, `packages/onnx-runtime/src/model-registry.ts`, `packages/extension/src/background/__tests__/observatory-publisher.test.ts`, `packages/onnx-runtime/src/__tests__/model-registry.test.ts`. |
| **Commit** | (pending — Session 26 combined commit) |
| **Prevention** | **Rule (BUG-002 update):** every client-side URL constant MUST use `https://accessbridge.space/...`. No `http://` to any host. No bare IP. Add a CI grep job: fail on any `http://[0-9.]+` or `http://72\.` pattern in `packages/*/src/**/*.ts`. Note: `ops/observatory/*` server-internal references are NOT subject to this rule (they're intra-Docker). Dev-ops tooling (tools/validate-models.sh, tools/aggregate-curated-labels.ts) gets a longer deprecation grace period but is tracked as deferred cleanup. |

---

## BUG-022: Background `chrome.runtime.onMessage` handler accepted privileged mutations from content scripts — any on-page XSS could steal AI API keys, force-disable a11y features, rotate observatory keys

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-22 |
| **Severity** | High (caught in Session 26 security audit; no known exploitation — requires a page XSS that compromises our content-script isolated world) |
| **Symptom** | `packages/extension/src/background/index.ts:551` (main `chrome.runtime.onMessage.addListener`) dispatched every message type to `handleMessage(message, sender)` with no gate on `sender.id` or `sender.tab`. In MV3, content scripts share the extension ID — `sender.id === chrome.runtime.id` holds for messages from both our popup/sidepanel AND our own content script. The distinguisher is `sender.tab`: defined for content-script messages, undefined for popup/sidepanel. An XSS on any page the extension is active on (i.e. `<all_urls>`) could compromise the content-script context and call `chrome.runtime.sendMessage({type:'AI_SET_KEY', payload:{provider:'claude', apiKey:'attacker-key'}})` → the user's subsequent AI requests route to the attacker's key (metered + logged). Similar exposure for `SAVE_PROFILE` (force-disable all a11y features), `VISION_CURATION_SAVE` (arbitrary IndexedDB writes, though sanitization mitigates), `AGENT_SET_PSK` (hijack desktop-agent pairing), `OBSERVATORY_ENROLL` / `OBSERVATORY_ROTATE_KEY` (reset ring-signature identity), `CHECK_UPDATE` / `APPLY_UPDATE` (hijack auto-update). |
| **Root Cause** | The `chrome.runtime.onMessage` pattern was established early (Session 3) with a single handler routing by `type`. Per-handler auth was assumed sufficient because the Chrome extension ID is stable and `externally_connectable` is not declared. The missing assumption was that our own content script is an untrusted-by-transitive-XSS surface — a page XSS reaches the content-script isolated world via the DOM/prototype, then `chrome.runtime.sendMessage` works. This blind spot persisted through 12 sessions of feature additions; every new mutation message type inherited the zero-gate. |
| **Fix** | Added `UI_ONLY_MESSAGES` set of 23 privileged-mutation types (SAVE_PROFILE, AI_SET_KEY, AI_CLEAR_KEY, ONNX_LOAD_TIER, ONNX_UNLOAD_TIER, ONNX_CLEAR_CACHE, ONNX_SET_FORCE_FALLBACK, ONNX_RUN_BENCHMARK, AGENT_SET_PSK, AGENT_CLEAR_PSK, AGENT_PAIR_INITIATE, AGENT_APPLY_NATIVE, AGENT_REVERT_NATIVE, OBSERVATORY_ENROLL, OBSERVATORY_ROTATE_KEY, VISION_CURATION_SAVE, VISION_CURATION_DELETE, VISION_CURATION_CLEAR, VISION_CURATION_EXPORT, CHECK_UPDATE, APPLY_UPDATE, REVERT_ADAPTATION, REVERT_ALL) + `isUiOnlyMessage()` predicate. Gate inserted before `handleMessage` dispatch: `sender.tab !== undefined` → reject `{error:'unauthorized', reason:'content-script-forbidden'}`; `sender.id !== chrome.runtime.id` → reject `{error:'unauthorized', reason:'cross-extension'}`. Content-script-allowed messages (SIGNAL_BATCH, FUSION_INTENT_EMITTED, AI inference requests, TOGGLE_FEATURE, ACTION_ITEMS_UPDATE, etc.) pass through unchanged. **Adversarial revision:** Opus review caught that `gestures.ts` legitimately sends TOGGLE_FEATURE from content scripts and `action-items.ts` sends ACTION_ITEMS_UPDATE — these were initially UI-only, reclassified to content-allowed. Documented the defense-in-depth requirement (background must validate feature-name allowlist + items size caps). 49 regression tests in `sender-validation.test.ts`. |
| **Files Changed** | `packages/extension/src/background/index.ts`, `packages/extension/src/background/__tests__/sender-validation.test.ts` (new). |
| **Commit** | (pending — Session 26 combined commit) |
| **Prevention** | (a) Every new background message type handler MUST be explicitly classified UI-only / content-allowed / query-only, with an entry in the UI_ONLY_MESSAGES set when mutation-only. (b) When a message is content-allowed, the handler MUST validate every field against an allowlist or size cap — the gate is no substitute for input validation. (c) `externally_connectable` must NEVER be added to manifest.json without a per-origin allowlist — doing so would reopen the cross-extension probe surface that this fix relies on being absent. (d) A grep-based CI job should flag any new `case 'XYZ':` branch in the background dispatcher that doesn't have a corresponding UI_ONLY_MESSAGES entry OR a SECURITY comment justifying content-allowed status. |

---

## BUG-023: Third umask-chmod race — `crypto::load_or_create_psk_via_keyring` PSK file-fallback missed by BUG-017 + BUG-019 sweeps

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-22 |
| **Severity** | High (caught in Session 26 Rust adversarial audit; real multi-user-Linux exposure when `$XDG_RUNTIME_DIR` unset) |
| **Symptom** | `packages/desktop-agent/src-tauri/src/crypto.rs:493` used `let _ = std::fs::write(&file_path, json);` inside `load_or_create_psk_via_keyring`'s fallback-write branch. This is the third occurrence of the BUG-017 pattern — `write_key_to_file` was fixed in BUG-017 (Session 21) and `ipc_server::load_or_create_pair_key` was fixed in BUG-019 (Session 22), but this third site inside the same file as BUG-017's fix was overlooked in both audits. On Unix, `fs::write` creates the file at `0o644` (umask default) for a microsecond before any permission narrowing; this site has NO follow-up `set_permissions(0o600)` at all — the `let _ = ...` discards the error and the file stays readable. On multi-user Linux hosts where `$XDG_RUNTIME_DIR` is unset, the fallback path resolves to `~/.cache/accessbridge/pair.key` (world-traversable `0o755`), so a co-resident user can `cat` the PSK. With the PSK, the attacker impersonates the extension to the agent over the loopback socket + compromises the entire IPC channel. |
| **Root Cause** | BUG-019's prevention rule ("grep the ENTIRE codebase for the same anti-pattern at the time of the fix") was documented but not rigorously executed. Session 22's BUG-019 sweep located `ipc_server::load_or_create_pair_key` and fixed it, but missed the **same file** — `crypto.rs` line 493 — because the sweep used a regex that matched `write` calls outside of `load_or_create_*` functions and this fallback branch is buried inside an `if let Some(parent) = ...` + `if let Ok(json) = ...` nested-match pattern. Grep-matched lines per session: BUG-017 found 1, BUG-019 found 1 (sibling file), BUG-023 should have been found by either sweep — it's in the same `crypto.rs` file as BUG-017's fix. |
| **Fix** | Extracted `write_secret_file_at(path: &Path, bytes: &[u8]) -> std::io::Result<()>` helper mirroring the BUG-017/019 pattern: `OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)` at file creation on Unix, then `write_all` + belt-and-braces `set_permissions(0o600)` for pre-existing-file case. Replaced the `fs::write` call with `write_secret_file_at(&file_path, json.as_bytes())` and surfaced errors via `tracing::warn!("failed to persist PSK file: {err}")` (was silently discarded). New Unix-only regression test `load_or_create_psk_via_keyring_file_fallback_has_0o600` asserts `meta.permissions().mode() & 0o777 == 0o600`. |
| **Files Changed** | `packages/desktop-agent/src-tauri/src/crypto.rs` |
| **Commit** | (pending — Session 26 combined commit) |
| **Prevention** | **Upgrade the BUG-019 rule.** The prior rule was "grep the codebase"; the new rule is an explicit cross-file sweep recipe: whenever a new class-of-bug RCA entry is filed, **run this exact grep BEFORE declaring the fix complete** — `grep -rn "fs::write\\|fs::OpenOptions\\|fs::File::create" packages/*/src-tauri/src/ -- '!target'` then filter to every match whose target path name contains any of `key`, `psk`, `pair`, `token`, `secret`, `db`, `credential`, `cert`; every such match must either (a) use `OpenOptions::mode(0o600)` at creation, or (b) be on Windows-only path. Also: for ANY fix inside a file that has more than one `fs::write` call, re-read all of that file's `fs::write` sites, not just the one flagged — they often share a prevention gap. Commit this grep recipe into a `scripts/audit/fs-write-mode-scan.sh` in the next session. |

---

## BUG-024: Observatory rate limiters used `req.ip` without `trust proxy` — all requests bucketed as 127.0.0.1, rate limit defeated

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-22 |
| **Severity** | High (caught in Session 26 VPS audit; rate limit was always-bypassable since Session 10) |
| **Symptom** | `ops/observatory/server.js` shipped four rate-limit middlewares (`rateLimit`, `enrollRateLimit`, `pilotEnrollRateLimit`, `pilotFeedbackRateLimit`) whose bucket-key expression was `req.ip || req.headers['x-forwarded-for'] || 'unknown'`. But `app.set('trust proxy', ...)` was never called. Express's default `trust proxy: false` makes `req.ip` resolve to the immediate TCP peer — which is always nginx at 127.0.0.1 inside the Docker network — so every incoming request hit the same shared bucket. A single client could exhaust the 60 rpm per-IP window for all clients, but more importantly, NO client was actually rate-limited per their real IP. The rate limit was effectively a no-op since Session 10 (Observatory shipping). |
| **Root Cause** | Express's `trust proxy` setting was never configured when the Observatory was introduced; the 3-hop proxy chain (Cloudflare → ti-platform-caddy-1 → accessbridge-nginx → observatory container) was unknown to the app. The `|| req.headers['x-forwarded-for']` fallback was a red herring: it's a multi-value header that, with no trust proxy, Express already ignores (doesn't auto-parse), and the `||` fallback only triggered when `req.ip` itself was undefined (never, as long as the TCP connection existed). A secondary concern: on this shared Caddy edge, even with `trust proxy = 3`, an attacker who reaches the origin VPS port 8300 directly (Cloudflare bypass) can spoof `CF-Connecting-IP` to choose their bucket. |
| **Fix** | (a) Added `app.set('trust proxy', 3)` matching the known 3-hop chain. (b) Added `getClientIp(req)` helper that prefers `CF-Connecting-IP` when gated by a valid `CF-Ray` header shape (`/^[0-9a-f]+-[A-Z0-9]{3,5}$/i`) — CF sets both on every proxied request; attackers who forge only CF-Connecting-IP fail the CF-Ray check and fall through to `req.ip`. All four rate-limit middlewares + 7 error-log sites use `getClientIp`. (c) 7 regression tests in `ops/observatory/__tests__/rate-limit-ip-spoof.test.js` covering: per-IP bucketing, X-Forwarded-For no-reset-when-CF-present, CF-Connecting-IP-without-CF-Ray falls back, malformed CF-Ray falls back, valid CF-Ray shapes accepted, 100 rapid requests trip limiter after 60. **Adversarial revision:** initial fix trusted CF-Connecting-IP unconditionally; Opus review flagged CF-bypass spoof risk → added the CF-Ray shape gate. |
| **Files Changed** | `ops/observatory/server.js`, `ops/observatory/__tests__/rate-limit-ip-spoof.test.js` (new). |
| **Commit** | (pending — Session 26 combined commit) |
| **Prevention** | (a) Every new Express app in this repo MUST call `app.set('trust proxy', N)` with N = number of known hops BEFORE any middleware that reads `req.ip`. Document the proxy-chain depth in a top-of-file comment. (b) Never read `req.headers['x-forwarded-for']` directly — `req.ip` (with trust proxy set) is the only correct source. (c) When the app sits behind Cloudflare + shared Caddy, prefer `CF-Connecting-IP` gated by `CF-Ray` shape-check; the pair is CF-set and not forgeable from inside the CF chain. (d) Defense-in-depth against CF-bypass: firewall origin VPS port 8300 to Cloudflare IP ranges only — this is an ops item, not a code fix. (e) Regression tests MUST verify the IP spoofing cases: "X-Forwarded-For doesn't reset counter", "CF-Connecting-IP without CF-Ray doesn't trust", "malformed CF-Ray doesn't trust". |

---

## BUG-025: 17 open npm advisories in shipped extension — jsPDF path-traversal + HTML-injection (2 CRITICAL) + DOMPurify mutation-XSS + proto-pollution (5 MODERATE) + 8 HIGH DoS/injection findings

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-22 |
| **Severity** | Critical (2 GHSA-rated CRITICAL + 8 HIGH shipping in v0.24.0) |
| **Symptom** | `pnpm audit --prod` in Session 26 Phase 2 returned 17 advisories concentrated in two packages. Per-GHSA highlights: `jspdf@2.5.2` had (a) **CRITICAL** GHSA-f8cm-6447-x5h2 Local File Inclusion / Path Traversal when generating PDFs that include fonts or images from URI inputs, (b) **CRITICAL** GHSA-wfv2-pwc8-crg5 HTML Injection in "New Window" paths, (c) **HIGH** GHSA-pqxr-3g65-p328 Arbitrary JavaScript execution via AcroFormChoiceField, (d) HIGH GHSA-9vjf-qc39-jprp + GHSA-p5xg-68wr-hm3m + GHSA-7x6v-j9x4-qf24 additional PDF injection paths, (e) HIGH DoS via malicious BMP + GIF dimensions, (f) MODERATE stored XMP-metadata injection + addJS race. `dompurify@2.5.9` (pulled in transitively by `jspdf`) had 5 MODERATE XSS / proto-pollution advisories. These reach production in the extension's **audit PDF export** feature (A11Y-04) which generates reports from scanned page content — an attacker-controlled page can feed XSS/path-traversal-bait text into the audit, and when the user exports the PDF, the exploit fires. |
| **Root Cause** | `packages/extension/package.json` pinned `jspdf: ^2.5.2` (Session 18 addition for PDF export) and never tracked upstream security updates. DOMPurify was transitive — never directly version-controlled by us. No Dependabot was configured, so advisories piled up silently. Pre-Session-26 no `pnpm audit` gate existed in CI. |
| **Fix** | (a) Bumped `packages/extension/package.json` direct dep: `"jspdf": "^2.5.2"` → `"jspdf": "^4.2.1"` (latest major, covers all 10 jspdf GHSA advisories). (b) Added root `package.json` pnpm override: `"pnpm": {"overrides": {"dompurify": "^3.4.0"}}` (covers all 5 dompurify advisories). (c) `pnpm install` → lockfile updated, +7 packages, 0 breaking API changes. (d) Post-fix `pnpm audit --prod`: **0 advisories** (was 17). (e) 304/304 extension tests pass, including the PDF-export path that exercises jsPDF. (f) Added `.github/dependabot.yml` covering 9 ecosystems (7 npm workspaces + cargo + github-actions), weekly Monday runs with minor+patch grouped. (g) Added `.github/workflows/security.yml` (npm-audit + cargo-audit + secrets-scan + semgrep + unsafe-rust-detect + insecure-ts-patterns + pr-comment-summary) + `cve-watch.yml` nightly. |
| **Files Changed** | `packages/extension/package.json`, root `package.json`, `pnpm-lock.yaml`, `.github/dependabot.yml` (new), `.github/workflows/security.yml` (new), `.github/workflows/cve-watch.yml` (new). |
| **Commit** | (pending — Session 26 combined commit) |
| **Prevention** | (a) Dependabot weekly runs surface new advisories within 7 days — don't rely on manual `pnpm audit`. (b) `security.yml` PR gate fails on any `pnpm audit --audit-level moderate` hit, so a new advisory can't ship without explicit triage. (c) For transitive pkgs like `dompurify` that no workspace directly depends on, use `pnpm.overrides` in root `package.json` to pin safer versions. (d) Any future direct dep that extracts text or HTML from untrusted page content (PDF generators, sanitizers, templating engines) MUST have a Dependabot entry + quarterly manual audit. (e) The `cve-watch.yml` nightly opens a GitHub issue when NEW advisories land vs. the previous snapshot — this is the alerting layer so advisories don't pile silently again. |

---

## BUG-026: `tools/build-agent-installer.sh` looked for the MSI in the wrong target dir — first local Windows build of v0.21.0 exited "No MSI produced" even though `tauri build` had just succeeded

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-22 |
| **Severity** | Medium (publish blocker — MSI was built but not staged, so `deploy/downloads/agent-manifest.json` was never written and the landing-page CTA stayed at "build pending") |
| **Symptom** | Session 27 first attempt at `./deploy.sh --with-agent`: Tauri reports `Finished 1 bundle at: …\target\x86_64-pc-windows-msvc\release\bundle\msi\AccessBridge Desktop Agent_0.21.0_x64_en-US.msi`, then the script's `[4] Locating MSI output` step prints `✗ No MSI produced — review Tauri build output above` and exits 1. deploy.sh swallows the agent-build failure by design (`⚠ agent MSI build failed — deploy continues without updated MSI`) and ships the rest of the deploy, so the extension zip + landing page + API go out cleanly but the MSI never reaches `deploy/downloads/`. |
| **Root Cause** | The Windows branch of `tools/build-agent-installer.sh` hard-coded `MSI_SRC_DIR="$AGENT_DIR/src-tauri/target/release/bundle/msi"` but the script invokes `tauri build --target x86_64-pc-windows-msvc`. When cargo is given `--target <triple>`, it nests all outputs under `target/<triple>/release/...`, so the MSI actually lands at `target/x86_64-pc-windows-msvc/release/bundle/msi/`. The macOS branch already had the triple baked in (`target/universal-apple-darwin/release/bundle`) — the Windows branch was just missed when the script was generalized for multi-target in Session 21 Part 4. Never caught before because no local Windows build had been run end-to-end — Session 19 stopped at the Rust inline tests, Sessions 21/22 added macOS/Linux paths on different hosts, and CI runs on `windows-latest` where the same bug would hit but the Session-19 commit introducing the script predated the `--target` flag being passed (the flag was added later). |
| **Fix** | One-line change in [tools/build-agent-installer.sh:116-117](tools/build-agent-installer.sh#L116-L117): `MSI_SRC_DIR="$AGENT_DIR/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi"` with a short comment. Re-ran the script; cargo re-used the cached compile, MSI was located, copied as `accessbridge-desktop-agent_0.21.0_x86_64.msi`, sha256 computed, `agent-manifest.json` written. scp'd MSI + manifest to `a11yos-vps:/opt/accessbridge/docs/downloads/`; end-to-end sha256 verified (local == served). Landing-page CTA now reads "Download Desktop Agent (MSI)" with version + sha256. |
| **Files Changed** | `tools/build-agent-installer.sh` |
| **Commit** | (pending — Session 27 commit) |
| **Prevention** | (a) When a build script passes `--target <triple>` to cargo/tauri, the corresponding output-path lookup MUST include the triple directory. Kept the fix's one-line comment explicitly calling this out so the next target addition doesn't regress the invariant. (b) CI `agent-build.yml` should be wired to actually consume the script's output — currently the CI uploads artifacts via `actions/upload-artifact` which walks `deploy/downloads/accessbridge-desktop-agent_*` (the staged path), so a mis-staged MSI produces an empty upload + `if-no-files-found: error` CI failure. That guard exists, but the local-run path bypassed it because deploy.sh continues past an agent-build failure by design. Added to ROADMAP follow-ups: make `deploy.sh --with-agent` hard-fail (exit non-zero) if `agent-manifest.json` is absent after the build step, so a silent mis-stage can't ship a partial deploy. |

---

## BUG-027: MSYS/Git-Bash bundled perl lacks `IPC::Cmd` + `Params::Check` — first Windows Rust build fails in `openssl-sys` because SQLCipher's `bundled-sqlcipher-vendored-openssl` feature compiles OpenSSL from source via `perl Configure`

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-22 |
| **Severity** | Medium (Windows developer/build-agent environment blocker; does not affect already-shipped binaries) |
| **Symptom** | Session 27 first `./deploy.sh --with-agent` run: `cargo build` reached `Compiling openssl-sys v0.9.114` and then aborted: `perl ./Configure ... VC-WIN64A` failed with `Compilation failed in require at /usr/share/perl5/core_perl/IPC/Cmd.pm line 59. BEGIN failed—compilation aborted at /usr/share/perl5/core_perl/IPC/Cmd.pm line 59`. Every downstream crate that depends on `openssl-sys` (here, `libsqlite3-sys` with `bundled-sqlcipher-vendored-openssl`) cascaded to build-failure. Full cargo run ≈7 minutes wasted before the failure surfaced. |
| **Root Cause** | Git-Bash's MSYS-bundled perl at `/usr/bin/perl` (perl 5.38 `x86_64-msys-thread-multi`) ships a minimal core-modules set that **does not** include `IPC::Cmd` or `Params::Check`. Those modules are shipped with every "full" perl distribution (ActivePerl, Strawberry Perl), and OpenSSL's `Configure` script (which `openssl-src` crate invokes during build) unconditionally `use`s them. On any Rust-on-Windows project that (a) depends on `openssl-sys` with the `vendored` feature or (b) transitively pulls in `rusqlite` with `bundled-sqlcipher-vendored-openssl` (our case), the first `perl` on PATH is MSYS perl → build fails with the `IPC::Cmd` trace. Standard fix in the Windows-Rust ecosystem is Strawberry Perl; this project's `packages/desktop-agent/README.md` didn't call it out because prior Windows builds were Tauri 1.x without SQLCipher (no OpenSSL-from-source). Session 21 introduced `bundled-sqlcipher-vendored-openssl` and the prereq regression surfaced the first time a non-CI Windows host attempted a build. |
| **Fix** | Installed Strawberry Perl 5.42.2.1 via `winget install --silent --accept-source-agreements --accept-package-agreements --id StrawberryPerl.StrawberryPerl` (no admin required, user-scope install to `C:\Strawberry\`). Verified `perl -MIPC::Cmd -MParams::Check -e 'print "OK\n"'` succeeds. Re-ran the agent build with Strawberry on PATH: `PATH="/c/Strawberry/perl/bin:/c/Strawberry/c/bin:$PATH" OPENSSL_SRC_PERL="C:/Strawberry/perl/bin/perl.exe" bash tools/build-agent-installer.sh`. The `openssl-src` crate reads `OPENSSL_SRC_PERL` directly so that env var is the authoritative override; PATH is the belt-and-suspenders. `openssl-sys` compiled cleanly, full build finished in 12m 47s (SQLCipher + OpenSSL from source is ~80% of that). |
| **Files Changed** | (environment-only fix; no source changes). Follow-up doc work tracked — add a Strawberry Perl line to `packages/desktop-agent/README.md` developer-prereqs list; add the `PATH=` / `OPENSSL_SRC_PERL=` one-liner to `tools/build-agent-installer.sh` header comment or a wrapper. |
| **Commit** | (environment step, no commit; fix-follow-up doc change in Session 27 commit) |
| **Prevention** | (a) Any developer/build-agent host that needs to compile `openssl-sys v0.9.x` with the vendored feature on Windows MUST have Strawberry Perl (or ActiveState Perl) first on PATH, not MSYS perl. `winget install StrawberryPerl.StrawberryPerl` is the one-line command. (b) The `agent-build.yml` CI matrix on `windows-latest` already has Strawberry Perl pre-installed via the GitHub-hosted runner image — this is why CI never hit this bug. Local parity requires the same install. (c) Preferred long-term fix: drop the vendored feature in favour of an MSVC-prebuilt OpenSSL via vcpkg and `OPENSSL_DIR`, which cuts ~5-8 min off cold builds and eliminates the perl dependency entirely. Tracked as an optimisation, not a bug-class fix — vendored build is the safest-default for multi-host parity today. (d) Added `CHECK_PERL_HAS_IPC_CMD` guard to the developer checklist; a future improvement would be to run a `perl -MIPC::Cmd -e 1` probe at the top of `tools/build-agent-installer.sh` and print the Strawberry Perl install hint before cargo starts spinning — this alone would have saved ~7 minutes of wasted build time here. |

---

## BUG-028: API token leaked via chat when secret-input one-liner wasn't Windows/paste-safe — exposed token remained active for ~46 hours before user revoke

| Field | Detail |
| ------- | -------- |
| **Date** | 2026-04-22 |
| **Severity** | High (process bug; real impact: 46-hour exposure window of a live `Zone.Zone Settings: Edit` token scoped to `accessbridge.space`; contained by scoped TTL + limited API surface; could have been used to revert TLS 1.2, tamper with WAF / cache / page rules) |
| **Symptom** | Session 28 close-out of FINDING-PENTEST-001: user needed to provide a Cloudflare API token for the `enforce-min-tls.sh` run. First attempt — Opus gave a bash `read -rs -p "Paste CF token and press Enter: " CF_T` one-liner with the expectation that the shell would prompt locally and the token would never enter the transcript. User was in PowerShell (prompt visible as `PS E:\code\AI>`) — every line of the bash one-liner errored with "not recognized as cmdlet" → the token the user intended to paste **as the prompt input** instead got embedded into PowerShell's command-substitution of the `read -rs -p` line, concatenated into the command echo that was sent back to the chat. The real cfut_… token value was now in the chat transcript. Follow-up `/user/tokens/verify` call against the exposed token returned `"status": "active"`, `"expires_on": "2026-04-23T23:59:59Z"` — confirming it had NOT been revoked despite the earlier written warning to do so. Window: token was leaked 2026-04-22 ~05:00, alerted user 2026-04-22 ~05:10, user revoked later (confirmed by follow-up). |
| **Root Cause** | Three compounding defects in Opus's handling: **(a)** no upfront 🚨 DO NOT PASTE warning above the secret-input template — users copy-paste whole blocks without reading surrounding prose first; **(b)** bash-syntax default despite the user's prompt string clearly showing PowerShell (`PS X:\path>`); **(c)** the `read -rs -p` / `Read-Host -AsSecureString` pattern assumes a cooperative interactive shell — when the block is pasted multi-line into PowerShell, the prompt returns immediately on the next line's CR, capturing nothing or the wrong content. User then either re-pastes, or (as here) the prompt-text argument of the `read` command gets interpreted as the token when the line is pasted into a shell that doesn't have `read`. This class of bug is: "I wrote a secret-handling script assuming one shell semantics, the user ran it in a different shell, the script either produced an empty file or routed the secret to an unsafe channel." |
| **Fix** | Session-28 in-flight recovery: immediately alerted user; provided one-line revoke URL; scrubbed my side's PowerShell persistent history of 5 lines matching `cf-min-tls|CF_API_TOKEN|Read-Host -AsSecureString|cfut_` from `%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`. The *actual* successful token input used Notepad (`notepad ~/.cf-min-tls-token` → paste → save → close) which is paste-safe across every shell + OS. New feedback memory `feedback_secrets_never_in_chat` codifies the prevention. |
| **Files Changed** | `C:\Users\manis\.claude\projects\e--code-AccessBridge\memory\feedback_secrets_never_in_chat.md` (new memory); `C:\Users\manis\.claude\projects\e--code-AccessBridge\memory\MEMORY.md` (index line added); `%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt` (5 lines scrubbed — local only, not in git). |
| **Commit** | HANDOFF + RCA entry in the Session 28 close-out commit. Memory is local to this Claude-Code install. |
| **Prevention** | **(a) Lead with a 🚨-line warning above any secret-input template.** The warning must be visually distinct — not a sentence buried in the preceding paragraph. Users scan code blocks; warnings below the block come after the paste has already happened. **(b) Detect the user's shell from their prompt string.** `PS C:\...>` = PowerShell (`Read-Host -AsSecureString`), `$ ` or `user@host:~$ ` = bash / zsh (`read -rs`), `C:\...>` = cmd.exe (avoid — redirect user to PowerShell or Git Bash). Give the native syntax FIRST, alternatives BELOW. **(c) Prefer paste-safe token-input methods that don't rely on interactive prompts.** In decreasing preference: (1) Notepad / text editor write — `notepad ~/.path-to-token` — works across every shell + OS, user pastes into a normal text widget with visible feedback; (2) clipboard read — `Get-Clipboard` (PowerShell) / `pbpaste` (macOS) / `xclip -o` (Linux) — one-line, no interactive prompt, works if the token is already on the clipboard; (3) `--token-file` flag on the consuming tool (already implemented in `enforce-min-tls.sh` this session) so the user can put the token in a file via any method they like and just point the tool at it; (4) `Read-Host -AsSecureString` / `read -rs` as a distant last resort, and ONLY in a single-line command with the prompt as the only argument (multi-line paste handling varies). **(d) Any secret-handling script the team ships MUST support file-based input (mode ≤ 0o600 + symlink refusal + content validation) AND env-var input; positional CLI args for secrets are forbidden.** `enforce-min-tls.sh`'s `--token-file` path is canonical — reuse. **(e) When a secret IS leaked, the response protocol is: (1) immediately alert the user with exact revoke URL + token id; (2) verify-don't-assume that the user rotated — hit `/user/tokens/verify` or the equivalent for other providers; (3) if still live, escalate, don't wait; (4) scrub local histories that could archive the leaked value.** Skipping step (2) would have left this token live for its full 48-hour TTL. |

---

## Checklist: Version Bump — AUTOMATED (post-commit `a4bd6a1`)

Version bumping is now driven by `./deploy.sh` → `scripts/bump-version.sh --auto` — do **not** hand-edit versions. The checklist is only included here for manual overrides.

1. Auto-bump path (preferred): `./deploy.sh` — reads conventional commits since the last `v*` tag, picks major/minor/patch, syncs all `package.json` files + `manifest.json` + prepends `CHANGELOG.md`, commits, tags, pushes with `--follow-tags`, ships the new zip + CHANGELOG + `scripts/vps/main.py` to VPS, restarts `accessbridge-api`. No manual steps.
2. Manual override: `bash scripts/bump-version.sh minor` (or `major`/`patch`/`X.Y.Z`). Same downstream effects; just skips commit-message parsing.
3. Skip-bump path: `./deploy.sh --skip-bump` — re-ships artifacts without bumping. Use for doc-only tweaks or re-deploys.

VPS `/api/version` **derives** the version from `manifest.json` *inside* the deployed zip (mtime-cached), and the changelog from the top `## v*` section of `/opt/accessbridge/docs/CHANGELOG.md`. No hardcoded `CURRENT_VERSION` anywhere.
