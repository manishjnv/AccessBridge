# Development Setup

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 20.0+ | JavaScript runtime |
| pnpm | 9.0+ | Package manager (monorepo workspaces) |
| Chrome or Edge | Latest | Extension testing and debugging |
| Git | 2.30+ | Version control |

### Installing Prerequisites

**Node.js:** Download from [nodejs.org](https://nodejs.org/) or use a version manager:
```bash
# Using nvm (macOS/Linux)
nvm install 20
nvm use 20

# Using fnm (Windows/macOS/Linux)
fnm install 20
fnm use 20
```

**pnpm:** Install globally after Node.js is available:
```bash
npm install -g pnpm@latest
```

## Clone and Install

```bash
git clone <repo-url> AccessBridge
cd AccessBridge
pnpm install
```

This installs dependencies for all three packages (`core`, `extension`, `ai-engine`) via pnpm workspaces. The workspace configuration is in `pnpm-workspace.yaml`.

## Build and Load Extension

### Build

```bash
# Build the extension (includes core as workspace dependency)
pnpm build

# Or build all packages explicitly
pnpm build:all
```

The build output lands in `packages/extension/dist/`. This is the directory you load into Chrome.

### Load in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `packages/extension/dist/` directory
5. The AccessBridge extension icon should appear in the toolbar

### Development Mode (Watch)

```bash
pnpm dev
```

This runs Vite in watch mode. When you edit source files, the extension is rebuilt automatically. After a rebuild, go to `chrome://extensions/` and click the reload icon on the AccessBridge card (or press Ctrl+Shift+R on the extension's popup).

## Type Checking

```bash
# Type check all packages
pnpm typecheck
```

This runs `tsc --noEmit` across all packages. The project currently has zero type errors.

## Linting

```bash
pnpm lint
```

Runs ESLint across all packages.

## Running Tests

```bash
pnpm test
```

Runs the test suite across all packages. (Test infrastructure is being set up during the sprint.)

## Project Commands Reference

| Command | Description |
|---------|-------------|
| `pnpm install` | Install all dependencies across workspace |
| `pnpm build` | Build the extension package |
| `pnpm build:all` | Build all packages |
| `pnpm dev` | Start development mode with file watching |
| `pnpm typecheck` | Run TypeScript type checking (all packages) |
| `pnpm lint` | Run ESLint (all packages) |
| `pnpm test` | Run test suite (all packages) |

## VPS Access

The project has a VPS for backend services (API, Observatory dashboard, Nginx reverse proxy).

```bash
# Connect via SSH (alias configured in ~/.ssh/config)
ssh a11yos-vps
# or
ssh accessbridge-vps
```

### VPS Services

| Service | Port | Description |
|---------|------|-------------|
| API | 8100 | Backend API server |
| Observatory | 8200 | Monitoring dashboard |
| Nginx | 8300 | Reverse proxy |

All services run via Docker Compose at `/opt/accessbridge/` on the VPS. They are isolated from other services on the same machine.

```bash
# On the VPS: manage services
cd /opt/accessbridge
docker compose up -d      # Start all services
docker compose down       # Stop all services
docker compose logs -f    # Follow logs
```

## Project Structure

```
AccessBridge/
  package.json              # Root package.json with workspace scripts
  pnpm-workspace.yaml       # Workspace configuration
  tsconfig.base.json        # Shared TypeScript config
  HANDOFF.md                # Shift handoff document
  docs/                     # Documentation
  packages/
    core/                   # @accessbridge/core
      src/
        types/              # Profile, Signal, Adaptation interfaces
        profile/            # ProfileStore (IndexedDB + AES-GCM)
        signals/            # StruggleDetector
        decision/           # DecisionEngine
    extension/              # @accessbridge/extension
      src/
        popup/              # React popup UI
        sidepanel/          # Side panel UI
        content/            # Content scripts
          sensory/          # SensoryAdapter
          adapters/         # Gmail, Outlook, generic adapters
        background/         # Service worker
    ai-engine/              # @accessbridge/ai-engine
      src/
        types.ts            # AI types, config, cost tracking
        cache.ts            # Request dedup and caching
```

## Troubleshooting

### Extension fails to load
- Verify the `dist/` directory exists: run `pnpm build` first
- Check Chrome's extension error details for manifest issues
- Ensure you are loading from `packages/extension/dist/`, not the root

### TypeScript errors after pulling
- Run `pnpm install` to sync dependencies
- Run `pnpm typecheck` to see specific errors

### VPS connection refused
- Verify the SSH alias is configured: check `~/.ssh/config` for `a11yos-vps` or `accessbridge-vps` entries
- Ensure the VPS services are running: `ssh accessbridge-vps 'cd /opt/accessbridge && docker compose ps'`

### Vite watch mode not picking up changes
- Vite watch mode does not always detect changes to workspace dependencies. If you edit `packages/core/`, restart the dev server.
