#!/usr/bin/env tsx
/**
 * enroll-batch.ts — AccessBridge Session 24 batch pilot-enrollment CLI.
 *
 * Reads a CSV of employees, validates each row, and emits per-employee
 * shell + PowerShell install scripts together with a zip archive and an
 * enrollment log.
 *
 * Author  : Manish Kumar
 * Project : AccessBridge v0.22.0
 * Session : 24 — Team-tier installer
 * Updated : 2026-04-21
 *
 * Usage:
 *   tsx tools/pilot/enroll-batch.ts --input employees.csv --output dist/pilots
 *   tsx tools/pilot/enroll-batch.ts --help
 *
 * CSV columns (header required):
 *   employee_id,preset,contact_email
 *
 * Output layout:
 *   <output>/
 *     install-<employee_id>.sh      — bash script (macOS / Linux)
 *     install-<employee_id>.ps1     — PowerShell script (Windows)
 *     enrollment-log.csv            — timestamp,employee_id,pilot_id,preset
 *     scripts-<timestamp>.zip       — zip of all .sh + .ps1 files
 */

import { createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CsvRow {
  employee_id: string;
  preset: string;
  contact_email: string;
}

interface EnrollResult {
  ok: boolean;
  employee_id: string;
  pilot_id: string;
  preset: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Argument parsing (no external deps)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();
  const args = argv.slice(2);
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      result.set('help', true);
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        result.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        result.set(arg.slice(2), args[i + 1]);
        i++;
      } else {
        result.set(arg.slice(2), true);
      }
    }
    i++;
  }
  return result;
}

function printHelp(): void {
  console.log(`
AccessBridge Batch Enrollment CLI — v0.22.0
Author: Manish Kumar

USAGE
  tsx tools/pilot/enroll-batch.ts --input <csv> --output <dir> [OPTIONS]

REQUIRED
  --input  <path>    CSV file with columns: employee_id,preset,contact_email
  --output <dir>     Output directory (created if absent)

OPTIONS
  --dry-run          Validate CSV but write no files
  --help             Show this help and exit

OUTPUT
  <dir>/install-<employee_id>.sh    Bash install script (macOS + Linux)
  <dir>/install-<employee_id>.ps1   PowerShell install script (Windows)
  <dir>/enrollment-log.csv          Audit log: timestamp,employee_id,pilot_id,preset
  <dir>/scripts-<timestamp>.zip     Zip of all generated scripts

VALIDATION
  • preset must match a profile in deploy/team/profiles/ (e.g. pilot-default.json)
  • contact_email must be a valid RFC 5322 address (simple pattern)
  • employee_id must not contain shell metacharacters

EXIT CODES
  0  all rows processed successfully (with possible per-row warnings)
  1  fatal error (bad args, unreadable CSV, etc.)
`);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

// RFC 5322 simple regex (covers 99 % of real addresses)
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// Safe employee_id: alphanumeric, hyphens, underscores only (no shell metacharacters)
const EMPLOYEE_ID_RE = /^[a-zA-Z0-9_-]+$/;

// Safe profile name: lowercase alphanumeric + hyphen (matches deploy/team/profiles/ convention)
const PROFILE_NAME_RE = /^[a-z0-9-]+$/;

/**
 * OWASP CSV injection guard: prefix dangerous leading chars with a single quote.
 * Affected chars: =  +  -  @  TAB  CR
 */
function csvEscape(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

function validateRow(
  row: CsvRow,
  lineNum: number,
  availableProfiles: Set<string>,
): string | null {
  if (!EMPLOYEE_ID_RE.test(row.employee_id)) {
    return `Line ${lineNum}: employee_id '${row.employee_id}' contains shell metacharacters or invalid chars`;
  }
  if (!PROFILE_NAME_RE.test(row.preset)) {
    return `Line ${lineNum}: preset '${row.preset}' contains invalid characters (must be ^[a-z0-9-]+$)`;
  }
  // BUG-015 proto-pollution guard: use Map/Set + Object.hasOwn-equivalent
  if (!availableProfiles.has(row.preset)) {
    return `Line ${lineNum}: preset '${row.preset}' not found in deploy/team/profiles/`;
  }
  if (!EMAIL_RE.test(row.contact_email)) {
    return `Line ${lineNum}: contact_email '${row.contact_email}' does not match RFC 5322 pattern`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CSV parsing (streaming, no external deps)
// ---------------------------------------------------------------------------

async function parseCsv(filePath: string): Promise<CsvRow[]> {
  const rows: CsvRow[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let headerParsed = false;
  let columnIndex: Map<string, number> | null = null;
  let lineNum = 0;

  for await (const line of rl) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue; // skip blank lines

    const cols = trimmed.split(',').map(c => c.trim().replace(/^"|"$/g, ''));

    if (!headerParsed) {
      columnIndex = new Map(cols.map((col, idx) => [col.toLowerCase(), idx]));
      const required = ['employee_id', 'preset', 'contact_email'];
      for (const col of required) {
        if (!columnIndex.has(col)) {
          throw new Error(`CSV missing required column: '${col}' (line ${lineNum})`);
        }
      }
      headerParsed = true;
      continue;
    }

    if (!columnIndex) throw new Error('Internal: columnIndex not set');

    const get = (col: string): string => {
      const idx = columnIndex!.get(col);
      return idx !== undefined ? (cols[idx] ?? '').trim() : '';
    };

    rows.push({
      employee_id: get('employee_id'),
      preset: get('preset'),
      contact_email: get('contact_email'),
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Script generation
// ---------------------------------------------------------------------------

function generateBashScript(row: CsvRow, pilotId: string): string {
  // All values are pre-validated; still quote them for safety
  const safeProfile = row.preset.replace(/'/g, '');
  const safePilotId = pilotId.replace(/'/g, '');
  return `#!/usr/bin/env bash
# AccessBridge pilot install script — auto-generated by enroll-batch.ts
# Author  : Manish Kumar
# Employee: ${row.employee_id}
# Preset  : ${safeProfile}
# PilotId : ${safePilotId}
# Generated: ${new Date().toISOString()}
#
# Run from the root of the accessbridge repository:
#   bash deploy/team/install.sh --profile='${safeProfile}' --pilot-id='${safePilotId}' "$@"
#
# Or via the universal installer if curl is available.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="\${SCRIPT_DIR}/../../deploy/team/install.sh"

if [[ ! -f "\$INSTALLER" ]]; then
  echo "[ERROR] Installer not found at \$INSTALLER"
  echo "        Run this script from inside a checkout of github.com/manishjnv/accessbridge"
  exit 1
fi

bash "\$INSTALLER" \\
  --profile='${safeProfile}' \\
  --pilot-id='${safePilotId}' \\
  "$@"
`;
}

function generatePowerShellScript(row: CsvRow, pilotId: string): string {
  const safeProfile = row.preset.replace(/['"]/g, '');
  const safePilotId = pilotId.replace(/['"]/g, '');
  return `#Requires -Version 5.1
# AccessBridge pilot install script — auto-generated by enroll-batch.ts
# Author  : Manish Kumar
# Employee: ${row.employee_id}
# Preset  : ${safeProfile}
# PilotId : ${safePilotId}
# Generated: ${new Date().toISOString()}
#
# Run from the root of the accessbridge repository:
#   pwsh -File deploy/team/install.ps1 -Profile '${safeProfile}' -PilotId '${safePilotId}'

[CmdletBinding()]
param(
    [ValidateSet('opt-in','off')][string]\$Observatory = 'off',
    [ValidateSet('yes','no')][string]\$Agent           = 'no',
    [ValidateSet('quiet','normal','verbose')][string]\$LogLevel = 'normal',
    [switch]\$DryRun
)

\$scriptDir  = Split-Path -Parent \$MyInvocation.MyCommand.Path
\$installer  = Join-Path \$scriptDir '..\\..\\deploy\\team\\install.ps1'

if (-not (Test-Path \$installer)) {
    Write-Host '[ERROR] Installer not found at ' + \$installer -ForegroundColor Red
    Write-Host '        Run this script from inside a checkout of github.com/manishjnv/accessbridge'
    exit 1
}

\$forwardParams = @{
    Profile      = '${safeProfile}'
    PilotId      = '${safePilotId}'
    Observatory  = \$Observatory
    Agent        = \$Agent
    LogLevel     = \$LogLevel
}
if (\$DryRun) { \$forwardParams['DryRun'] = \$true }

& \$installer @forwardParams
exit \$LASTEXITCODE
`;
}

// ---------------------------------------------------------------------------
// Zip creation (native Node.js — no external deps)
// Uses a minimal ZIP format writer (store method for simplicity + portability)
// ---------------------------------------------------------------------------

function uint32LE(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}
function uint16LE(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function dosDateTime(d: Date): { date: number; time: number } {
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    (Math.floor(d.getSeconds() / 2) & 0x1f);
  return { date, time };
}

/** CRC-32 per PKware spec (table-driven) */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    let byte = (crc ^ data[i]) & 0xff;
    for (let j = 0; j < 8; j++) {
      if (byte & 1) {
        byte = ((byte >>> 1) ^ 0xedb88320) >>> 0;
      } else {
        byte = byte >>> 1;
      }
    }
    crc = ((crc >>> 8) ^ byte) >>> 0;
  }
  return (~crc) >>> 0;
}

function writeZip(outputPath: string, files: Array<{ name: string; data: Buffer }>): void {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dt = dosDateTime(now);

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const size = file.data.length;

    // Local file header (method=0 STORE)
    const localHeader = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // signature
      uint16LE(20),            // version needed
      uint16LE(0),             // flags
      uint16LE(0),             // compression: STORE
      uint16LE(dt.time),
      uint16LE(dt.date),
      uint32LE(crc),
      uint32LE(size),          // compressed size
      uint32LE(size),          // uncompressed size
      uint16LE(nameBytes.length),
      uint16LE(0),             // extra field length
      nameBytes,
    ]);
    localHeaders.push(localHeader);
    localHeaders.push(file.data);

    // Central directory header
    const cdHeader = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), // signature
      uint16LE(20),            // version made by
      uint16LE(20),            // version needed
      uint16LE(0),             // flags
      uint16LE(0),             // compression: STORE
      uint16LE(dt.time),
      uint16LE(dt.date),
      uint32LE(crc),
      uint32LE(size),
      uint32LE(size),
      uint16LE(nameBytes.length),
      uint16LE(0),             // extra
      uint16LE(0),             // comment
      uint16LE(0),             // disk start
      uint16LE(0),             // internal attr
      uint32LE(0),             // external attr
      uint32LE(offset),        // local header offset
      nameBytes,
    ]);
    centralHeaders.push(cdHeader);
    offset += localHeader.length + file.data.length;
  }

  const localData = Buffer.concat(localHeaders);
  const cdData = Buffer.concat(centralHeaders);
  const cdOffset = localData.length;
  const cdSize = cdData.length;
  const count = files.length;

  // End of central directory record
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    uint16LE(0),               // disk number
    uint16LE(0),               // disk with CD
    uint16LE(count),
    uint16LE(count),
    uint32LE(cdSize),
    uint32LE(cdOffset),
    uint16LE(0),               // comment length
  ]);

  writeFileSync(outputPath, Buffer.concat([localData, cdData, eocd]));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.has('help') || args.size === 0) {
    printHelp();
    process.exit(0);
  }

  const inputArg = args.get('input');
  const outputArg = args.get('output');
  const dryRun = args.has('dry-run');

  if (!inputArg || inputArg === true) {
    console.error('[ERROR] --input <path> is required');
    process.exit(1);
  }
  if (!outputArg || outputArg === true) {
    console.error('[ERROR] --output <dir> is required');
    process.exit(1);
  }

  // Path traversal guard: always resolve
  const inputPath = resolve(inputArg as string);
  const outputDir = resolve(outputArg as string);

  if (!existsSync(inputPath)) {
    console.error(`[ERROR] Input file not found: ${inputPath}`);
    process.exit(1);
  }

  // Resolve profiles directory relative to this script (tools/pilot/) → repo root (../.. up)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname  = dirname(__filename);
  const repoRoot   = resolve(__dirname, '../..');
  const profilesDir = join(repoRoot, 'deploy', 'team', 'profiles');

  // Build available profiles set (BUG-015: use Set, not object)
  const availableProfiles = new Set<string>();
  if (existsSync(profilesDir)) {
    for (const entry of readdirSync(profilesDir)) {
      if (entry.endsWith('.json')) {
        availableProfiles.add(entry.slice(0, -5)); // strip .json
      }
    }
  } else {
    console.warn(`[WARN] profiles directory not found: ${profilesDir} — preset validation will fail for all rows`);
  }

  // Parse CSV
  let rows: CsvRow[];
  try {
    rows = await parseCsv(inputPath);
  } catch (err) {
    console.error(`[ERROR] Failed to parse CSV: ${(err as Error).message}`);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.warn('[WARN] CSV has no data rows — nothing to enroll.');
    process.exit(0);
  }

  // Create output dir
  if (!dryRun) {
    mkdirSync(outputDir, { recursive: true });
  }

  const results: EnrollResult[] = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(outputDir, 'enrollment-log.csv');
  const zipPath = join(outputDir, `scripts-${timestamp}.zip`);

  const zipFiles: Array<{ name: string; data: Buffer }> = [];

  let lineNum = 1; // header was line 1
  for (const row of rows) {
    lineNum++;
    const validationError = validateRow(row, lineNum, availableProfiles);
    if (validationError) {
      console.warn(`[WARN] Skipping: ${validationError}`);
      results.push({ ok: false, employee_id: row.employee_id, pilot_id: '', preset: row.preset, error: validationError });
      continue;
    }

    const pilotId = randomUUID();
    const shName = `install-${row.employee_id}.sh`;
    const ps1Name = `install-${row.employee_id}.ps1`;

    const shContent = generateBashScript(row, pilotId);
    const ps1Content = generatePowerShellScript(row, pilotId);

    if (!dryRun) {
      writeFileSync(join(outputDir, shName), shContent, { encoding: 'utf8', mode: 0o755 });
      writeFileSync(join(outputDir, ps1Name), ps1Content, { encoding: 'utf8' });
    }

    zipFiles.push({ name: shName, data: Buffer.from(shContent, 'utf8') });
    zipFiles.push({ name: ps1Name, data: Buffer.from(ps1Content, 'utf8') });

    results.push({ ok: true, employee_id: row.employee_id, pilot_id: pilotId, preset: row.preset });
    console.log(`[OK] ${row.employee_id} → pilot_id=${pilotId} preset=${row.preset}${dryRun ? ' [DRY-RUN]' : ''}`);
  }

  // Write enrollment log (with CSV injection guard)
  if (!dryRun) {
    const logLines = ['timestamp,employee_id,pilot_id,preset'];
    const now = new Date().toISOString();
    for (const r of results) {
      if (r.ok) {
        const cols = [now, r.employee_id, r.pilot_id, r.preset].map(csvEscape);
        logLines.push(cols.join(','));
      }
    }
    writeFileSync(logPath, logLines.join('\n') + '\n', 'utf8');
    console.log(`[INFO] Enrollment log written to: ${logPath}`);

    // Write zip
    if (zipFiles.length > 0) {
      writeZip(zipPath, zipFiles);
      console.log(`[INFO] Scripts zip written to: ${zipPath}`);
    }
  }

  const failed = results.filter(r => !r.ok).length;
  const succeeded = results.filter(r => r.ok).length;
  console.log(`\n[SUMMARY] ${succeeded} enrolled, ${failed} skipped${dryRun ? ' (DRY-RUN)' : ''}`);

  if (failed > 0 && succeeded === 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
