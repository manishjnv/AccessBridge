import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentClient, type ConnectionState, type AgentClientOptions } from '../client.js';
import type { AgentMessage, NativeTargetHint, NativeAdaptation, NativeElementInfo } from '../types.js';

// ---------------------------------------------------------------------------
// MockWebSocket — minimal WebSocket API shim
// ---------------------------------------------------------------------------

type EventName = 'open' | 'message' | 'close' | 'error';

class MockWebSocket {
  readonly url: string;
  readyState: number = 0; // CONNECTING
  sent: string[] = [];

  private listeners = new Map<EventName, Set<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(event: EventName, listener: (ev: unknown) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }

  removeEventListener(event: EventName, listener: (ev: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.__dispatch('close', {});
  }

  // ---- Test helpers ----

  __open(): void {
    this.readyState = 1; // OPEN
    this.__dispatch('open', {});
  }

  __serverSend(data: string): void {
    this.__dispatch('message', { data });
  }

  __serverClose(): void {
    this.readyState = 3;
    this.__dispatch('close', {});
  }

  __error(): void {
    this.__dispatch('error', { type: 'error' });
  }

  private __dispatch(event: EventName, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: build a connected AgentClient with mock WS
// ---------------------------------------------------------------------------

function makePsk(): Uint8Array {
  return new Uint8Array(32).fill(1);
}

/**
 * Box that lazily holds the last-created MockWebSocket.
 * Use box.ws to access it after connect() fires the factory.
 */
interface MockBox { ws: MockWebSocket }

function setupClient(overrides: AgentClientOptions = {}): { client: AgentClient; box: MockBox; factory: ReturnType<typeof vi.fn> } {
  const box: MockBox = { ws: null as unknown as MockWebSocket };
  const factory = vi.fn((url: string) => {
    box.ws = new MockWebSocket(url);
    return box.ws as unknown as WebSocket;
  });

  const options: AgentClientOptions = {
    psk: makePsk(),
    webSocketFactory: factory,
    requestTimeoutMs: 5000,
    reconnectMinMs: 1000,
    reconnectMaxMs: 30000,
    ...overrides,
    // factory must not be overwritten by overrides — apply overrides first then re-set factory
  };
  // Restore factory in case overrides tried to override it
  options.webSocketFactory = factory;

  const client = new AgentClient(options);
  return { client, box, factory };
}

/** Perform a full handshake: open WS → client sends HELLO → ack with pskOk:true */
async function doHandshake(client: AgentClient, box: MockBox): Promise<void> {
  const connectP = client.connect();
  // Flush microtasks so client creates the WS and registers listeners
  await flushMicrotasks();
  box.ws.__open();
  // Wait for client to send HELLO
  await waitFor(() => box.ws.sent.length > 0);
  const helloAck: AgentMessage = {
    type: 'HELLO_ACK',
    pskOk: true,
    server: { version: '0.1.0', platform: 'windows', capabilities: ['uia'] },
  };
  box.ws.__serverSend(JSON.stringify(helloAck));
  await connectP;
}

/** Flush the microtask queue multiple times to allow chained promises to settle. */
async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/** Poll until predicate returns true (max 200 iterations, 1ms each via real timers). */
async function waitFor(pred: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  if (!pred()) throw new Error('waitFor timed out');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentClient — no PSK', () => {
  it('connect() resolves and state stays idle when no PSK provided', async () => {
    const client = new AgentClient({ requestTimeoutMs: 5000 });
    await client.connect();
    expect(client.getState()).toBe('idle');
    client.dispose();
  });
});

describe('AgentClient — handshake', () => {
  let client: AgentClient;
  let box: MockBox;
  let factory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ client, box, factory } = setupClient());
  });

  afterEach(() => {
    client.dispose();
  });

  it('transitions idle → connecting → handshaking before HELLO_ACK', async () => {
    const states: ConnectionState[] = [];
    client.onState((s) => states.push(s));

    const connectP = client.connect();
    await flushMicrotasks();
    expect(states).toContain('connecting');

    box.ws.__open();
    await waitFor(() => box.ws.sent.length > 0);
    expect(states).toContain('handshaking');

    // Complete handshake to avoid leaking promises
    const ack: AgentMessage = { type: 'HELLO_ACK', pskOk: true, server: { version: '0.1.0', platform: 'windows', capabilities: [] } };
    box.ws.__serverSend(JSON.stringify(ack));
    await connectP;
  });

  it('sends HELLO with 64-char hex pskHash and a nonce after WS open', async () => {
    const connectP = client.connect();
    await flushMicrotasks();
    box.ws.__open();
    await waitFor(() => box.ws.sent.length > 0);

    const hello = JSON.parse(box.ws.sent[0]) as Record<string, unknown>;
    expect(hello.type).toBe('HELLO');
    expect(typeof hello.pskHash).toBe('string');
    expect((hello.pskHash as string).length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(hello.pskHash as string)).toBe(true);
    expect(typeof hello.nonce).toBe('string');
    expect((hello.nonce as string).length).toBeGreaterThan(0);

    // Finish handshake
    const ack: AgentMessage = { type: 'HELLO_ACK', pskOk: true, server: { version: '0.1.0', platform: 'windows', capabilities: [] } };
    box.ws.__serverSend(JSON.stringify(ack));
    await connectP;
  });

  it('transitions to connected and stores serverInfo after pskOk:true ACK', async () => {
    await doHandshake(client, box);
    expect(client.getState()).toBe('connected');
    expect(client.getServerInfo()).toEqual({ version: '0.1.0', platform: 'windows', capabilities: ['uia'] });
  });

  it('transitions to disconnected when pskOk:false', async () => {
    const states: ConnectionState[] = [];
    client.onState((s) => states.push(s));

    const connectP = client.connect().catch(() => {});
    await flushMicrotasks();
    box.ws.__open();
    await waitFor(() => box.ws.sent.length > 0);

    const ack: AgentMessage = { type: 'HELLO_ACK', pskOk: false, server: { version: '0.1.0', platform: 'windows', capabilities: [] } };
    box.ws.__serverSend(JSON.stringify(ack));
    await connectP;

    expect(states).toContain('disconnected');
  });
});

describe('AgentClient — request/response', () => {
  let client: AgentClient;
  let box: MockBox;

  beforeEach(async () => {
    ({ client, box } = setupClient());
    await doHandshake(client, box);
  });

  afterEach(() => {
    client.dispose();
  });

  it('ping() sends PING and resolves when matching PONG arrives', async () => {
    const pingP = client.ping();
    await waitFor(() => box.ws.sent.length > 1);

    const sent = JSON.parse(box.ws.sent[box.ws.sent.length - 1]) as { type: string; requestId: string };
    expect(sent.type).toBe('PING');

    const pong: AgentMessage = { type: 'PONG', requestId: sent.requestId };
    box.ws.__serverSend(JSON.stringify(pong));
    await pingP;
  });

  it('getProfile() round-trip returns the profile from PROFILE_RESULT', async () => {
    const profileP = client.getProfile();
    await waitFor(() => box.ws.sent.length > 1);

    const sent = JSON.parse(box.ws.sent[box.ws.sent.length - 1]) as { type: string; requestId: string };
    expect(sent.type).toBe('PROFILE_GET');

    const result: AgentMessage = { type: 'PROFILE_RESULT', requestId: sent.requestId, profile: { foo: 42 } };
    box.ws.__serverSend(JSON.stringify(result));

    const profile = await profileP;
    expect(profile).toEqual({ foo: 42 });
  });

  it('setProfile({a:1}) sends PROFILE_SET and returns echoed profile', async () => {
    const setP = client.setProfile({ a: 1 });
    await waitFor(() => box.ws.sent.length > 1);

    const sent = JSON.parse(box.ws.sent[box.ws.sent.length - 1]) as { type: string; requestId: string; profile: unknown };
    expect(sent.type).toBe('PROFILE_SET');
    expect(sent.profile).toEqual({ a: 1 });

    const result: AgentMessage = { type: 'PROFILE_RESULT', requestId: sent.requestId, profile: { a: 1 } };
    box.ws.__serverSend(JSON.stringify(result));

    const returned = await setP;
    expect(returned).toEqual({ a: 1 });
  });

  it('inspectNative() sends UIA_INSPECT and returns elements array', async () => {
    const target: NativeTargetHint = { processName: 'notepad.exe' };
    const inspectP = client.inspectNative(target);
    await waitFor(() => box.ws.sent.length > 1);

    const sent = JSON.parse(box.ws.sent[box.ws.sent.length - 1]) as { type: string; requestId: string; target: unknown };
    expect(sent.type).toBe('UIA_INSPECT');
    expect(sent.target).toEqual(target);

    const elements: NativeElementInfo[] = [
      { processName: 'notepad.exe', windowTitle: 'Untitled', className: 'Edit', automationId: 'edit1', controlType: 'Document', boundingRect: { x: 0, y: 0, width: 800, height: 600 } },
      { processName: 'notepad.exe', windowTitle: 'Untitled', className: 'StatusBar', automationId: 'status1', controlType: 'StatusBar', boundingRect: { x: 0, y: 600, width: 800, height: 20 } },
    ];
    const result: AgentMessage = { type: 'UIA_ELEMENTS', requestId: sent.requestId, elements };
    box.ws.__serverSend(JSON.stringify(result));

    const returned = await inspectP;
    expect(returned).toEqual(elements);
  });

  it('applyAdaptation() sends ADAPTATION_APPLY and returns result', async () => {
    const target: NativeTargetHint = { processName: 'calc.exe' };
    const adaptation: NativeAdaptation = { id: 'a', kind: 'font-scale', value: 1.2 };
    const applyP = client.applyAdaptation(target, adaptation);
    await waitFor(() => box.ws.sent.length > 1);

    const sent = JSON.parse(box.ws.sent[box.ws.sent.length - 1]) as { type: string; requestId: string };
    expect(sent.type).toBe('ADAPTATION_APPLY');

    const result: AgentMessage = { type: 'ADAPTATION_APPLY_RESULT', requestId: sent.requestId, adaptationId: 'a', ok: true };
    box.ws.__serverSend(JSON.stringify(result));

    const returned = await applyP;
    expect(returned).toEqual({ adaptationId: 'a', ok: true, reason: undefined });
  });

  it('revertAdaptation() round-trip resolves true on ok:true', async () => {
    const revertP = client.revertAdaptation('a1');
    await waitFor(() => box.ws.sent.length > 1);

    const sent = JSON.parse(box.ws.sent[box.ws.sent.length - 1]) as { type: string; requestId: string; adaptationId: string };
    expect(sent.type).toBe('ADAPTATION_REVERT');
    expect(sent.adaptationId).toBe('a1');

    const result: AgentMessage = { type: 'ADAPTATION_REVERT_RESULT', requestId: sent.requestId, ok: true };
    box.ws.__serverSend(JSON.stringify(result));

    expect(await revertP).toBe(true);
  });

  it('ERROR response rejects the pending request', async () => {
    const pingP = client.ping();
    await waitFor(() => box.ws.sent.length > 1);

    const sent = JSON.parse(box.ws.sent[box.ws.sent.length - 1]) as { requestId: string };
    const errMsg: AgentMessage = { type: 'ERROR', requestId: sent.requestId, code: 'NOT_FOUND', message: 'no such element' };
    box.ws.__serverSend(JSON.stringify(errMsg));

    await expect(pingP).rejects.toThrow('NOT_FOUND: no such element');
  });
});

describe('AgentClient — push & state events', () => {
  let client: AgentClient;
  let box: MockBox;

  beforeEach(async () => {
    ({ client, box } = setupClient());
    await doHandshake(client, box);
  });

  afterEach(() => {
    client.dispose();
  });

  it('onPushFromAgent fires when server sends PROFILE_UPDATED', async () => {
    const received: unknown[] = [];
    client.onPushFromAgent((msg) => received.push(msg.profile));

    const push: AgentMessage = { type: 'PROFILE_UPDATED', profile: { updated: true } };
    box.ws.__serverSend(JSON.stringify(push));
    await Promise.resolve();

    expect(received).toEqual([{ updated: true }]);
  });

  it('onState fires for each state transition', async () => {
    const states: ConnectionState[] = [];
    client.onState((s) => states.push(s));

    box.ws.__serverClose();
    await Promise.resolve();

    expect(states).toContain('disconnected');
  });
});

describe('AgentClient — timeouts & reconnect', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ping() rejects after requestTimeoutMs with fake timers', async () => {
    // Establish the connection using real timers (PSK hash is async, needs real microtasks)
    const box: MockBox = { ws: null as unknown as MockWebSocket };
    const options: AgentClientOptions = {
      psk: makePsk(),
      requestTimeoutMs: 5000,
      reconnectMinMs: 60000, // long so reconnect doesn't race
      reconnectMaxMs: 120000,
      webSocketFactory: (url: string) => {
        box.ws = new MockWebSocket(url);
        return box.ws as unknown as WebSocket;
      },
    };
    const client = new AgentClient(options);
    await doHandshake(client, box);
    expect(client.getState()).toBe('connected');

    // Now switch to fake timers — setTimeout/clearTimeout get mocked going forward
    vi.useFakeTimers();

    const pingP = client.ping();

    // Advance past the requestTimeoutMs
    vi.advanceTimersByTime(5100);

    await expect(pingP).rejects.toThrow('timed out');
    client.dispose();
  });

  it('reconnect is scheduled after connection close, with exponential backoff', async () => {
    let wsCount = 0;
    let box: MockBox = { ws: null as unknown as MockWebSocket };

    const options: AgentClientOptions = {
      psk: makePsk(),
      requestTimeoutMs: 5000,
      reconnectMinMs: 1000,
      reconnectMaxMs: 30000,
      webSocketFactory: (url: string) => {
        wsCount++;
        box.ws = new MockWebSocket(url);
        return box.ws as unknown as WebSocket;
      },
    };
    const client = new AgentClient(options);

    // First connect using real timers
    await doHandshake(client, box);
    expect(wsCount).toBe(1);
    expect(client.getState()).toBe('connected');

    // Switch to fake timers after handshake
    vi.useFakeTimers();

    // Simulate server dropping connection
    box.ws.__serverClose();
    await Promise.resolve();
    expect(client.getState()).toBe('disconnected');

    // First reconnect after reconnectMinMs (1000ms) — attempt 1: delay = 1000 * 2^0 = 1000
    vi.advanceTimersByTime(1001);
    // The factory is called synchronously when the timer fires
    expect(wsCount).toBe(2);

    // Let the second attempt fail (close without open) → triggers another scheduleReconnect
    // The connect() promise is async so we need to drain microtasks then manually trigger the close
    await Promise.resolve();
    await Promise.resolve();
    box.ws.__serverClose();
    await Promise.resolve();
    await Promise.resolve();

    // Second reconnect after 2× (2000ms) — attempt 2: delay = 1000 * 2^1 = 2000
    vi.advanceTimersByTime(2001);
    // Drain microtasks so the factory call propagates
    await Promise.resolve();
    expect(wsCount).toBe(3);

    client.dispose();
  });
});

describe('AgentClient — getAgentInfo()', () => {
  it('getAgentInfo() returns null before handshake completes', () => {
    const { client } = setupClient();
    expect(client.getAgentInfo()).toBeNull();
    client.dispose();
  });

  it('getAgentInfo() returns server AgentInfo after successful handshake, then null after disconnect', async () => {
    const { client, box } = setupClient();
    await doHandshake(client, box);
    const info = client.getAgentInfo();
    expect(info).not.toBeNull();
    expect(info?.platform).toBe('windows');
    expect(info?.version).toBe('0.1.0');
    expect(info?.capabilities).toEqual(['uia']);

    client.disconnect();
    expect(client.getAgentInfo()).toBeNull();
    client.dispose();
  });
});

describe('AgentClient — disconnect & dispose', () => {
  it('disconnect() clears reconnect timer and rejects pending requests', async () => {
    const { client, box } = setupClient();
    await doHandshake(client, box);

    const pingP = client.ping();
    await waitFor(() => box.ws.sent.length > 1);

    client.disconnect();
    await expect(pingP).rejects.toThrow('disconnected');
    client.dispose();
  });

  it('dispose() causes subsequent connect() to throw', async () => {
    const { client } = setupClient();
    client.dispose();
    await expect(client.connect()).rejects.toThrow('disposed');
  });
});

describe('AgentClient — malformed frames', () => {
  let client: AgentClient;
  let box: MockBox;
  const warnCalls: Array<[string, unknown]> = [];

  beforeEach(async () => {
    warnCalls.length = 0;
    const opts: AgentClientOptions = {
      logger: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: unknown) => {
        if (level === 'warn') warnCalls.push([msg, meta]);
      },
    };
    ({ client, box } = setupClient(opts));
    await doHandshake(client, box);
  });

  afterEach(() => {
    client.dispose();
  });

  it('non-JSON frame is handled gracefully: logger called with warn, pending request stays alive', async () => {
    const pingP = client.ping();
    await waitFor(() => box.ws.sent.length > 1);

    // Send garbage
    box.ws.__serverSend('{`invalid json`');
    await Promise.resolve();

    // Logger was called with warn about JSON
    expect(warnCalls.some(([msg]) => msg.toLowerCase().includes('json'))).toBe(true);

    // Ping still pending — resolve it
    const sent = JSON.parse(box.ws.sent[box.ws.sent.length - 1]) as { requestId: string };
    box.ws.__serverSend(JSON.stringify({ type: 'PONG', requestId: sent.requestId }));
    await pingP;
  });

  it('unknown type frame is handled gracefully: logger called with warn, pending request stays alive', async () => {
    const pingP = client.ping();
    await waitFor(() => box.ws.sent.length > 1);

    // Send unknown type
    box.ws.__serverSend(JSON.stringify({ type: 'BOGUS', requestId: 'whatever' }));
    await Promise.resolve();

    expect(warnCalls.some(([msg]) => msg.toLowerCase().includes('unknown'))).toBe(true);

    // Ping still pending — resolve it
    const sent = JSON.parse(box.ws.sent[box.ws.sent.length - 1]) as { requestId: string };
    box.ws.__serverSend(JSON.stringify({ type: 'PONG', requestId: sent.requestId }));
    await pingP;
  });
});
