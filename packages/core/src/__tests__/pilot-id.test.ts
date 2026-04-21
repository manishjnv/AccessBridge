/**
 * Session 24 — PILOT_ID_PATTERN validator tests.
 *
 * Pilot IDs flow from Team install scripts AND managed policy INTO published
 * observatory bundles, so this gate is load-bearing — a malformed value must
 * be rejected at every entry point before it touches the wire. The pattern
 * is the tightest validator in the extension: lowercase + digits + hyphens,
 * 1..64 chars, must start with alphanumeric.
 */

import { describe, expect, it } from 'vitest';
import { PILOT_ID_PATTERN, isValidPilotId } from '../types/profile.js';

describe('PILOT_ID_PATTERN', () => {
  describe('accepts', () => {
    it.each([
      ['pilot-default', 'basic preset name'],
      ['pilot-tamil', 'language preset'],
      ['pilot-fatigue-study-2026', 'multi-segment with year'],
      ['a', 'single char'],
      ['a1', 'alpha+digit'],
      ['1', 'single digit'],
      ['0-a', 'starts with digit'],
      ['a'.repeat(64), 'exactly 64 chars'],
    ])('%s (%s)', (value) => {
      expect(PILOT_ID_PATTERN.test(value)).toBe(true);
      expect(isValidPilotId(value)).toBe(true);
    });
  });

  describe('rejects', () => {
    it.each([
      ['', 'empty string'],
      ['a'.repeat(65), '65 chars (too long)'],
      ['Pilot-Tamil', 'uppercase'],
      ['pilot_default', 'underscore'],
      ['pilot.default', 'dot'],
      ['pilot/default', 'slash (path traversal)'],
      ['../etc/passwd', 'path traversal'],
      ['pilot default', 'space'],
      ['pilot-default\n', 'trailing newline'],
      ['pilot-default\t', 'tab'],
      ['-pilot', 'starts with hyphen'],
      ['pilot;rm', 'shell metacharacter'],
      ['pilot$id', 'shell variable expansion'],
      ['pilot`id`', 'backtick'],
      ['pilot\x00id', 'NUL byte'],
      ['pilot‮pd', 'Unicode right-to-left override (bidi)'],
      ['pilot​id', 'zero-width space'],
      ['pilot-🎯', 'emoji'],
      ['pilot-café', 'non-ASCII accented'],
    ])('%s (%s)', (value) => {
      expect(PILOT_ID_PATTERN.test(value)).toBe(false);
      expect(isValidPilotId(value)).toBe(false);
    });
  });

  describe('isValidPilotId proto-pollution guards', () => {
    it.each([
      [null, 'null'],
      [undefined, 'undefined'],
      [123, 'number'],
      [{}, 'object'],
      [[], 'array'],
      [true, 'boolean'],
      [Symbol('pilot'), 'symbol'],
    ])('rejects %s (%s)', (value, _label) => {
      expect(isValidPilotId(value)).toBe(false);
    });

    it('documents the case-based rejection of most Object.prototype method names', () => {
      // "toString" / "hasOwnProperty" contain uppercase → fail pattern.
      // "__proto__" contains underscore → fails pattern.
      expect(isValidPilotId('toString')).toBe(false);
      expect(isValidPilotId('hasOwnProperty')).toBe(false);
      expect(isValidPilotId('__proto__')).toBe(false);
    });

    it('accepts "constructor" as a pilot name (all-lowercase, no underscore)', () => {
      // "constructor" IS pattern-valid — it's a legitimate English word that
      // fits the [a-z0-9-] grammar. This is a known non-issue as long as every
      // consumer keyed by pilotId uses Map, Set, or Object.hasOwn (never a
      // bare `in` / `obj[pilotId]` on a prototype-chain-exposing object).
      // BUG-015 precedent: if any consumer ever reads `someMap[pilotId]` on a
      // plain object, this test flips to expect false and the pattern gains
      // an explicit `/^(?!(constructor|hasOwnProperty|...))/` anchor — but
      // tightening the pattern for a problem that doesn't exist is not worth
      // the surface-area cost. Grep gate: any `[pilotId]` indexing MUST use
      // a Map or Object.hasOwn — no plain-object subscript access.
      expect(isValidPilotId('constructor')).toBe(true);
    });
  });
});
