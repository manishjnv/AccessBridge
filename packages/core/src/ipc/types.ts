export interface AgentInfo {
  version: string;
  platform: string;
  capabilities: string[];
}

export interface NativeTargetHint {
  processName?: string;
  windowTitle?: string;
  className?: string;
  elementName?: string;
  automationId?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeElementInfo {
  processName: string;
  windowTitle: string;
  className: string;
  automationId: string;
  controlType: string;
  boundingRect: Rect;
}

export interface NativeAdaptation {
  id: string;
  kind: string;           // e.g. 'font-scale' | 'process-dpi' | 'contrast'
  value: unknown;
}

export type AgentMessage =
  | { type: 'HELLO'; agent: AgentInfo; pskHash: string; nonce: string }
  | { type: 'HELLO_ACK'; pskOk: boolean; server: AgentInfo }
  | { type: 'PROFILE_GET'; requestId: string }
  | { type: 'PROFILE_SET'; requestId: string; profile: unknown }
  | { type: 'PROFILE_RESULT'; requestId: string; profile: unknown }
  | { type: 'PROFILE_UPDATED'; profile: unknown }
  | { type: 'ADAPTATION_APPLY'; requestId: string; target: NativeTargetHint; adaptation: NativeAdaptation }
  | { type: 'ADAPTATION_APPLY_RESULT'; requestId: string; adaptationId: string; ok: boolean; reason?: string }
  | { type: 'ADAPTATION_REVERT'; requestId: string; adaptationId: string }
  | { type: 'ADAPTATION_REVERT_RESULT'; requestId: string; ok: boolean }
  | { type: 'UIA_INSPECT'; requestId: string; target?: NativeTargetHint }
  | { type: 'UIA_ELEMENTS'; requestId: string; elements: NativeElementInfo[] }
  | { type: 'PING'; requestId: string }
  | { type: 'PONG'; requestId: string }
  | { type: 'ERROR'; requestId?: string; code: string; message: string };

export type AgentMessageType = AgentMessage['type'];

// ─── Session 21: typed capability helpers ────────────────────────────────────

export type AgentCapability =
  | 'font-scale'
  | 'contrast-filter'
  | 'cursor-size'
  | 'announce'
  | 'screen-reader-bridge'
  | 'color-invert'
  | 'uia-inspect'
  | 'ipc'
  | 'profile-sync';

export function isKnownCapability(s: string): s is AgentCapability {
  return (
    s === 'font-scale' ||
    s === 'contrast-filter' ||
    s === 'cursor-size' ||
    s === 'announce' ||
    s === 'screen-reader-bridge' ||
    s === 'color-invert' ||
    s === 'uia-inspect' ||
    s === 'ipc' ||
    s === 'profile-sync'
  );
}

// Type guard helper
export function isAgentMessage(v: unknown): v is AgentMessage {
  if (!v || typeof v !== 'object') return false;
  const t = (v as { type?: unknown }).type;
  return typeof t === 'string' && /^(HELLO|HELLO_ACK|PROFILE_GET|PROFILE_SET|PROFILE_RESULT|PROFILE_UPDATED|ADAPTATION_APPLY|ADAPTATION_APPLY_RESULT|ADAPTATION_REVERT|ADAPTATION_REVERT_RESULT|UIA_INSPECT|UIA_ELEMENTS|PING|PONG|ERROR)$/.test(t);
}

export function newRequestId(): string {
  // crypto.randomUUID is available in service worker + node 19+
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
