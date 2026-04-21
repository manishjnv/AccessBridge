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

## Checklist: Version Bump — AUTOMATED (post-commit `a4bd6a1`)

Version bumping is now driven by `./deploy.sh` → `scripts/bump-version.sh --auto` — do **not** hand-edit versions. The checklist is only included here for manual overrides.

1. Auto-bump path (preferred): `./deploy.sh` — reads conventional commits since the last `v*` tag, picks major/minor/patch, syncs all `package.json` files + `manifest.json` + prepends `CHANGELOG.md`, commits, tags, pushes with `--follow-tags`, ships the new zip + CHANGELOG + `scripts/vps/main.py` to VPS, restarts `accessbridge-api`. No manual steps.
2. Manual override: `bash scripts/bump-version.sh minor` (or `major`/`patch`/`X.Y.Z`). Same downstream effects; just skips commit-message parsing.
3. Skip-bump path: `./deploy.sh --skip-bump` — re-ships artifacts without bumping. Use for doc-only tweaks or re-deploys.

VPS `/api/version` **derives** the version from `manifest.json` *inside* the deployed zip (mtime-cached), and the changelog from the top `## v*` section of `/opt/accessbridge/docs/CHANGELOG.md`. No hardcoded `CURRENT_VERSION` anywhere.
