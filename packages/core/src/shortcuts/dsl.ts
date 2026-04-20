/**
 * AccessBridge — Typed Shortcut DSL (Priority 6)
 *
 * User-defined action chains. Syntax:
 *   step1 | step2:arg | step3
 *
 * Example:
 *   "summarize | translate:hi | speak"
 *   "simplify:strong | speak"
 *   "summarize | copy"
 *
 * Pipes (`|`) chain steps; colons (`:`) attach a single string arg per step.
 * Whitespace is ignored. Unknown actions and malformed shortcuts surface as
 * DSLParseError[] — the caller decides whether to refuse or run the valid
 * prefix.
 *
 * The runtime does not import anything from the browser — every side-effect
 * is dispatched through an injected `ShortcutExecutor` (wired in the content
 * script). Keeping the parser pure lets it live in `@accessbridge/core`
 * and be unit-tested in node.
 */

export const KNOWN_SHORTCUT_ACTIONS = [
  'summarize',
  'simplify',
  'translate',
  'speak',
  'copy',
  'read',
  'scroll-top',
  'scroll-bottom',
  'focus-mode',
  'reading-mode',
  'captions',
  'revert-all',
  'audit',
  'next-link',
  'prev-link',
  'click-focused',
] as const;

export type ShortcutAction = typeof KNOWN_SHORTCUT_ACTIONS[number];

export interface ShortcutStep {
  action: ShortcutAction;
  /** Optional single string argument passed with `:`. */
  arg: string | null;
}

export interface DSLParseError {
  stepIndex: number;
  raw: string;
  reason: 'unknown-action' | 'empty-step' | 'invalid-arg';
  message: string;
}

export interface ParsedShortcut {
  raw: string;
  steps: ShortcutStep[];
  errors: DSLParseError[];
  valid: boolean;
}

const ACTION_SET = new Set<string>(KNOWN_SHORTCUT_ACTIONS);

/**
 * Parse a DSL string into a typed chain. Never throws — errors land in the
 * returned report. A shortcut is `valid` iff there is at least one step and
 * no errors.
 */
export function parseShortcut(input: string): ParsedShortcut {
  const raw = (input || '').trim();
  if (raw.length === 0) {
    return {
      raw,
      steps: [],
      errors: [
        {
          stepIndex: 0,
          raw: '',
          reason: 'empty-step',
          message: 'Shortcut is empty.',
        },
      ],
      valid: false,
    };
  }

  const pieces = raw.split('|').map((s) => s.trim());
  const steps: ShortcutStep[] = [];
  const errors: DSLParseError[] = [];

  pieces.forEach((piece, index) => {
    if (piece.length === 0) {
      errors.push({
        stepIndex: index,
        raw: piece,
        reason: 'empty-step',
        message: `Step ${index + 1} is empty — remove the trailing pipe.`,
      });
      return;
    }

    const colonAt = piece.indexOf(':');
    const actionName = (colonAt === -1 ? piece : piece.slice(0, colonAt)).trim().toLowerCase();
    const rawArg = colonAt === -1 ? null : piece.slice(colonAt + 1).trim();

    if (!ACTION_SET.has(actionName)) {
      errors.push({
        stepIndex: index,
        raw: piece,
        reason: 'unknown-action',
        message: `Unknown action "${actionName}". Known actions: ${KNOWN_SHORTCUT_ACTIONS.join(', ')}.`,
      });
      return;
    }

    // Validate arg: non-empty if colon present; no pipe/colon re-use.
    if (rawArg !== null) {
      if (rawArg.length === 0) {
        errors.push({
          stepIndex: index,
          raw: piece,
          reason: 'invalid-arg',
          message: `Step "${actionName}" has a colon but no argument.`,
        });
        return;
      }
      if (/[|]/.test(rawArg)) {
        errors.push({
          stepIndex: index,
          raw: piece,
          reason: 'invalid-arg',
          message: `Argument for "${actionName}" cannot contain "|".`,
        });
        return;
      }
    }

    steps.push({
      action: actionName as ShortcutAction,
      arg: rawArg,
    });
  });

  return {
    raw,
    steps,
    errors,
    valid: steps.length > 0 && errors.length === 0,
  };
}

/**
 * Stringify a chain back to DSL form. Round-trips parseShortcut for valid
 * inputs (modulo whitespace normalisation).
 */
export function stringifyShortcut(steps: ShortcutStep[]): string {
  return steps
    .map((s) => (s.arg !== null ? `${s.action}:${s.arg}` : s.action))
    .join(' | ');
}

// ---------------------------------------------------------------------------
// Executor contract — the content script implements this.
// ---------------------------------------------------------------------------

export interface ShortcutExecutor {
  execute(step: ShortcutStep): Promise<void>;
}

/**
 * Run a parsed shortcut against an executor. Steps run sequentially; a
 * failing step rejects the whole chain but prior side-effects are kept.
 */
export async function runShortcut(
  parsed: ParsedShortcut,
  executor: ShortcutExecutor,
): Promise<void> {
  if (!parsed.valid) {
    throw new Error(
      `Cannot run invalid shortcut "${parsed.raw}": ${parsed.errors
        .map((e) => e.message)
        .join('; ')}`,
    );
  }
  for (const step of parsed.steps) {
    await executor.execute(step);
  }
}

// ---------------------------------------------------------------------------
// Saved shortcuts persistence (pure — caller supplies storage impl)
// ---------------------------------------------------------------------------

export interface SavedShortcut {
  id: string;
  name: string;
  dsl: string;
  /** Optional keyboard trigger, e.g. "Alt+1". */
  hotkey: string | null;
  createdAt: number;
  updatedAt: number;
}

export const SHORTCUTS_STORAGE_KEY = 'accessbridge_shortcuts_v1';

/**
 * Validate a SavedShortcut shape + its DSL content. Returns the parsed DSL
 * alongside any structural issues.
 */
export function validateSavedShortcut(s: SavedShortcut): {
  parsed: ParsedShortcut;
  structuralErrors: string[];
} {
  const structuralErrors: string[] = [];
  if (!s.id) structuralErrors.push('missing id');
  if (!s.name || s.name.length === 0) structuralErrors.push('name required');
  if (s.name && s.name.length > 60) structuralErrors.push('name too long (max 60)');
  if (s.hotkey !== null && s.hotkey && !/^(Ctrl|Alt|Shift|Meta)\+/i.test(s.hotkey)) {
    structuralErrors.push('hotkey must start with a modifier (Ctrl/Alt/Shift/Meta)');
  }
  const parsed = parseShortcut(s.dsl);
  return { parsed, structuralErrors };
}
