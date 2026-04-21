/**
 * Tests for FINDING-EXT-002 fix — sender-origin gate on the background
 * message listener.
 *
 * Strategy: import the exported helpers (UI_ONLY_MESSAGES, isUiOnlyMessage)
 * and replicate the gate logic in tests so we validate classification without
 * needing to bootstrap the full service-worker module (which pulls in chrome.*
 * APIs at module load time).
 *
 * Gate contract:
 *   - UI-only message + sender.tab defined  → reject {error:'unauthorized', reason:'content-script-forbidden'}
 *   - UI-only message + sender.tab undefined → allow (from popup/sidepanel)
 *   - Content-script-allowed message + sender.tab defined → allow
 *   - UI-only message + sender.id !== runtime.id → reject {reason:'cross-extension'}
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ─── Minimal chrome mock (hoisted so the background module can load) ──────────

vi.hoisted(() => {
  const mockRuntime = {
    id: 'test-extension-id',
    getManifest: () => ({ version: '0.24.0' }),
    onMessage: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    sendMessage: vi.fn(),
    getURL: vi.fn((p: string) => `chrome-extension://test-extension-id/${p}`),
    reload: vi.fn(),
  };
  const mockChrome = {
    runtime: mockRuntime,
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
      managed: { get: vi.fn(async () => ({})) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      create: vi.fn(async () => {}),
    },
    downloads: {
      download: vi.fn(async () => 1),
    },
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
  };
  (globalThis as unknown as Record<string, unknown>).chrome = mockChrome;
});

// ─── Import gate helpers after mock is installed ──────────────────────────────

import { UI_ONLY_MESSAGES, isUiOnlyMessage } from '../index.js';

// ─── Helper: simulate the gate as implemented in the listener ────────────────

type GateResult =
  | { allowed: true }
  | { allowed: false; response: { error: string; reason: string } };

function runGate(
  type: string,
  sender: { tab?: object; id?: string },
): GateResult {
  const ownId = 'test-extension-id';
  if (isUiOnlyMessage(type)) {
    if (sender.tab !== undefined) {
      return { allowed: false, response: { error: 'unauthorized', reason: 'content-script-forbidden' } };
    }
    if (sender.id !== ownId) {
      return { allowed: false, response: { error: 'unauthorized', reason: 'cross-extension' } };
    }
  }
  return { allowed: true };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('sender-validation — isUiOnlyMessage classification', () => {
  it('classifies SAVE_PROFILE as UI-only', () => {
    expect(isUiOnlyMessage('SAVE_PROFILE')).toBe(true);
  });

  it('classifies AI_SET_KEY as UI-only', () => {
    expect(isUiOnlyMessage('AI_SET_KEY')).toBe(true);
  });

  it('classifies VISION_CURATION_SAVE as UI-only', () => {
    expect(isUiOnlyMessage('VISION_CURATION_SAVE')).toBe(true);
  });

  it('classifies OBSERVATORY_ROTATE_KEY as UI-only', () => {
    expect(isUiOnlyMessage('OBSERVATORY_ROTATE_KEY')).toBe(true);
  });

  it('does NOT classify SIGNAL_BATCH as UI-only (content-script-allowed)', () => {
    expect(isUiOnlyMessage('SIGNAL_BATCH')).toBe(false);
  });

  it('does NOT classify GET_PROFILE as UI-only (query-only)', () => {
    expect(isUiOnlyMessage('GET_PROFILE')).toBe(false);
  });

  it('does NOT classify FUSION_INTENT_EMITTED as UI-only (content-script-allowed)', () => {
    expect(isUiOnlyMessage('FUSION_INTENT_EMITTED')).toBe(false);
  });

  it('does NOT classify unknown types as UI-only', () => {
    expect(isUiOnlyMessage('TOTALLY_UNKNOWN')).toBe(false);
  });
});

describe('sender-validation — gate allows SAVE_PROFILE from popup (sender.tab undefined)', () => {
  it('allows when tab is undefined and id matches', () => {
    const result = runGate('SAVE_PROFILE', { tab: undefined, id: 'test-extension-id' });
    expect(result.allowed).toBe(true);
  });
});

describe('sender-validation — gate rejects SAVE_PROFILE from content script (sender.tab defined)', () => {
  it('rejects with content-script-forbidden reason', () => {
    const result = runGate('SAVE_PROFILE', { tab: { id: 42 }, id: 'test-extension-id' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.response.error).toBe('unauthorized');
      expect(result.response.reason).toBe('content-script-forbidden');
    }
  });
});

describe('sender-validation — gate rejects AI_SET_KEY from content script', () => {
  it('rejects with content-script-forbidden reason', () => {
    const result = runGate('AI_SET_KEY', { tab: { id: 99 }, id: 'test-extension-id' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.response.reason).toBe('content-script-forbidden');
    }
  });
});

describe('sender-validation — gate allows SIGNAL_BATCH from content script (sender.tab defined)', () => {
  it('passes through when tab is defined', () => {
    const result = runGate('SIGNAL_BATCH', { tab: { id: 7 }, id: 'test-extension-id' });
    expect(result.allowed).toBe(true);
  });
});

describe('sender-validation — gate rejects UI-only message from external sender.id', () => {
  it('rejects with cross-extension reason when tab is undefined but id differs', () => {
    const result = runGate('SAVE_PROFILE', { tab: undefined, id: 'attacker-extension-id' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.response.error).toBe('unauthorized');
      expect(result.response.reason).toBe('cross-extension');
    }
  });
});

describe('sender-validation — UI_ONLY_MESSAGES set coverage', () => {
  const expectedUiOnly = [
    'SAVE_PROFILE', 'AI_SET_KEY', 'AI_CLEAR_KEY', 'ONNX_LOAD_TIER', 'ONNX_UNLOAD_TIER',
    'ONNX_CLEAR_CACHE', 'ONNX_SET_FORCE_FALLBACK', 'AGENT_SET_PSK', 'AGENT_CLEAR_PSK',
    'AGENT_APPLY_NATIVE', 'AGENT_REVERT_NATIVE', 'OBSERVATORY_ROTATE_KEY',
    'VISION_CURATION_SAVE', 'VISION_CURATION_DELETE', 'VISION_CURATION_CLEAR',
    'VISION_CURATION_EXPORT', 'CHECK_UPDATE', 'APPLY_UPDATE',
  ];

  for (const type of expectedUiOnly) {
    it(`includes ${type}`, () => {
      expect(UI_ONLY_MESSAGES.has(type)).toBe(true);
    });
  }

  const expectedContentAllowed = [
    'SIGNAL_BATCH', 'FUSION_INTENT_EMITTED', 'SUMMARIZE_TEXT', 'SUMMARIZE_EMAIL',
    'SIMPLIFY_TEXT', 'AI_READABILITY', 'INDIC_WHISPER_TRANSCRIBE',
    // Adversarial-review fix: gestures.ts sends TOGGLE_FEATURE from content,
    // action-items.ts sends ACTION_ITEMS_UPDATE from content. Background
    // handler must sanitize both.
    'TOGGLE_FEATURE', 'ACTION_ITEMS_UPDATE',
  ];

  for (const type of expectedContentAllowed) {
    it(`does NOT include content-allowed ${type}`, () => {
      expect(UI_ONLY_MESSAGES.has(type)).toBe(false);
    });
  }

  const expectedQueryOnly = [
    'GET_PROFILE', 'GET_STRUGGLE_SCORE', 'GET_ACTIVE_ADAPTATIONS', 'AI_GET_STATS',
    'AGENT_GET_STATUS', 'AGENT_HAS_PSK', 'ONNX_GET_STATUS', 'ENTERPRISE_GET_LOCKDOWN',
    'VISION_CURATION_LIST',
  ];

  for (const type of expectedQueryOnly) {
    it(`does NOT include query-only ${type}`, () => {
      expect(UI_ONLY_MESSAGES.has(type)).toBe(false);
    });
  }
});
