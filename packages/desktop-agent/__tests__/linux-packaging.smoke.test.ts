/**
 * Linux packaging smoke tests (Session 22).
 *
 * These tests verify that the Tauri Linux build artefacts (`.deb`, `.rpm`,
 * `AppImage`) exist and are non-trivially sized after `tauri build` completes.
 *
 * # When these tests run
 *
 * The suite is gated behind TWO conditions checked by `describe.skipIf`:
 *
 *   1. `process.platform === 'linux'` — the test can only pass on a Linux host
 *      (the Tauri bundler writes artefacts to OS-specific paths).
 *
 *   2. `process.env.AGENT_BUILD_DONE === '1'` — the caller (CI matrix job or
 *      local dev) must set this env var AFTER `pnpm tauri:build` completes
 *      successfully.  This prevents the suite from running (and failing with
 *      "file not found") in a build-less environment.
 *
 * # Usage
 *
 *   # In CI (after the tauri:build step):
 *   AGENT_BUILD_DONE=1 pnpm --filter @accessbridge/desktop-agent test:smoke
 *
 *   # Locally (on a Linux host):
 *   pnpm --filter @accessbridge/desktop-agent tauri:build
 *   AGENT_BUILD_DONE=1 pnpm --filter @accessbridge/desktop-agent test:smoke
 *
 * # Size threshold
 *
 * The 1 MB lower bound is a sanity check against corrupted / empty artefacts.
 * A healthy AccessBridge Desktop Agent binary is expected to be significantly
 * larger (typically 15–40 MB depending on LTO settings), so 1 MB gives ample
 * headroom for future binary size changes without requiring test updates.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ─── Path helpers ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the Tauri release bundle directory. */
const BUNDLE_ROOT = path.resolve(
  __dirname,
  '..', // packages/desktop-agent/
  'src-tauri',
  'target',
  'release',
  'bundle',
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find the first file matching `glob` (single `*` wildcard in filename)
 * inside `dir`.  Returns `null` if the directory doesn't exist or no
 * matching file is found.
 */
function findFirstFile(dir: string, extension: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir);
  const match = entries.find((e) => e.endsWith(extension));
  return match ? path.join(dir, match) : null;
}

const MIN_SIZE_BYTES = 1_000_000; // 1 MB

function assertArtifact(bundleSubdir: string, extension: string, label: string): void {
  const dir = path.join(BUNDLE_ROOT, bundleSubdir);
  const filePath = findFirstFile(dir, extension);

  expect(
    filePath,
    `No ${label} artefact found in ${dir}. ` +
      `Run "pnpm tauri:build" on a Linux host first, then set AGENT_BUILD_DONE=1.`,
  ).not.toBeNull();

  if (!filePath) return; // narrow type; the expect above will have failed

  const stat = fs.statSync(filePath);
  expect(
    stat.size,
    `${label} artefact at ${filePath} is suspiciously small (${stat.size} bytes < ${MIN_SIZE_BYTES}). ` +
      `The build may have produced a truncated or empty file.`,
  ).toBeGreaterThan(MIN_SIZE_BYTES);
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const shouldRun =
  process.platform === 'linux' && process.env['AGENT_BUILD_DONE'] === '1';

describe.skipIf(!shouldRun)(
  'Linux packaging artefacts smoke tests (requires Linux + AGENT_BUILD_DONE=1)',
  () => {
    it('1. .deb exists and is non-trivial (> 1 MB)', () => {
      assertArtifact('deb', '.deb', 'Debian package (.deb)');
    });

    it('2. .rpm exists and is non-trivial (> 1 MB)', () => {
      assertArtifact('rpm', '.rpm', 'RPM package (.rpm)');
    });

    it('3. AppImage exists and is non-trivial (> 1 MB)', () => {
      assertArtifact('appimage', '.AppImage', 'AppImage');
    });
  },
);
