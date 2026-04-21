import type { AgentInfo, AgentMessage, AgentMessageType, NativeElementInfo, NativeTargetHint, NativeAdaptation } from './types.js';
import { isAgentMessage, newRequestId } from './types.js';
import { base64UrlDecode, generateNonce, pskHash } from './handshake.js';

export type ConnectionState = 'idle' | 'connecting' | 'handshaking' | 'connected' | 'disconnected' | 'error';

export interface AgentClientOptions {
  url?: string;                         // default ws://127.0.0.1:8901/agent
  psk?: Uint8Array;                     // caller loads PSK bytes; if absent, client stays idle
  webSocketFactory?: (url: string) => WebSocket;
  reconnectMinMs?: number;              // default 1000
  reconnectMaxMs?: number;              // default 30000
  requestTimeoutMs?: number;            // default 5000
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
  clientInfo?: AgentInfo;               // what to report in HELLO
}

export type PushHandler = (msg: Extract<AgentMessage, { type: 'PROFILE_UPDATED' }>) => void;
type StateHandler = (state: ConnectionState) => void;

export class AgentClient {
  private opts: Required<Omit<AgentClientOptions, 'psk' | 'clientInfo' | 'webSocketFactory' | 'logger'>> & Pick<AgentClientOptions, 'psk' | 'clientInfo' | 'webSocketFactory' | 'logger'>;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'idle';
  private pending = new Map<string, { resolve: (msg: AgentMessage) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private pushHandlers = new Set<PushHandler>();
  private stateHandlers = new Set<StateHandler>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private serverInfo: AgentInfo | null = null;

  constructor(options: AgentClientOptions = {}) {
    this.opts = {
      url: options.url ?? 'ws://127.0.0.1:8901/agent',
      reconnectMinMs: options.reconnectMinMs ?? 1000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30000,
      requestTimeoutMs: options.requestTimeoutMs ?? 5000,
      psk: options.psk,
      clientInfo: options.clientInfo,
      webSocketFactory: options.webSocketFactory,
      logger: options.logger,
    };
  }

  getState(): ConnectionState { return this.state; }
  getServerInfo(): AgentInfo | null { return this.serverInfo; }
  /** Alias for getServerInfo() — returns the agent-side AgentInfo from HELLO_ACK, or null. */
  getAgentInfo(): AgentInfo | null { return this.serverInfo; }
  isConnected(): boolean { return this.state === 'connected'; }

  onState(h: StateHandler): () => void {
    this.stateHandlers.add(h);
    return () => this.stateHandlers.delete(h);
  }

  onPushFromAgent(h: PushHandler): () => void {
    this.pushHandlers.add(h);
    return () => this.pushHandlers.delete(h);
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error('AgentClient disposed');
    if (!this.opts.psk) { this.log('info', 'no PSK — staying idle'); return; }
    if (this.state === 'connecting' || this.state === 'handshaking' || this.state === 'connected') return;
    this.setState('connecting');
    try {
      await this.openSocketAndHandshake();
    } catch (err) {
      this.log('warn', 'connect failed', err);
      this.setState('disconnected');
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    // Reject pending before closing so synchronous close events don't double-reject.
    this.rejectPending(new Error('disconnected'));
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.serverInfo = null;
    this.setState('disconnected');
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.pushHandlers.clear();
    this.stateHandlers.clear();
  }

  // ---- Public message API ----

  async ping(): Promise<void> {
    await this.request({ type: 'PING', requestId: newRequestId() }, 'PONG');
  }

  async getProfile(): Promise<unknown> {
    const requestId = newRequestId();
    const res = await this.request({ type: 'PROFILE_GET', requestId }, 'PROFILE_RESULT') as Extract<AgentMessage, { type: 'PROFILE_RESULT' }>;
    return res.profile;
  }

  async setProfile(profile: unknown): Promise<unknown> {
    const requestId = newRequestId();
    const res = await this.request({ type: 'PROFILE_SET', requestId, profile }, 'PROFILE_RESULT') as Extract<AgentMessage, { type: 'PROFILE_RESULT' }>;
    return res.profile;
  }

  async inspectNative(target?: NativeTargetHint): Promise<NativeElementInfo[]> {
    const requestId = newRequestId();
    const res = await this.request({ type: 'UIA_INSPECT', requestId, target }, 'UIA_ELEMENTS') as Extract<AgentMessage, { type: 'UIA_ELEMENTS' }>;
    return res.elements;
  }

  async applyAdaptation(target: NativeTargetHint, adaptation: NativeAdaptation): Promise<{ adaptationId: string; ok: boolean; reason?: string }> {
    const requestId = newRequestId();
    const res = await this.request({ type: 'ADAPTATION_APPLY', requestId, target, adaptation }, 'ADAPTATION_APPLY_RESULT') as Extract<AgentMessage, { type: 'ADAPTATION_APPLY_RESULT' }>;
    return { adaptationId: res.adaptationId, ok: res.ok, reason: res.reason };
  }

  async revertAdaptation(adaptationId: string): Promise<boolean> {
    const requestId = newRequestId();
    const res = await this.request({ type: 'ADAPTATION_REVERT', requestId, adaptationId }, 'ADAPTATION_REVERT_RESULT') as Extract<AgentMessage, { type: 'ADAPTATION_REVERT_RESULT' }>;
    return res.ok;
  }

  // ---- Internals ----

  private log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: unknown): void {
    if (this.opts.logger) this.opts.logger(level, msg, meta);
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    for (const h of this.stateHandlers) {
      try { h(s); } catch (err) { this.log('warn', 'state handler threw', err); }
    }
  }

  private async openSocketAndHandshake(): Promise<void> {
    const ws: WebSocket = this.opts.webSocketFactory ? this.opts.webSocketFactory(this.opts.url) : new WebSocket(this.opts.url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('websocket open failed')); };
      const onCloseEarly = () => { cleanup(); reject(new Error('websocket closed before open')); };
      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('close', onCloseEarly);
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onCloseEarly);
    });

    ws.addEventListener('message', (ev) => this.handleRaw(typeof ev.data === 'string' ? ev.data : ''));
    ws.addEventListener('close', () => {
      this.log('info', 'ws closed');
      this.rejectPending(new Error('connection closed'));
      this.setState('disconnected');
      this.scheduleReconnect();
    });
    ws.addEventListener('error', (ev) => { this.log('warn', 'ws error', ev); });

    this.setState('handshaking');
    const nonce = generateNonce(16);
    const pskNonceBytes = base64UrlDecode(nonce);
    const hash = await pskHash(this.opts.psk!, pskNonceBytes);
    const hello: AgentMessage = {
      type: 'HELLO',
      agent: this.opts.clientInfo ?? { version: '0.0.0', platform: 'unknown', capabilities: [] },
      pskHash: hash,
      nonce,
    };
    ws.send(JSON.stringify(hello));

    const ack = await new Promise<Extract<AgentMessage, { type: 'HELLO_ACK' }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('handshake timeout')), this.opts.requestTimeoutMs);
      const listener = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          if (isAgentMessage(msg) && msg.type === 'HELLO_ACK') {
            clearTimeout(timer);
            ws.removeEventListener('message', listener);
            resolve(msg);
          }
        } catch {}
      };
      ws.addEventListener('message', listener);
    });

    if (!ack.pskOk) throw new Error('PSK handshake rejected by agent');
    this.serverInfo = ack.server;
    this.reconnectAttempt = 0;
    this.setState('connected');
  }

  private handleRaw(raw: string): void {
    let msg: unknown;
    try { msg = JSON.parse(raw); } catch { this.log('warn', 'non-JSON frame'); return; }
    if (!isAgentMessage(msg)) { this.log('warn', 'unknown frame', msg); return; }
    const typed = msg;
    if (typed.type === 'PROFILE_UPDATED') {
      for (const h of this.pushHandlers) {
        try { h(typed); } catch (err) { this.log('warn', 'push handler threw', err); }
      }
      return;
    }
    if ('requestId' in typed && typeof typed.requestId === 'string') {
      const pending = this.pending.get(typed.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(typed.requestId);
        pending.resolve(typed);
      }
    }
  }

  private request<E extends AgentMessageType>(msg: AgentMessage, expect: E): Promise<Extract<AgentMessage, { type: E }>> {
    if (!this.ws || this.state !== 'connected') return Promise.reject(new Error('not connected'));
    const ws = this.ws;
    const requestId = 'requestId' in msg ? (msg as { requestId: string }).requestId : newRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`request ${requestId} timed out`));
      }, this.opts.requestTimeoutMs);
      this.pending.set(requestId, {
        resolve: (response) => {
          if (response.type === 'ERROR') { reject(new Error(`${(response as { code: string }).code}: ${(response as { message: string }).message}`)); return; }
          if (response.type !== expect) { reject(new Error(`expected ${expect}, got ${response.type}`)); return; }
          resolve(response as Extract<AgentMessage, { type: E }>);
        },
        reject,
        timer,
      });
      try { ws.send(JSON.stringify(msg)); }
      catch (err) { clearTimeout(timer); this.pending.delete(requestId); reject(err as Error); }
    });
  }

  private rejectPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.opts.psk) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(this.opts.reconnectMinMs * 2 ** (this.reconnectAttempt - 1), this.opts.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {});
    }, delay);
  }
}
