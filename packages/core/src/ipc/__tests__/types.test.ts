import { describe, it, expect } from 'vitest';
import { isAgentMessage, newRequestId, type AgentMessage } from '../types.js';

const VALID_TYPES = [
  'HELLO',
  'HELLO_ACK',
  'PROFILE_GET',
  'PROFILE_SET',
  'PROFILE_RESULT',
  'PROFILE_UPDATED',
  'ADAPTATION_APPLY',
  'ADAPTATION_APPLY_RESULT',
  'ADAPTATION_REVERT',
  'ADAPTATION_REVERT_RESULT',
  'UIA_INSPECT',
  'UIA_ELEMENTS',
  'PING',
  'PONG',
  'ERROR',
] as const;

describe('isAgentMessage', () => {
  it('accepts all 15 valid discriminators', () => {
    for (const t of VALID_TYPES) {
      expect(isAgentMessage({ type: t }), `type=${t}`).toBe(true);
    }
  });

  it('rejects { type: "HACK" }', () => {
    expect(isAgentMessage({ type: 'HACK' })).toBe(false);
  });

  it('rejects null', () => {
    expect(isAgentMessage(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isAgentMessage(undefined)).toBe(false);
  });

  it('rejects empty object', () => {
    expect(isAgentMessage({})).toBe(false);
  });

  it('rejects a plain string', () => {
    expect(isAgentMessage('PING')).toBe(false);
  });

  it('rejects a number', () => {
    expect(isAgentMessage(42)).toBe(false);
  });
});

describe('newRequestId', () => {
  it('returns two distinct strings in rapid succession', () => {
    // Suppress randomUUID if needed by running quickly
    const a = newRequestId();
    const b = newRequestId();
    expect(typeof a).toBe('string');
    expect(typeof b).toBe('string');
    expect(a).not.toBe(b);
  });

  it('matches UUID format or req-... fallback format', () => {
    const id = newRequestId();
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const fallbackRe = /^req-[0-9a-z]+-[0-9a-z]+$/;
    expect(uuidRe.test(id) || fallbackRe.test(id)).toBe(true);
  });
});

describe('type guard narrowing', () => {
  it('narrows PROFILE_RESULT and allows accessing .profile', () => {
    const raw: unknown = { type: 'PROFILE_RESULT', requestId: 'x', profile: 42 };
    if (isAgentMessage(raw) && raw.type === 'PROFILE_RESULT') {
      // TypeScript should allow this without error
      const p: unknown = raw.profile;
      expect(p).toBe(42);
    } else {
      throw new Error('guard did not narrow');
    }
  });
});
