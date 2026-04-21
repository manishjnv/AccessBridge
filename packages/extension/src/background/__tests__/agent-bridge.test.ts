/**
 * Unit tests for AgentBridge (Session 19 Desktop Agent wiring).
 *
 * Mocks:
 *  - chrome.storage.local  → in-memory Map
 *  - chrome.runtime.getManifest → { version: '0.17.0' }
 *  - @accessbridge/core/ipc → AgentClient replaced with controllable test double
 *
 * 18 test cases covering start, PSK validation, connect state, profile push/pull,
 * native window listing, adaptation apply/revert, PSK rotation, and status
 * handler subscription/unsubscription.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Shared mock state (hoisted so the vi.mock factory can close over it) ─────

const mockState = vi.hoisted(() => ({
  /** All AgentClient instances constructed during the test. */
  instances: [] as ReturnType<typeof makeMockClientInstance>[],
  /** All setProfile call arguments (across all instances). */
  setProfileCalls: [] as unknown[],
}));

// ─── AgentClient test double ──────────────────────────────────────────────────

function makeMockClientInstance() {
  let __connected = false;
  let __stateHandler: ((s: string) => void) | null = null;
  let __pushHandler: ((msg: { profile?: unknown }) => void) | null = null;

  const inst = {
    __connected,
    __inspectResponse: [] as unknown[],
    __applyResponse: { ok: true, adaptationId: '' } as { ok: boolean; adaptationId: string; reason?: string },
    __revertResponse: true as boolean,
    __serverInfo: { version: '1.0.0', platform: 'windows', capabilities: ['profile-sync'] },

    isConnected: vi.fn(() => inst.__connected),
    getServerInfo: vi.fn(() => inst.__serverInfo),
    getAgentInfo: vi.fn(() => inst.__serverInfo),

    onState: vi.fn((handler: (s: string) => void) => {
      __stateHandler = handler;
      return () => { __stateHandler = null; };
    }),

    onPushFromAgent: vi.fn((handler: (msg: { profile?: unknown }) => void) => {
      __pushHandler = handler;
      return () => { __pushHandler = null; };
    }),

    connect: vi.fn(async () => {
      inst.__connected = true;
      // Reflect connected flag immediately so isConnected() returns true
      inst.isConnected.mockImplementation(() => inst.__connected);
      if (__stateHandler) __stateHandler('connected');
    }),

    dispose: vi.fn(() => {
      inst.__connected = false;
      inst.isConnected.mockImplementation(() => false);
    }),

    setProfile: vi.fn(async (p: unknown) => {
      mockState.setProfileCalls.push(p);
      return p;
    }),

    inspectNative: vi.fn(async () => inst.__inspectResponse),

    applyAdaptation: vi.fn(async (_t: unknown, a: { id: string }) => ({
      ...inst.__applyResponse,
      adaptationId: inst.__applyResponse.adaptationId || a.id,
    })),

    revertAdaptation: vi.fn(async (_id: string) => inst.__revertResponse),

    /** Test helper: emit a push-from-agent message. */
    __emitPush(msg: { profile?: unknown }) {
      if (__pushHandler) __pushHandler(msg);
    },

    /** Test helper: emit a state change. */
    __emitState(state: string) {
      if (__stateHandler) __stateHandler(state);
    },
  };

  return inst;
}

// ─── Module mock ─────────────────────────────────────────────────────────────

vi.mock('@accessbridge/core/ipc', async (importActual) => {
  const actual = await importActual<typeof import('@accessbridge/core/ipc')>();

  const MockAgentClient = vi.fn(function MockAgentClient(this: unknown) {
    const inst = makeMockClientInstance();
    mockState.instances.push(inst);
    // Copy all methods onto 'this' so new AgentClient(...) returns the instance shape.
    Object.assign(this as object, inst);
  });

  return {
    ...actual,
    AgentClient: MockAgentClient,
  };
});

// ─── Chrome stub ─────────────────────────────────────────────────────────────

function makeChromeStub() {
  const store = new Map<string, unknown>();

  return {
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          const val = store.get(key);
          return val !== undefined ? { [key]: val } : {};
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        }),
        remove: vi.fn(async (key: string) => {
          store.delete(key);
        }),
        // Expose the backing map for test assertions
        __store: store,
      },
    },
    runtime: {
      getManifest: vi.fn(() => ({ version: '0.17.0' })),
    },
  };
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

let chrome: ReturnType<typeof makeChromeStub>;

beforeEach(() => {
  chrome = makeChromeStub();
  vi.stubGlobal('chrome', chrome);
  // Browser-faithful atob: throws on non-base64 characters (unlike Node's Buffer.from
  // which silently ignores them).  This lets base64UrlDecode correctly throw for
  // invalid PSK inputs, matching production browser behaviour.
  vi.stubGlobal('atob', (s: string) => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('Invalid character');
    return Buffer.from(s, 'base64').toString('binary');
  });
  vi.stubGlobal('btoa', (s: string) => Buffer.from(s, 'binary').toString('base64'));
  // Reset shared mock state between tests
  mockState.instances.length = 0;
  mockState.setProfileCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── Import after mocks ───────────────────────────────────────────────────────

// Static top-level import — vi.mock() is hoisted so the mock factory runs before
// this import resolves.  We construct a fresh AgentBridge() per test so the
// `started` flag is always clean.
import { AgentBridge } from '../agent-bridge.js';

function importBridge() {
  return Promise.resolve(new AgentBridge());
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_PSK_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // 32 bytes, url-safe base64
const INVALID_PSK_B64 = 'not@@valid!!';

function lastInstance() {
  return mockState.instances[mockState.instances.length - 1];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AgentBridge', () => {
  it('1. start() with no PSK in storage → state stays idle, not connected, no AgentClient constructed', async () => {
    const bridge = await importBridge();
    // storage is empty → loadPskB64 returns null
    await bridge.start();
    const status = bridge.getStatus();
    expect(status.state).toBe('idle');
    expect(status.connected).toBe(false);
    expect(bridge.isConnected()).toBe(false);
    expect(mockState.instances).toHaveLength(0);
  });

  it('2. start() with valid PSK in storage → constructs AgentClient and calls connect()', async () => {
    const bridge = await importBridge();
    await chrome.storage.local.set({ agentPairKeyB64: VALID_PSK_B64 });
    await bridge.start();
    expect(mockState.instances).toHaveLength(1);
    expect(lastInstance().connect).toHaveBeenCalledOnce();
  });

  it('3. start() with malformed PSK → state becomes error, no AgentClient constructed', async () => {
    const bridge = await importBridge();
    await chrome.storage.local.set({ agentPairKeyB64: INVALID_PSK_B64 });
    await bridge.start();
    expect(mockState.instances).toHaveLength(0);
    const status = bridge.getStatus();
    expect(status.state).toBe('error');
    expect(status.lastError).toMatch(/invalid PSK/i);
  });

  it('4. start() called twice → second call is no-op, AgentClient constructed only once', async () => {
    const bridge = await importBridge();
    await chrome.storage.local.set({ agentPairKeyB64: VALID_PSK_B64 });
    await bridge.start();
    await bridge.start(); // second call
    expect(mockState.instances).toHaveLength(1);
    expect(lastInstance().connect).toHaveBeenCalledOnce();
  });

  it('5. successful connect → status handlers fire with connected:true and server info', async () => {
    const bridge = await importBridge();
    await chrome.storage.local.set({ agentPairKeyB64: VALID_PSK_B64 });

    const statuses: ReturnType<typeof bridge.getStatus>[] = [];
    bridge.onStatusChange((s: ReturnType<typeof bridge.getStatus>) => statuses.push({ ...s }));
    await bridge.start();

    // At least one status emission with connected:true
    const connectedStatus = statuses.find((s) => s.connected);
    expect(connectedStatus).toBeDefined();
    expect(connectedStatus!.state).toBe('connected');
    expect(connectedStatus!.server).toBeDefined();
    expect(connectedStatus!.server?.version).toBe('1.0.0');
    expect(connectedStatus!.server?.platform).toBe('windows');
  });

  it('6. onProfilePushFromAgent callback fires when mock client pushes PROFILE_UPDATED', async () => {
    const bridge = await importBridge();
    await chrome.storage.local.set({ agentPairKeyB64: VALID_PSK_B64 });

    const receivedProfiles: unknown[] = [];
    await bridge.start({
      onProfilePushFromAgent: (p: unknown) => receivedProfiles.push(p),
    });

    const fakeProfile = { userId: 'u1', settings: { fontSize: 18 } };
    lastInstance().__emitPush({ profile: fakeProfile });

    expect(receivedProfiles).toHaveLength(1);
    expect(receivedProfiles[0]).toEqual(fakeProfile);
  });

  it('7. profile push with non-object profile is silently ignored (no handler call)', async () => {
    const bridge = await importBridge();
    await chrome.storage.local.set({ agentPairKeyB64: VALID_PSK_B64 });

    const receivedProfiles: unknown[] = [];
    await bridge.start({
      onProfilePushFromAgent: (p: unknown) => receivedProfiles.push(p),
    });

    // non-object profile values
    lastInstance().__emitPush({ profile: 'just a string' });
    lastInstance().__emitPush({ profile: 42 });
    lastInstance().__emitPush({});  // no profile key

    expect(receivedProfiles).toHaveLength(0);
  });

  it('8. syncProfileOut when connected → calls client.setProfile(profile)', async () => {
    const bridge = await importBridge();
    await chrome.storage.local.set({ agentPairKeyB64: VALID_PSK_B64 });
    await bridge.start();

    const profile = { userId: 'u2', settings: {} } as never;
    await bridge.syncProfileOut(profile);

    // setProfile called once from syncProfileOut (plus potentially from start's local push,
    // but since getLocalProfile is not set in this test, only one call from syncProfileOut)
    const setProfileInstance = lastInstance().setProfile;
    expect(setProfileInstance).toHaveBeenCalledWith(profile);
  });

  it('9. syncProfileOut when NOT connected → resolves silently, no call to client', async () => {
    const bridge = await importBridge();
    // No PSK in storage → bridge stays idle / not connected

    const profile = { userId: 'u3', settings: {} } as never;
    await expect(bridge.syncProfileOut(profile)).resolves.toBeUndefined();
    expect(mockState.instances).toHaveLength(0);
    expect(mockState.setProfileCalls).toHaveLength(0);
  });

  it('10. syncProfileOut when client.setProfile throws → resolves silently (non-fatal)', async () => {
    const bridge = await importBridge();
    await chrome.storage.local.set({ agentPairKeyB64: VALID_PSK_B64 });
    await bridge.start();

    lastInstance().setProfile.mockRejectedValueOnce(new Error('network gone'));

    const profile = { userId: 'u4', settings: {} } as never;
    await expect(bridge.syncProfileOut(profile)).resolves.toBeUndefined();
  });

  it('11. listNativeWindows() when connected returns inspectNative response', async () => {
    const bridge = await importBridge();
    await chrome.storage.local.set({ agentPairKeyB64: VALID_PSK_B64 });
    await bridge.start();

    const fakeElements = [{ processName: 'notepad.exe', windowTitle: 'Notepad', className: 'Edit', automationId: '', controlType: 'Text', boundingRect: { x: 0, y: 0, width: 100, height: 50 } }];
    lastInstance().__inspectResponse = fakeElements;

    const result = await bridge.listNativeWindows();
    expect(result).toEqual(fakeElements);
  });

  it('12. listNativeWindows() when NOT connected returns []', async () => {
    const bridge = await importBridge();
    // No PSK → not connected
    const result = await bridge.listNativeWindows();
    expect(result).toEqual([]);
  });

  it('13. applyNativeAdaptation when NOT connected returns {ok:false, reason:"agent not connected"}', async () => {
    const bridge = await importBridge();
    // No PSK → not connected

    const result = await bridge.applyNativeAdaptation(
      { processName: 'calc.exe' },
      { id: 'adapt-1', kind: 'font-scale', value: 1.5 },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('agent not connected');
    expect(result.adaptationId).toBe('adapt-1');
  });

  it('14. setPskFromBase64(newKey) writes storage and reconstructs client with new PSK bytes', async () => {
    const bridge = await importBridge();
    // Start with no PSK
    await bridge.start();
    expect(mockState.instances).toHaveLength(0);

    // Now set a PSK
    await bridge.setPskFromBase64(VALID_PSK_B64);

    // Storage should have the new key
    const stored = await chrome.storage.local.get('agentPairKeyB64');
    expect(stored['agentPairKeyB64']).toBe(VALID_PSK_B64);

    // A new client should have been constructed and connect() called
    expect(mockState.instances).toHaveLength(1);
    expect(lastInstance().connect).toHaveBeenCalledOnce();
  });

  it('15. clearPsk() removes storage key and disposes client, state → idle', async () => {
    const bridge = await importBridge();
    await chrome.storage.local.set({ agentPairKeyB64: VALID_PSK_B64 });
    await bridge.start();
    expect(mockState.instances).toHaveLength(1);

    await bridge.clearPsk();

    // Storage key removed
    const stored = await chrome.storage.local.get('agentPairKeyB64');
    expect(stored['agentPairKeyB64']).toBeUndefined();

    // Client disposed
    expect(lastInstance().dispose).toHaveBeenCalledOnce();

    // State back to idle
    const status = bridge.getStatus();
    expect(status.state).toBe('idle');
    expect(status.connected).toBe(false);
  });

  it('16. hasPsk() reflects storage presence', async () => {
    const bridge = await importBridge();
    expect(await bridge.hasPsk()).toBe(false);

    await chrome.storage.local.set({ agentPairKeyB64: VALID_PSK_B64 });
    expect(await bridge.hasPsk()).toBe(true);

    await chrome.storage.local.remove('agentPairKeyB64');
    expect(await bridge.hasPsk()).toBe(false);
  });

  it('17. getStatus() returns a defensive copy — mutating it does not affect internal state', async () => {
    const bridge = await importBridge();
    await bridge.start();

    const snap1 = bridge.getStatus();
    snap1.connected = true;        // mutate the copy
    snap1.lastError = 'tampered';

    const snap2 = bridge.getStatus();
    expect(snap2.connected).toBe(false);  // original state unchanged
    expect(snap2.lastError).toBeNull();
  });

  // ─── Session 21: agentInfo tests ─────────────────────────────────────────

  it('19. getAgentInfo() returns null before any connection is made', async () => {
    const bridge = await importBridge();
    await bridge.start(); // no PSK → idle
    expect(bridge.getAgentInfo()).toBeNull();
  });

  it('20. getAgentInfo() returns the server info from HELLO_ACK after successful connect', async () => {
    const bridge = await importBridge();
    await chrome.storage.local.set({ agentPairKeyB64: VALID_PSK_B64 });
    await bridge.start();

    const info = bridge.getAgentInfo();
    expect(info).not.toBeNull();
    expect(info?.platform).toBe('windows');
    expect(info?.version).toBe('1.0.0');
    expect(Array.isArray(info?.capabilities)).toBe(true);
  });

  it('21. agentInfo is persisted to chrome.storage on successful connect', async () => {
    const bridge = await importBridge();
    await chrome.storage.local.set({ agentPairKeyB64: VALID_PSK_B64 });
    await bridge.start();

    // Give the async storage.set a tick to complete
    await Promise.resolve();

    const stored = await chrome.storage.local.get('agentLastKnownInfo');
    const persisted = stored['agentLastKnownInfo'] as { platform: string; version: string } | undefined;
    expect(persisted).toBeDefined();
    expect(persisted?.platform).toBe('windows');
    expect(persisted?.version).toBe('1.0.0');
  });

  it('22. AGENT_GET_STATUS response shape includes agentInfo field', async () => {
    const bridge = await importBridge();
    await chrome.storage.local.set({ agentPairKeyB64: VALID_PSK_B64 });
    await bridge.start();

    const status = bridge.getStatus();
    // agentInfo is a required field of AgentStatus — must be present (connected case)
    expect(Object.prototype.hasOwnProperty.call(status, 'agentInfo')).toBe(true);
    expect(status.agentInfo?.platform).toBe('windows');
  });

  it('18. status handler fires on connect; unsubscribe stops further calls', async () => {
    const bridge = await importBridge();
    await chrome.storage.local.set({ agentPairKeyB64: VALID_PSK_B64 });

    const calls: ReturnType<typeof bridge.getStatus>[] = [];
    const unsub = bridge.onStatusChange((s: ReturnType<typeof bridge.getStatus>) => calls.push({ ...s }));

    await bridge.start();

    // Should have fired at least once with connected:true
    const before = calls.length;
    expect(before).toBeGreaterThanOrEqual(1);
    expect(calls.some((s) => s.connected)).toBe(true);

    // Unsubscribe
    unsub();

    // Emit a state change via the mock — should NOT trigger our handler anymore
    lastInstance().__emitState('disconnected');

    expect(calls.length).toBe(before);  // no new calls after unsub
  });
});
