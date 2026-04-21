import { execSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { resolve } from 'path';

// Ensure packages/extension/dist/ exists and is not older than the source manifest.
// Rebuilds if stale. Keeps contributors from running E2E against a stale bundle.
export default async function globalSetup() {
  const root = resolve(__dirname, '..');
  const distManifest = resolve(root, 'packages/extension/dist/manifest.json');
  const srcManifest = resolve(root, 'packages/extension/manifest.json');

  let needsBuild = !existsSync(distManifest);
  if (!needsBuild && existsSync(srcManifest)) {
    const distMtime = statSync(distManifest).mtimeMs;
    const srcMtime = statSync(srcManifest).mtimeMs;
    if (srcMtime > distMtime) needsBuild = true;
  }

  if (needsBuild) {
    console.log('[e2e] Extension dist is stale — running pnpm build…');
    execSync('pnpm build', { cwd: root, stdio: 'inherit' });
  } else {
    console.log('[e2e] Extension dist is fresh — skipping build.');
  }
}
