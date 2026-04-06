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

## Checklist: Version Bump

1. `packages/extension/manifest.json` — update `version`
2. VPS API `/opt/accessbridge/api/main.py` — update `CURRENT_VERSION`
3. `pnpm build`
4. Create zip: `powershell Compress-Archive -Path dist/* -DestinationPath accessbridge-extension.zip -Force`
5. Upload: `scp accessbridge-extension.zip a11yos-vps:/opt/accessbridge/docs/downloads/`
6. Restart API: `ssh a11yos-vps "cd /opt/accessbridge && docker compose restart accessbridge-api"`
7. Landing page version updates automatically (fetches from API)
