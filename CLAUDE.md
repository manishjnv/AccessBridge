# AccessBridge — Claude Code Instructions

## Bug Fix Protocol (MANDATORY)

Every bug fix must follow this sequence:

1. **Read `RCA.md`** — check for related past bugs and their prevention rules
2. **Claude diagnoses** — identify root cause, check if it matches a known pattern
3. **Dispatch Codex in parallel** — for independent investigation, fix, or regression check
4. **Claude reviews Codex output** — verify fix doesn't reintroduce any past bug
5. **Build + test** — `pnpm build && npx vitest run` must both pass
6. **Verify in Chrome** — reload extension, test the fix AND related features
7. **Update `RCA.md`** — add new BUG-XXX entry with root cause and prevention

## Key Rules

- **Team name**: Always "Manish Kumar" — never "& Team" or variations
- **Vite config**: Never remove `base: ''` (see RCA BUG-001)
- **External URLs**: Always use nginx proxy port 8300, never internal Docker ports (see RCA BUG-002)
- **Version bumps**: Must update manifest.json + VPS API + rebuild + rezip (see RCA BUG-003)
- **Landing page**: Version and download URL are dynamic from `/api/version` — never hardcode (see RCA BUG-004)
- **Popup state**: Any state that must persist across popup close/reopen uses `chrome.storage.local` (see RCA BUG-005)

## Commands

```bash
pnpm build              # Build extension to dist/
pnpm typecheck          # Type check all packages
npx vitest run          # Run all 116 tests
pnpm dev                # Dev mode with watch
```

## Deploy

```bash
# Full deploy (build → test → push → VPS)
./deploy.sh

# Manual VPS deploy
scp deploy/index.html a11yos-vps:/opt/accessbridge/docs/index.html
scp accessbridge-extension.zip a11yos-vps:/opt/accessbridge/docs/downloads/
```
