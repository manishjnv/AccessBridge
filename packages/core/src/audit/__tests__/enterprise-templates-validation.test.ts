/**
 * Session 20 — validation tests for enterprise deployment templates.
 *
 * Uses only Node's built-in fs/path so we don't depend on an XML library.
 * Checks well-formedness (XML declaration + expected root elements), content
 * invariants (no raw IP references, correct update URLs, every string id has
 * content), and cross-locale parity (en-US ADML and hi-IN ADML cover the
 * same string ids).
 *
 * 12 tests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolve repo root from this file's location (packages/core/src/audit/__tests__)
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, '..', '..', '..', '..', '..');

function repoPath(rel: string): string {
  return resolve(REPO_ROOT, rel);
}

function readText(rel: string): string {
  return readFileSync(repoPath(rel), 'utf8');
}

// ---------- Template paths ----------

const ADMX_APP = 'deploy/enterprise/admx/AccessBridge.admx';
const ADML_EN = 'deploy/enterprise/admx/en-US/AccessBridge.adml';
const ADML_HI = 'deploy/enterprise/admx/hi-IN/AccessBridge.adml';
const ADMX_CHROME = 'deploy/enterprise/chrome-extension/AccessBridge-ChromeExtension.admx';
const ADML_CHROME = 'deploy/enterprise/chrome-extension/AccessBridge-ChromeExtension.adml';
const MOBILECONFIG = 'deploy/enterprise/chrome-extension/AccessBridge.mobileconfig';
const CHROME_POLICY_JSON = 'deploy/enterprise/chrome-extension/chrome-policy.json';
const UPDATES_XML = 'deploy/enterprise/chrome-extension/updates.xml';

// ---------- Shared helpers ----------

/**
 * Extract the set of every `<string id="…">` in an ADML file.
 * Uses a naive regex — good enough for template validation (the files
 * themselves are hand-written XML with no CDATA or attribute-value quoting
 * tricks that would break this).
 */
function extractAdmlStringIds(content: string): Set<string> {
  const ids = new Set<string>();
  const re = /<string\s+id="([^"]+)"\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

/** Count empty `<string id="…"></string>` entries — each is a bug. */
function countEmptyAdmlStrings(content: string): number {
  const re = /<string\s+id="[^"]+"\s*>\s*<\/string>/g;
  return (content.match(re) ?? []).length;
}

// ─── AccessBridge.admx (9 AccessBridge-specific policies) ────────────────────

describe('enterprise templates — AccessBridge.admx', () => {
  let content = '';

  beforeAll(() => {
    expect(existsSync(repoPath(ADMX_APP))).toBe(true);
    content = readText(ADMX_APP);
  });

  it('starts with an XML declaration', () => {
    expect(content.trimStart().startsWith('<?xml')).toBe(true);
  });

  it('has a policyDefinitions root with categories + policies', () => {
    expect(content).toMatch(/<policyDefinitions[\s>]/);
    expect(content).toMatch(/<categories>/);
    expect(content).toMatch(/<policies>/);
    // At least one <category … /> and one <policy …>
    expect(content).toMatch(/<category\s/);
    expect(content).toMatch(/<policy\s/);
  });

  it('defines registry path under HKLM\\SOFTWARE\\Policies\\AccessBridge', () => {
    expect(content).toMatch(/SOFTWARE\\Policies\\AccessBridge/i);
  });

  it('declares all 9 AccessBridge policies by name', () => {
    const expected = [
      'EnabledFeaturesLockdown',
      'DisabledFeaturesLockdown',
      'ObservatoryOptInRequired',
      'TelemetryLevel',
      'AllowCloudAITier',
      'CustomAPIEndpoint',
      'DefaultLanguage',
      'ProfileSyncMode',
      'MinimumAgentVersion',
    ];
    for (const name of expected) {
      expect(content, `AccessBridge.admx must define policy ${name}`).toMatch(
        new RegExp(`<policy\\s[^>]*name="${name}"`),
      );
    }
  });

  it('declares the ProfileSyncMode + TelemetryLevel enum values', () => {
    for (const v of ['off', 'local-only', 'relay']) {
      expect(content, `ProfileSyncMode should include value "${v}"`).toMatch(
        new RegExp(`value=["']${v}["']|"${v}"`),
      );
    }
    for (const v of ['none', 'aggregated', 'full']) {
      expect(content, `TelemetryLevel should include value "${v}"`).toMatch(
        new RegExp(`value=["']${v}["']|"${v}"`),
      );
    }
  });
});

// ─── AccessBridge.adml en-US + hi-IN parity ──────────────────────────────────

describe('enterprise templates — AccessBridge.adml localizations', () => {
  let enIds: Set<string> = new Set();
  let hiIds: Set<string> = new Set();
  let enContent = '';
  let hiContent = '';

  beforeAll(() => {
    expect(existsSync(repoPath(ADML_EN))).toBe(true);
    expect(existsSync(repoPath(ADML_HI))).toBe(true);
    enContent = readText(ADML_EN);
    hiContent = readText(ADML_HI);
    enIds = extractAdmlStringIds(enContent);
    hiIds = extractAdmlStringIds(hiContent);
  });

  it('both ADMLs are well-formed with a <resources> root', () => {
    expect(enContent).toMatch(/<resources[\s>]/);
    expect(hiContent).toMatch(/<resources[\s>]/);
  });

  it('every <string id> in both locales has non-empty content', () => {
    expect(countEmptyAdmlStrings(enContent)).toBe(0);
    expect(countEmptyAdmlStrings(hiContent)).toBe(0);
  });

  it('en-US and hi-IN expose the same string-id set (cross-locale parity)', () => {
    const enOnly = [...enIds].filter((id) => !hiIds.has(id));
    const hiOnly = [...hiIds].filter((id) => !enIds.has(id));
    expect(enOnly, `en-US has ids missing from hi-IN: ${enOnly.join(', ')}`).toEqual([]);
    expect(hiOnly, `hi-IN has ids missing from en-US: ${hiOnly.join(', ')}`).toEqual([]);
    // And both should have a meaningful number of strings (>= 20 given 9 policies × display + description)
    expect(enIds.size).toBeGreaterThanOrEqual(18);
  });
});

// ─── Chrome-extension ADMX (ExtensionInstallForcelist + ExtensionSettings) ───

describe('enterprise templates — AccessBridge-ChromeExtension.admx/.adml', () => {
  let admxContent = '';
  let admlContent = '';

  beforeAll(() => {
    expect(existsSync(repoPath(ADMX_CHROME))).toBe(true);
    expect(existsSync(repoPath(ADML_CHROME))).toBe(true);
    admxContent = readText(ADMX_CHROME);
    admlContent = readText(ADML_CHROME);
  });

  it('references the placeholder extension ID with a replace-before-prod comment', () => {
    expect(admxContent).toContain('abcdefghijklmnopqrstuvwxyzabcdef');
    expect(admxContent).toMatch(/REPLACE.*EXTENSION ID/i);
  });

  it('references the HTTPS accessbridge.space update URL (never raw IP nor insecure accessbridge URL)', () => {
    expect(admxContent).toMatch(/accessbridge\.space/);
    expect(admxContent).not.toMatch(/72\.61\.227\.64/);
    // Ignore XML-namespace http:// URLs; only fail on insecure accessbridge or public download URLs.
    expect(admxContent).not.toMatch(/http:\/\/accessbridge/);
    expect(admxContent).not.toMatch(/http:\/\/72\./);
  });

  it('ADML resolves every ADMX <string id>', () => {
    const admxIds = new Set<string>();
    const re = /\$\(string\.([A-Za-z0-9_]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(admxContent)) !== null) admxIds.add(m[1]);
    const admlIds = extractAdmlStringIds(admlContent);
    for (const id of admxIds) {
      expect(admlIds.has(id), `ADML must define string id: ${id}`).toBe(true);
    }
  });
});

// ─── mobileconfig ────────────────────────────────────────────────────────────

describe('enterprise templates — AccessBridge.mobileconfig', () => {
  let content = '';

  beforeAll(() => {
    expect(existsSync(repoPath(MOBILECONFIG))).toBe(true);
    content = readText(MOBILECONFIG);
  });

  it('is a valid-looking plist with the expected PayloadType and Chrome domain', () => {
    expect(content.trimStart().startsWith('<?xml')).toBe(true);
    expect(content).toMatch(/<plist[\s>]/);
    expect(content).toMatch(/<dict>/);
    expect(content).toMatch(/<key>PayloadType<\/key>/);
    expect(content).toMatch(
      /<key>PayloadType<\/key>\s*<string>com\.apple\.ManagedClient\.preferences<\/string>/,
    );
    expect(content).toContain('com.google.Chrome');
  });

  it('contains a UUID-shaped PayloadUUID', () => {
    // The template puts an XML comment between the <key> and <string>,
    // so the naive `<key>...</key>\s*<string>` regex needs a comment-tolerant pass.
    const match = content.match(
      /<key>PayloadUUID<\/key>[\s\S]*?<string>([0-9A-Fa-f-]+)<\/string>/,
    );
    expect(match).not.toBeNull();
    // UUID format: 8-4-4-4-12
    expect(match![1]).toMatch(
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    );
  });
});

// ─── Linux chrome-policy.json ────────────────────────────────────────────────

describe('enterprise templates — chrome-policy.json', () => {
  let parsed: Record<string, unknown> = {};

  beforeAll(() => {
    expect(existsSync(repoPath(CHROME_POLICY_JSON))).toBe(true);
    const raw = readText(CHROME_POLICY_JSON);
    parsed = JSON.parse(raw) as Record<string, unknown>;
  });

  it('parses as JSON with at least ExtensionInstallForcelist or ExtensionSettings', () => {
    const hasForcelist = 'ExtensionInstallForcelist' in parsed;
    const hasSettings = 'ExtensionSettings' in parsed;
    expect(hasForcelist || hasSettings).toBe(true);
  });

  it('contains no raw IP URLs — only accessbridge.space HTTPS references', () => {
    const raw = readText(CHROME_POLICY_JSON);
    expect(raw).not.toMatch(/72\.61\.227\.64/);
    // If URLs appear, they must be https://accessbridge.space
    const urls = raw.match(/https?:\/\/[^\s"]+/g) ?? [];
    for (const url of urls) {
      expect(
        url.startsWith('https://accessbridge.space') || url.startsWith('https://clients2.google.com'),
        `chrome-policy.json URL must be https://accessbridge.space (got ${url})`,
      ).toBe(true);
    }
  });
});

// ─── updates.xml ─────────────────────────────────────────────────────────────

describe('enterprise templates — updates.xml', () => {
  let content = '';

  beforeAll(() => {
    expect(existsSync(repoPath(UPDATES_XML))).toBe(true);
    content = readText(UPDATES_XML);
  });

  it('is a gupdate manifest pointing at the signed CRX on accessbridge.space', () => {
    expect(content).toMatch(/<gupdate[^>]*xmlns=['"]http:\/\/www\.google\.com\/update2\/response['"]/);
    // The template quotes attribute values with double quotes; accept either quote style.
    expect(content).toMatch(
      /codebase=['"]https:\/\/accessbridge\.space\/downloads\/accessbridge-extension\.crx['"]/,
    );
    expect(content).toMatch(/version=['"][0-9]+\.[0-9]+\.[0-9]+['"]/);
  });
});
