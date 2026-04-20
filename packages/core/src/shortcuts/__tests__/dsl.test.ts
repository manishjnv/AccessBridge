import { describe, it, expect } from 'vitest';
import {
  parseShortcut,
  stringifyShortcut,
  runShortcut,
  validateSavedShortcut,
  KNOWN_SHORTCUT_ACTIONS,
  type SavedShortcut,
  type ShortcutExecutor,
} from '../dsl.js';

describe('parseShortcut', () => {
  it('parses a single action', () => {
    const r = parseShortcut('summarize');
    expect(r.valid).toBe(true);
    expect(r.steps).toEqual([{ action: 'summarize', arg: null }]);
    expect(r.errors).toEqual([]);
  });

  it('parses a three-step chain', () => {
    const r = parseShortcut('summarize | translate:hi | speak');
    expect(r.valid).toBe(true);
    expect(r.steps).toEqual([
      { action: 'summarize', arg: null },
      { action: 'translate', arg: 'hi' },
      { action: 'speak', arg: null },
    ]);
  });

  it('ignores whitespace around pipes and colons', () => {
    const r = parseShortcut('  summarize   |    translate : hi   ');
    expect(r.valid).toBe(true);
    expect(r.steps[1]).toEqual({ action: 'translate', arg: 'hi' });
  });

  it('is case-insensitive on action names', () => {
    const r = parseShortcut('SUMMARIZE | Translate:HI');
    expect(r.valid).toBe(true);
    expect(r.steps[0].action).toBe('summarize');
    expect(r.steps[1].action).toBe('translate');
    // arg keeps original casing
    expect(r.steps[1].arg).toBe('HI');
  });

  it('flags unknown actions', () => {
    const r = parseShortcut('summarize | eat-lunch');
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toBe('unknown-action');
    // valid prefix still recorded
    expect(r.steps).toEqual([{ action: 'summarize', arg: null }]);
  });

  it('flags an empty step (trailing pipe)', () => {
    const r = parseShortcut('summarize |');
    expect(r.valid).toBe(false);
    expect(r.errors[0].reason).toBe('empty-step');
  });

  it('flags a colon with no arg', () => {
    const r = parseShortcut('translate:');
    expect(r.valid).toBe(false);
    expect(r.errors[0].reason).toBe('invalid-arg');
  });

  it('flags an empty shortcut', () => {
    const r = parseShortcut('');
    expect(r.valid).toBe(false);
    expect(r.errors[0].reason).toBe('empty-step');
  });

  it('supports all known actions', () => {
    for (const action of KNOWN_SHORTCUT_ACTIONS) {
      const r = parseShortcut(action);
      expect(r.valid).toBe(true);
      expect(r.steps[0].action).toBe(action);
    }
  });
});

describe('stringifyShortcut', () => {
  it('round-trips a parsed chain', () => {
    const original = 'summarize | translate:hi | speak';
    const parsed = parseShortcut(original);
    expect(stringifyShortcut(parsed.steps)).toBe('summarize | translate:hi | speak');
  });

  it('handles a single action', () => {
    expect(stringifyShortcut([{ action: 'captions', arg: null }])).toBe('captions');
  });
});

describe('runShortcut', () => {
  it('invokes the executor once per step in order', async () => {
    const calls: string[] = [];
    const exec: ShortcutExecutor = {
      async execute(step) {
        calls.push(step.arg ? `${step.action}:${step.arg}` : step.action);
      },
    };
    await runShortcut(parseShortcut('summarize | translate:hi | speak'), exec);
    expect(calls).toEqual(['summarize', 'translate:hi', 'speak']);
  });

  it('rejects invalid shortcuts before running anything', async () => {
    const calls: string[] = [];
    const exec: ShortcutExecutor = {
      async execute(step) {
        calls.push(step.action);
      },
    };
    await expect(runShortcut(parseShortcut(''), exec)).rejects.toThrow(/invalid shortcut/);
    expect(calls).toEqual([]);
  });

  it('propagates executor errors but keeps prior side effects', async () => {
    const calls: string[] = [];
    const exec: ShortcutExecutor = {
      async execute(step) {
        calls.push(step.action);
        if (step.action === 'translate') throw new Error('boom');
      },
    };
    await expect(
      runShortcut(parseShortcut('summarize | translate:hi | speak'), exec),
    ).rejects.toThrow('boom');
    expect(calls).toEqual(['summarize', 'translate']);
  });
});

describe('validateSavedShortcut', () => {
  const base: SavedShortcut = {
    id: 'abc',
    name: 'Summarise in Hindi',
    dsl: 'summarize | translate:hi | speak',
    hotkey: 'Alt+1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  it('passes for a complete, well-formed shortcut', () => {
    const v = validateSavedShortcut(base);
    expect(v.structuralErrors).toEqual([]);
    expect(v.parsed.valid).toBe(true);
  });

  it('flags empty name', () => {
    expect(
      validateSavedShortcut({ ...base, name: '' }).structuralErrors,
    ).toContain('name required');
  });

  it('flags missing id', () => {
    expect(
      validateSavedShortcut({ ...base, id: '' }).structuralErrors,
    ).toContain('missing id');
  });

  it('flags a hotkey without a modifier', () => {
    expect(
      validateSavedShortcut({ ...base, hotkey: 'A' }).structuralErrors,
    ).toContain('hotkey must start with a modifier (Ctrl/Alt/Shift/Meta)');
  });

  it('accepts a null hotkey', () => {
    expect(
      validateSavedShortcut({ ...base, hotkey: null }).structuralErrors,
    ).toEqual([]);
  });
});
