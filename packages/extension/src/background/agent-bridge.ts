/**
 * Desktop Agent Bridge (Session 19)
 *
 * Pairs the extension with the local AccessBridge Desktop Agent over
 * ws://127.0.0.1:8901. PSK is loaded from chrome.storage.local
 * ('agentPairKeyB64'); user pastes it via the popup Settings → "Pair
 * agent" dialog. If no PSK is present, the bridge stays idle and every
 * extension feature keeps working standalone (graceful degradation is
 * the load-bearing invariant).
 */

import { AgentClient, base64UrlDecode } from '@accessbridge/core/ipc';
import type { AgentInfo, ConnectionState, NativeElementInfo, NativeTargetHint, NativeAdaptation } from '@accessbridge/core/ipc';
import type { AccessibilityProfile } from '@accessbridge/core';

const STORAGE_KEY_PSK = 'agentPairKeyB64';
const STORAGE_KEY_LAST_STATUS = 'agentLastStatus';
const STORAGE_KEY_LAST_AGENT_INFO = 'agentLastKnownInfo';

export interface AgentStatus {
  connected: boolean;
  state: ConnectionState;
  server: AgentInfo | null;
  /** Agent-side platform + capabilities info, populated after successful HELLO_ACK. */
  agentInfo: AgentInfo | null;
  lastError: string | null;
  updatedAt: number;
}

export type AgentStatusHandler = (status: AgentStatus) => void;

export class AgentBridge {
  private client: AgentClient | null = null;
  private statusHandlers = new Set<AgentStatusHandler>();
  private lastStatus: AgentStatus = {
    connected: false,
    state: 'idle',
    server: null,
    agentInfo: null,
    lastError: null,
    updatedAt: Date.now(),
  };
  private pushProfile: ((profile: AccessibilityProfile) => void) | null = null;
  private localProfileGetter: (() => AccessibilityProfile | null) | null = null;
  private started = false;

  /**
   * Called once at SW startup. If PSK exists in storage, connect.
   * Safe to invoke every SW wake; re-uses existing client if already started.
   */
  async start(options: {
    onProfilePushFromAgent?: (profile: AccessibilityProfile) => void;
    getLocalProfile?: () => AccessibilityProfile | null;
    clientInfo?: AgentInfo;
  } = {}): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.pushProfile = options.onProfilePushFromAgent ?? null;
    this.localProfileGetter = options.getLocalProfile ?? null;

    const pskB64 = await this.loadPskB64();
    if (!pskB64) {
      this.setStatus({ ...this.lastStatus, state: 'idle', connected: false });
      return;
    }

    let pskBytes: Uint8Array;
    try { pskBytes = base64UrlDecode(pskB64); }
    catch (err) {
      this.setStatus({ ...this.lastStatus, state: 'error', lastError: `invalid PSK: ${(err as Error).message}` });
      return;
    }

    this.client = new AgentClient({
      psk: pskBytes,
      clientInfo: options.clientInfo ?? { version: chrome.runtime.getManifest().version, platform: 'chrome', capabilities: ['profile-sync'] },
      logger: (level, msg, meta) => {
        if (level === 'error' || level === 'warn') console.warn('[agent-bridge]', msg, meta);
      },
    });

    this.client.onState((s) => {
      const liveInfo = this.client?.getAgentInfo() ?? null;
      if (s === 'connected' && liveInfo) {
        chrome.storage.local.set({ [STORAGE_KEY_LAST_AGENT_INFO]: liveInfo }).catch(() => {});
      }
      this.setStatus({
        ...this.lastStatus,
        state: s,
        connected: s === 'connected',
        server: this.client?.getServerInfo() ?? null,
        agentInfo: liveInfo,
        lastError: s === 'error' ? this.lastStatus.lastError : null,
      });
    });

    this.client.onPushFromAgent((msg) => {
      if (this.pushProfile && msg.profile && typeof msg.profile === 'object') {
        try { this.pushProfile(msg.profile as AccessibilityProfile); }
        catch (err) { console.warn('[agent-bridge] profile handler threw', err); }
      }
    });

    await this.client.connect();

    // After connect, push our local profile so the agent has the latest truth.
    if (this.client.isConnected() && this.localProfileGetter) {
      const local = this.localProfileGetter();
      if (local) { try { await this.client.setProfile(local); } catch { /* non-fatal */ } }
    }
  }

  stop(): void {
    if (this.client) { this.client.dispose(); this.client = null; }
    this.started = false;
    this.setStatus({ ...this.lastStatus, state: 'idle', connected: false, server: null, agentInfo: null });
  }

  isConnected(): boolean { return !!this.client && this.client.isConnected(); }

  getStatus(): AgentStatus { return { ...this.lastStatus }; }

  /**
   * Returns live agent info from the connected client, or falls back to the
   * last value persisted in chrome.storage.local (so the popup can show
   * something useful even after a SW restart before reconnect completes).
   * Returns null synchronously only from the live path; callers that need
   * the persisted fallback should use getAgentInfoAsync().
   */
  getAgentInfo(): AgentInfo | null {
    return this.client?.getAgentInfo() ?? this.lastStatus.agentInfo ?? null;
  }

  /** Async variant that also checks chrome.storage for the persisted last-known info. */
  async getAgentInfoAsync(): Promise<AgentInfo | null> {
    const live = this.getAgentInfo();
    if (live) return live;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY_LAST_AGENT_INFO);
      const stored = result[STORAGE_KEY_LAST_AGENT_INFO];
      if (stored && typeof stored === 'object') return stored as AgentInfo;
    } catch { /* non-fatal */ }
    return null;
  }

  onStatusChange(h: AgentStatusHandler): () => void {
    this.statusHandlers.add(h);
    return () => this.statusHandlers.delete(h);
  }

  /** Push a local profile change to the agent. Fire-and-forget; non-fatal on failure. */
  async syncProfileOut(profile: AccessibilityProfile): Promise<void> {
    if (!this.client || !this.client.isConnected()) return;
    try { await this.client.setProfile(profile); }
    catch (err) { console.warn('[agent-bridge] syncProfileOut failed', err); }
  }

  async listNativeWindows(): Promise<NativeElementInfo[]> {
    if (!this.client || !this.client.isConnected()) return [];
    try { return await this.client.inspectNative(); }
    catch { return []; }
  }

  async applyNativeAdaptation(target: NativeTargetHint, adaptation: NativeAdaptation): Promise<{ adaptationId: string; ok: boolean; reason?: string }> {
    if (!this.client || !this.client.isConnected()) return { adaptationId: adaptation.id, ok: false, reason: 'agent not connected' };
    return this.client.applyAdaptation(target, adaptation);
  }

  async revertNativeAdaptation(id: string): Promise<boolean> {
    if (!this.client || !this.client.isConnected()) return false;
    return this.client.revertAdaptation(id);
  }

  /** Overwrite stored PSK + reconnect with the new key. */
  async setPskFromBase64(pskB64: string): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY_PSK]: pskB64 });
    if (this.client) { this.client.dispose(); this.client = null; }
    this.started = false;
    await this.start({
      onProfilePushFromAgent: this.pushProfile ?? undefined,
      getLocalProfile: this.localProfileGetter ?? undefined,
    });
  }

  /** Remove stored PSK + disconnect. */
  async clearPsk(): Promise<void> {
    await chrome.storage.local.remove(STORAGE_KEY_PSK);
    this.stop();
  }

  async hasPsk(): Promise<boolean> {
    const pskB64 = await this.loadPskB64();
    return !!pskB64;
  }

  // --- internals ---

  private async loadPskB64(): Promise<string | null> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY_PSK);
      const v = result[STORAGE_KEY_PSK];
      return typeof v === 'string' && v.length > 0 ? v : null;
    } catch { return null; }
  }

  private setStatus(next: AgentStatus): void {
    this.lastStatus = { ...next, updatedAt: Date.now() };
    chrome.storage.local.set({ [STORAGE_KEY_LAST_STATUS]: this.lastStatus }).catch(() => {});
    for (const h of this.statusHandlers) {
      try { h(this.lastStatus); } catch (err) { console.warn('[agent-bridge] status handler threw', err); }
    }
  }
}

export const agentBridge = new AgentBridge();
