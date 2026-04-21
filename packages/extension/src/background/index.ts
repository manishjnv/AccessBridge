/**
 * AccessBridge Service Worker
 * Handles message routing, runs StruggleDetector + DecisionEngine,
 * and auto-applies adaptations to content scripts.
 */

import {
  StruggleDetector,
  DecisionEngine,
  DEFAULT_PROFILE,
  AdaptationType,
} from '@accessbridge/core';
import type {
  AccessibilityProfile,
  Adaptation,
  StruggleScore,
  BehaviorSignal,
} from '@accessbridge/core';
import type { NativeTargetHint, NativeAdaptation } from '@accessbridge/core/ipc';

// AI Engine — lazy-initialized to keep startup fast
import { AIEngine, SummarizerService, SimplifierService } from '@accessbridge/ai-engine';
import { ActionItemsService } from '@accessbridge/ai-engine/services/index.js';
import { VisionRecoveryService } from '@accessbridge/ai-engine/services/index.js';
// --- Session 23: Vision Lab user-curation store ---
import { UserCurationStore } from '@accessbridge/core/vision/user-curation-store.js';
import type { UnlabeledElement, RecoveredLabel } from '@accessbridge/core/vision/types.js';

// --- Session 12: On-Device ONNX Models ---
import {
  ONNXRuntime,
  StruggleClassifier,
  MiniLMEmbeddings,
  T5Summarizer,
  MODEL_REGISTRY,
  TIER_LABELS,
} from '@accessbridge/onnx-runtime';
import type { ModelTier } from '@accessbridge/onnx-runtime';
// --- Session 17: Indic Whisper STT ---
import {
  IndicWhisper,
  BCP47_TO_WHISPER,
} from '@accessbridge/onnx-runtime';

// Compliance Observatory — anonymous, DP-noised daily metrics (Feature #10)
import {
  ObservatoryCollector,
  installDailyAlarm,
} from './observatory-collector.js';
// Session 16: ZK attestation helpers
// Session 20: org_hash propagation
import {
  rotateDeviceKeypair,
  getOrRefreshRing,
  setManagedOrgHash,
} from './observatory-publisher.js';
// --- Session 19: Desktop Agent Bridge ---
import { agentBridge } from './agent-bridge.js';
// --- Session 20: Enterprise Managed Policy ---
import {
  loadManagedPolicy,
  mergeWithProfile,
  subscribeToPolicyChanges,
  type ManagedPolicy,
  type LockdownResult,
} from './enterprise/index.js';

const observatoryCollector = new ObservatoryCollector();
observatoryCollector.hydrateFromStorage().catch(() => {});
installDailyAlarm(observatoryCollector, () => currentProfile?.shareAnonymousMetrics === true);

let aiEngine: AIEngine | null = null;
let summarizer: SummarizerService | null = null;
let simplifier: SimplifierService | null = null;
let actionItemsService: ActionItemsService | undefined;
let visionRecoveryService: VisionRecoveryService | undefined;

// --- Session 11: Fusion pipeline ---
function evaluateIntentForProfile(
  payload: { intent: string; confidence: number; suggestedAdaptations: string[] },
  _profile: AccessibilityProfile,
): Adaptation[] {
  // Build a minimal IntentHypothesis shape and delegate to DecisionEngine.
  // supportingEvents are intentionally stripped at the bridge — only the
  // aggregate count crosses, never raw event payloads.
  const engine = getOrCreateEngine();
  return engine.evaluateIntent({
    intent: payload.intent as
      | 'click-imminent'
      | 'scroll-continuation'
      | 'reading'
      | 'hesitation'
      | 'searching'
      | 'typing'
      | 'abandoning'
      | 'help-seeking',
    confidence: payload.confidence,
    supportingEvents: [],
    suggestedAdaptations: payload.suggestedAdaptations ?? [],
  });
}

interface FusionIntentRecord {
  intent: string;
  confidence: number;
  suggestedAdaptations: string[];
  supportingEventCount: number;
  timestamp: number;
  tabId?: number;
}
const fusionIntentHistory: FusionIntentRecord[] = [];
const FUSION_HISTORY_MAX = 50;

function getAIEngine(): AIEngine {
  if (!aiEngine) {
    aiEngine = new AIEngine(); // starts with local (free) tier
  }
  return aiEngine;
}

function getSummarizer(): SummarizerService {
  if (!summarizer) {
    summarizer = new SummarizerService(getAIEngine());
  }
  return summarizer;
}

function getSimplifier(): SimplifierService {
  if (!simplifier) {
    simplifier = new SimplifierService(getAIEngine());
  }
  return simplifier;
}

function getActionItemsService(): ActionItemsService {
  if (!actionItemsService) {
    actionItemsService = new ActionItemsService(getAIEngine());
  }
  return actionItemsService;
}

let curationStore: UserCurationStore | undefined;
function getCurationStore(): UserCurationStore {
  if (!curationStore) {
    curationStore = new UserCurationStore();
  }
  return curationStore;
}

function getVisionRecoveryService(): VisionRecoveryService {
  if (!visionRecoveryService) {
    visionRecoveryService = new VisionRecoveryService(getAIEngine());
  }
  return visionRecoveryService;
}

// ---------- Session 12: ONNX model runtime + tier load state ----------

type OnnxTierState = 'idle' | 'loading' | 'loaded' | 'failed';

let onnxRuntime: ONNXRuntime | null = null;
let struggleClassifier: StruggleClassifier | null = null;
let miniLM: MiniLMEmbeddings | null = null;
let t5Summarizer: T5Summarizer | null = null;
// --- Session 17: Indic Whisper STT ---
let indicWhisper: IndicWhisper | null = null;

const onnxTierState: Record<ModelTier, OnnxTierState> = { 0: 'idle', 1: 'idle', 2: 'idle', 3: 'idle', 4: 'idle' };
const onnxTierProgress: Record<ModelTier, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
const onnxTierError: Record<ModelTier, string | null> = { 0: null, 1: null, 2: null, 3: null, 4: null };

function getOnnxRuntime(): ONNXRuntime {
  if (!onnxRuntime) {
    // Point ort at bundled WASM + let the runtime resolve bundledPath models
    // (Tier 0 struggle-classifier) through chrome.runtime.getURL. Both are
    // no-ops in non-extension contexts (tests) because chrome.runtime may be
    // undefined there.
    const hasChromeRuntime =
      typeof chrome !== 'undefined' &&
      typeof chrome.runtime?.getURL === 'function';
    onnxRuntime = new ONNXRuntime({
      wasmPathBase: hasChromeRuntime ? chrome.runtime.getURL('ort/') : undefined,
      bundledUrlResolver: hasChromeRuntime
        ? (p: string) => chrome.runtime.getURL(p)
        : undefined,
    });
    struggleClassifier = new StruggleClassifier(onnxRuntime);
    miniLM = new MiniLMEmbeddings(onnxRuntime);
    t5Summarizer = new T5Summarizer(onnxRuntime);
    indicWhisper = new IndicWhisper(onnxRuntime);
    wireOnnxModelsIntoPipeline();
  }
  return onnxRuntime;
}

function wireOnnxModelsIntoPipeline(): void {
  // Struggle classifier → struggle detector blending path (tier 0).
  if (struggleClassifier) {
    struggleDetector.setClassifier({
      predict: async (features) => {
        if (onnxForceFallback()) {
          maybeRecordObservatoryOnnx('fallback');
          return null;
        }
        const result = await struggleClassifier!.predict(features);
        maybeRecordObservatoryOnnx(result ? 'tier0' : 'fallback');
        return result ? { score: result.score, confidence: result.confidence } : null;
      },
    });
  }
  // MiniLM / T5 → local AI provider embed + summarize paths (tiers 1, 2).
  const localProvider = getAIEngine().getLocalProvider();
  if (!localProvider) return;
  localProvider.setEmbedder({
    embed: async (text) => {
      if (onnxForceFallback()) {
        maybeRecordObservatoryOnnx('fallback');
        return null;
      }
      const v = await miniLM!.embed(text);
      maybeRecordObservatoryOnnx(v ? 'tier1' : 'fallback');
      return v;
    },
    ready: () => miniLM?.ready() ?? false,
  });
  localProvider.setSummarizer({
    summarize: async (text, opts) => {
      if (onnxForceFallback()) {
        maybeRecordObservatoryOnnx('fallback');
        return null;
      }
      const r = await t5Summarizer!.summarize(text, opts);
      maybeRecordObservatoryOnnx(r ? 'tier2' : 'fallback');
      return r;
    },
    ready: () => t5Summarizer?.ready() ?? false,
  });
}

function onnxForceFallback(): boolean {
  return currentProfile?.onnxForceFallback === true;
}

function maybeRecordObservatoryOnnx(
  bucket: 'tier0' | 'tier1' | 'tier2' | 'tier3' | 'fallback',
): void {
  if (currentProfile?.shareAnonymousMetrics) {
    observatoryCollector.recordOnnxInference(bucket);
  }
}

// --- Session 17: Indic Whisper STT ---
function maybeRecordVoiceTier(
  tier: 'a' | 'b' | 'c',
  language?: string,
): void {
  if (!currentProfile?.shareAnonymousMetrics) return;
  observatoryCollector.recordVoiceTier?.(tier);
  if (language) observatoryCollector.recordLanguageUsed?.(language);
}

async function loadOnnxTier(tier: ModelTier): Promise<{ ok: boolean; error?: string }> {
  getOnnxRuntime();
  onnxTierState[tier] = 'loading';
  onnxTierProgress[tier] = 0;
  onnxTierError[tier] = null;

  const model =
    tier === 0 ? struggleClassifier :
    tier === 1 ? miniLM :
    tier === 2 ? t5Summarizer :
    indicWhisper;
  if (!model) {
    onnxTierState[tier] = 'failed';
    onnxTierError[tier] = 'model-instance-missing';
    return { ok: false, error: 'model-instance-missing' };
  }

  try {
    const ok = await model.load((p) => {
      onnxTierProgress[tier] = p.percent;
    });
    if (ok) {
      onnxTierState[tier] = 'loaded';
      onnxTierProgress[tier] = 100;
      return { ok: true };
    }
    onnxTierState[tier] = 'failed';
    onnxTierError[tier] = 'load-returned-false';
    return { ok: false, error: 'load-returned-false' };
  } catch (err) {
    onnxTierState[tier] = 'failed';
    onnxTierError[tier] = String(err);
    return { ok: false, error: String(err) };
  }
}

async function getOnnxStatusSnapshot(): Promise<{
  tiers: Record<ModelTier, {
    state: OnnxTierState;
    progress: number;
    error: string | null;
    label: string;
    sizeBytes: number;
  }>;
  runtime: {
    modelsLoaded: string[];
    cacheBytes: number;
    inferenceCount: Record<string, number>;
    avgLatencyMs: Record<string, number>;
    fallbackCount: number;
  };
  forceFallback: boolean;
}> {
  const runtimeStats = onnxRuntime
    ? await onnxRuntime.getStats()
    : {
        modelsLoaded: [],
        cacheBytes: 0,
        inferenceCount: {},
        avgLatencyMs: {},
        fallbackCount: 0,
      };
  const tierMeta = (tier: ModelTier) => {
    const model = Object.values(MODEL_REGISTRY).find((m) => m.loadTier === tier);
    return {
      state: onnxTierState[tier],
      progress: onnxTierProgress[tier],
      error: onnxTierError[tier],
      label: TIER_LABELS[tier],
      sizeBytes: model?.sizeBytes ?? 0,
    };
  };
  return {
    tiers: { 0: tierMeta(0), 1: tierMeta(1), 2: tierMeta(2), 3: tierMeta(3), 4: tierMeta(4) },
    runtime: runtimeStats,
    forceFallback: onnxForceFallback(),
  };
}

let tier0BootScheduled = false;
function scheduleTier0OpportunisticLoad(): void {
  if (tier0BootScheduled) return;
  tier0BootScheduled = true;
  setTimeout(() => {
    loadProfile()
      .then((p) => {
        if (!p?.onnxModelsEnabled?.struggleClassifier) return;
        return loadOnnxTier(0);
      })
      .catch(() => {});
  }, 2000);
}

// ---------- State ----------

let currentProfile: AccessibilityProfile | null = null;
const struggleDetector = new StruggleDetector();
let decisionEngine: DecisionEngine | null = null;
let latestStruggleScore: StruggleScore | null = null;
const activeAdaptations: Map<string, Adaptation> = new Map();
// --- Session 20: Enterprise Managed Policy ---
let currentManagedPolicy: ManagedPolicy = {};
let currentLockdown: LockdownResult | null = null;

function getOrCreateEngine(): DecisionEngine {
  if (!decisionEngine) {
    decisionEngine = new DecisionEngine(currentProfile ?? { ...DEFAULT_PROFILE });
  }
  return decisionEngine;
}

// ---------- Storage helpers ----------

async function loadProfile(): Promise<AccessibilityProfile | null> {
  const result = await chrome.storage.local.get('profile');
  return (result.profile as AccessibilityProfile) ?? null;
}

async function saveProfile(profile: AccessibilityProfile): Promise<void> {
  currentProfile = profile;
  await chrome.storage.local.set({ profile });
  // Update the decision engine with the new profile
  getOrCreateEngine().updateProfile(profile);
  // Observatory: record the language in use today (opt-in only)
  if (profile.shareAnonymousMetrics && profile.language) {
    observatoryCollector.recordLanguageUsed(profile.language);
    observatoryCollector.persistToStorage().catch(() => {});
  }
}

// ---------- Auto-adaptation pipeline ----------

async function processSignalBatch(signals: BehaviorSignal[]): Promise<void> {
  // Feed signals into the struggle detector
  for (const signal of signals) {
    struggleDetector.addSignal(signal);
  }

  // Get updated struggle score
  const score = struggleDetector.getStruggleScore();
  latestStruggleScore = score;

  // Observatory: tap struggle events (only when opted in — counters are reset each day
  // when not sent; no leakage without explicit opt-in).
  if (score.score >= 50 && currentProfile?.shareAnonymousMetrics) {
    observatoryCollector.recordStruggleEvent();
    observatoryCollector.setScoreImprovement(score.score);
  }

  // Run decision engine to determine adaptations
  const engine = getOrCreateEngine();
  const newAdaptations = engine.evaluate(score);

  if (newAdaptations.length === 0) return;

  // Apply new adaptations to the active tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) return;

  for (const adaptation of newAdaptations) {
    activeAdaptations.set(adaptation.id, adaptation);
    if (currentProfile?.shareAnonymousMetrics) {
      observatoryCollector.recordAdaptation(String(adaptation.type));
    }
    try {
      await chrome.tabs.sendMessage(activeTab.id, {
        type: 'APPLY_ADAPTATION',
        payload: adaptation,
      });
    } catch {
      // Tab may not have content script — ignore
    }
  }

  // Periodically update baseline (every 30 signal batches)
  if (Math.random() < 0.03) {
    struggleDetector.updateBaseline();
  }
}

// ---------- Install / Startup ----------

chrome.runtime.onInstalled.addListener((details) => {
  console.log(
    `AccessBridge installed (reason: ${details.reason}, version: ${chrome.runtime.getManifest().version})`,
  );
  loadProfile().then((p) => {
    currentProfile = p;
    if (p) {
      decisionEngine = new DecisionEngine(p);
    }
  });
  scheduleTier0OpportunisticLoad();
});

chrome.runtime.onStartup.addListener(() => {
  loadProfile().then((p) => {
    currentProfile = p;
    if (p) {
      decisionEngine = new DecisionEngine(p);
    }
  });
  scheduleTier0OpportunisticLoad();
});

// ---------- Message handler ----------

// ---------- Update server ----------

const UPDATE_SERVER = 'https://accessbridge.space/api';

type MessageType =
  | 'GET_PROFILE'
  | 'SAVE_PROFILE'
  | 'GET_STRUGGLE_SCORE'
  | 'GET_ACTIVE_ADAPTATIONS'
  | 'APPLY_ADAPTATION'
  | 'REVERT_ADAPTATION'
  | 'REVERT_ALL'
  | 'SIGNAL_BATCH'
  | 'TOGGLE_FEATURE'
  | 'TAB_COMMAND'
  | 'SUMMARIZE_TEXT'
  | 'SUMMARIZE_EMAIL'
  | 'SIMPLIFY_TEXT'
  | 'AI_READABILITY'
  | 'AI_TRANSLATE'
  | 'AI_SET_KEY'
  | 'AI_GET_STATS'
  | 'CHECK_UPDATE'
  | 'APPLY_UPDATE'
  | 'AUDIT_SCAN_REQUEST'
  | 'AUDIT_RUN_AXE'
  | 'HIGHLIGHT_ELEMENT'
  // --- Priority 1: Captions + Actions ---
  | 'EXTRACT_ACTION_ITEMS'
  | 'ACTION_ITEMS_UPDATE'
  // --- Session 10: Vision Recovery ---
  | 'VISION_RECOVER_VIA_API'
  // --- Session 23: Vision Lab side panel + curation store ---
  | 'VISION_LAB_SCAN'
  | 'VISION_CURATION_LIST'
  | 'VISION_CURATION_SAVE'
  | 'VISION_CURATION_DELETE'
  | 'VISION_CURATION_CLEAR'
  | 'VISION_CURATION_EXPORT'
  // --- Session 11: Fusion pipeline ---
  | 'FUSION_INTENT_EMITTED'
  | 'FUSION_GET_STATS'
  | 'FUSION_GET_HISTORY'
  // --- Session 12: On-Device ONNX Models ---
  | 'ONNX_GET_STATUS'
  | 'ONNX_LOAD_TIER'
  | 'ONNX_UNLOAD_TIER'
  | 'ONNX_CLEAR_CACHE'
  | 'ONNX_SET_FORCE_FALLBACK'
  | 'ONNX_RUN_BENCHMARK'
  // --- Session 16: ZK attestation ---
  | 'OBSERVATORY_ROTATE_KEY'
  // --- Session 17: Indic Whisper STT ---
  | 'INDIC_WHISPER_TRANSCRIBE'
  | 'VOICE_TIER_RECORD'
  // --- Session 19: Desktop Agent Bridge ---
  | 'AGENT_GET_STATUS'
  | 'AGENT_GET_INFO'
  | 'AGENT_HAS_PSK'
  | 'AGENT_SET_PSK'
  | 'AGENT_CLEAR_PSK'
  | 'AGENT_INSPECT_NATIVE'
  | 'AGENT_APPLY_NATIVE'
  | 'AGENT_REVERT_NATIVE'
  // --- Session 20: Enterprise Managed Policy ---
  | 'ENTERPRISE_GET_POLICY'
  | 'ENTERPRISE_GET_LOCKDOWN';

interface Message {
  type: MessageType;
  payload?: unknown;
}

chrome.runtime.onMessage.addListener(
  (
    message: Message,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    handleMessage(message, sender)
      .then(sendResponse)
      .catch((err) => {
        console.error('[AccessBridge] message error', err);
        sendResponse({ error: String(err) });
      });
    return true;
  },
);

async function handleMessage(
  message: Message,
  sender?: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (message.type) {
    case 'GET_PROFILE': {
      if (!currentProfile) {
        currentProfile = await loadProfile();
      }
      return currentProfile;
    }

    case 'SAVE_PROFILE': {
      const incomingProfile = message.payload as AccessibilityProfile;
      // --- Session 20: Re-apply managed policy so locked keys cannot be overridden ---
      const mergeResult = mergeWithProfile(incomingProfile, currentManagedPolicy);
      currentLockdown = mergeResult;
      const profileToSave = mergeResult.profile;
      await saveProfile(profileToSave);
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'PROFILE_UPDATED', payload: profileToSave }).catch(() => {});
        }
      }
      agentBridge.syncProfileOut(currentProfile!).catch(() => {});
      return { success: true };
    }

    case 'GET_STRUGGLE_SCORE': {
      return latestStruggleScore;
    }

    case 'GET_ACTIVE_ADAPTATIONS': {
      return Array.from(activeAdaptations.values()).filter(a => a.applied);
    }

    case 'SIGNAL_BATCH': {
      const batch = message.payload as StruggleScore;
      // Process signals through the full pipeline
      await processSignalBatch(batch.signals);
      return { received: true, score: latestStruggleScore?.score ?? 0 };
    }

    case 'APPLY_ADAPTATION': {
      const adaptation = message.payload as Adaptation;
      activeAdaptations.set(adaptation.id, { ...adaptation, applied: true });
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id) {
        await chrome.tabs.sendMessage(activeTab.id, {
          type: 'APPLY_ADAPTATION',
          payload: adaptation,
        });
      }
      return { success: true };
    }

    case 'REVERT_ADAPTATION': {
      const adaptationId = message.payload as string;
      activeAdaptations.delete(adaptationId);
      const engine = getOrCreateEngine();
      engine.revertAdaptation(adaptationId);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'REVERT_ADAPTATION',
          payload: adaptationId,
        });
      }
      return { success: true };
    }

    case 'REVERT_ALL': {
      activeAdaptations.clear();
      const engine = getOrCreateEngine();
      engine.revertAll();
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'REVERT_ALL' }).catch(() => {});
        }
      }
      return { success: true };
    }

    case 'TOGGLE_FEATURE': {
      const { feature, enabled } = message.payload as { feature: string; enabled: boolean };
      return handleToggleFeature(feature, enabled);
    }

    case 'TAB_COMMAND': {
      const { command } = message.payload as { command: string };
      return handleTabCommand(command);
    }

    // ---------- AI Engine messages ----------

    case 'SUMMARIZE_TEXT': {
      const { text, maxBullets } = message.payload as { text: string; maxBullets?: number };
      const start = performance.now();
      const summary = await getSummarizer().summarizeDocument(text, maxBullets ?? 5);
      const latencyMs = Math.round(performance.now() - start);
      const stats = getAIEngine().getStats();
      return {
        text: summary,
        cached: false,
        tier: 'local',
        latencyMs,
        costStats: stats.cost,
      };
    }

    case 'SUMMARIZE_EMAIL': {
      const { html } = message.payload as { html: string };
      const start = performance.now();
      const summary = await getSummarizer().summarizeEmail(html);
      const latencyMs = Math.round(performance.now() - start);
      return { text: summary, cached: false, tier: 'local', latencyMs };
    }

    case 'SIMPLIFY_TEXT': {
      const { text, level } = message.payload as { text: string; level?: 'mild' | 'strong' };
      const start = performance.now();
      const simplified = await getSimplifier().simplifyText(text, level ?? 'mild');
      const latencyMs = Math.round(performance.now() - start);
      return { text: simplified, cached: false, tier: 'local', latencyMs };
    }

    case 'AI_READABILITY': {
      const { text } = message.payload as { text: string };
      const score = getSimplifier().getReadabilityScore(text);
      const grade = score <= 6 ? 'Easy' : score <= 10 ? 'Medium' : score <= 14 ? 'Hard' : 'Very Hard';
      return { score, grade };
    }

    case 'AI_TRANSLATE': {
      const { text, from, to } = message.payload as { text: string; from: string; to: string };
      if (!text || !to || from === to) return { text };
      try {
        const start = performance.now();
        const resp = await getAIEngine().process({
          id: `translate-${Date.now().toString(36)}`,
          type: 'translate',
          input: text,
          metadata: { from, to },
        });
        const latencyMs = Math.round(performance.now() - start);
        return { text: resp.output || text, latencyMs };
      } catch {
        return { text };
      }
    }

    case 'AI_SET_KEY': {
      const { provider, apiKey } = message.payload as { provider: 'gemini' | 'claude'; apiKey: string };
      getAIEngine().setApiKey(provider, apiKey);
      return { success: true };
    }

    case 'AI_GET_STATS': {
      return getAIEngine().getStats();
    }

    // ---------- Self-update ----------

    case 'CHECK_UPDATE': {
      try {
        const res = await fetch(`${UPDATE_SERVER}/version`);
        const data = await res.json() as { version: string; download_url: string; changelog: string };
        const currentVersion = chrome.runtime.getManifest().version;
        const hasUpdate = compareVersions(data.version, currentVersion) > 0;
        return {
          hasUpdate,
          currentVersion,
          latestVersion: data.version,
          downloadUrl: `https://accessbridge.space${data.download_url}`,
          changelog: data.changelog,
        };
      } catch {
        return { hasUpdate: false, error: 'Unable to reach update server' };
      }
    }

    case 'APPLY_UPDATE': {
      // Reload the extension — works for unpacked/sideloaded extensions
      chrome.runtime.reload();
      return { success: true };
    }

    // ---------- Accessibility audit passthrough ----------

    case 'AUDIT_SCAN_REQUEST': {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab?.id) return { error: 'No active tab' };
      if (activeTab.url?.startsWith('chrome://') || activeTab.url?.startsWith('edge://')) {
        return { error: 'Audit unavailable on browser internal pages' };
      }
      try {
        const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'AUDIT_SCAN_REQUEST' });
        return response ?? { error: 'No response from content script' };
      } catch (err) {
        return { error: `Content script unreachable: ${String(err)}` };
      }
    }

    case 'AUDIT_RUN_AXE': {
      // Session 18: route axe-core execution into the active tab's content
      // script. The content script injects axe via web_accessible_resources +
      // script tag, so we preserve the existing AUDIT_SCAN_REQUEST permission
      // profile — no new manifest permission needed.
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab?.id) return { error: 'No active tab' };
      if (activeTab.url?.startsWith('chrome://') || activeTab.url?.startsWith('edge://')) {
        return { error: 'axe-core unavailable on browser internal pages' };
      }
      try {
        const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'AUDIT_RUN_AXE' });
        return response ?? { error: 'No response from content script' };
      } catch (err) {
        return { error: `Content script unreachable: ${String(err)}` };
      }
    }

    case 'HIGHLIGHT_ELEMENT': {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab?.id) return { error: 'No active tab' };
      try {
        const response = await chrome.tabs.sendMessage(activeTab.id, {
          type: 'HIGHLIGHT_ELEMENT',
          payload: message.payload,
        });
        return response ?? { found: false };
      } catch (err) {
        return { error: `Content script unreachable: ${String(err)}` };
      }
    }

    // --- Priority 1: Captions + Actions ---
    case 'VISION_RECOVER_VIA_API': {
      const { screenshot, domContext } = message.payload as { screenshot: string; domContext: string };
      try {
        const result = await getVisionRecoveryService().inferElementMeaning({ screenshot, domContext });
        return result;
      } catch {
        return { role: 'button', label: 'Unlabeled control', description: '', confidence: 0 };
      }
    }

    // --- Session 23: Vision Lab side-panel message handlers ---
    case 'VISION_LAB_SCAN': {
      // Delegate scan to the active tab's content script; the content script
      // already owns the DOM walker from Session 10's Vision Recovery work.
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab?.id) return { ok: false, error: 'no-active-tab' };
      try {
        const response = await chrome.tabs.sendMessage(activeTab.id, {
          type: 'VISION_LAB_SCAN',
          payload: message.payload ?? {},
        });
        return response ?? { ok: false, error: 'content-no-response' };
      } catch (err) {
        return { ok: false, error: 'content-unreachable: ' + String(err) };
      }
    }

    case 'VISION_CURATION_LIST': {
      try {
        const store = getCurationStore();
        const curations = await store.list();
        return { curations };
      } catch (err) {
        return { curations: [], error: String(err) };
      }
    }

    case 'VISION_CURATION_SAVE': {
      const payload = message.payload as {
        element: UnlabeledElement;
        recovered: RecoveredLabel;
        status: 'accepted' | 'rejected' | 'edited';
        editedLabel?: string;
        domain: string;
        appVersion: string;
      };
      // Opus-solo adversarial pass (Session 23, codex:rescue quota-exhausted):
      // validate status enum + required-string-field shapes before reaching
      // store.save(). Prevents arbitrary-status rows landing in IndexedDB and
      // keeps the curation-learning loop (tools/aggregate-curated-labels.ts)
      // working against a tight shape contract.
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'invalid-payload' };
      }
      if (
        payload.status !== 'accepted' &&
        payload.status !== 'rejected' &&
        payload.status !== 'edited'
      ) {
        return { ok: false, error: 'invalid-status' };
      }
      if (
        !payload.element ||
        typeof payload.element !== 'object' ||
        typeof (payload.element as UnlabeledElement).classSignature !== 'string' ||
        (payload.element as UnlabeledElement).classSignature.length === 0
      ) {
        return { ok: false, error: 'invalid-element' };
      }
      if (!payload.recovered || typeof payload.recovered !== 'object') {
        return { ok: false, error: 'invalid-recovered' };
      }
      if (typeof payload.domain !== 'string' || payload.domain.length === 0) {
        return { ok: false, error: 'invalid-domain' };
      }
      if (typeof payload.appVersion !== 'string' || payload.appVersion.length === 0) {
        return { ok: false, error: 'invalid-appVersion' };
      }
      const store = getCurationStore();
      return store.save(payload);
    }

    case 'VISION_CURATION_DELETE': {
      const { id } = message.payload as { id: string };
      if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'invalid-id' };
      const store = getCurationStore();
      return store.delete(id);
    }

    case 'VISION_CURATION_CLEAR': {
      const store = getCurationStore();
      return store.clear();
    }

    case 'VISION_CURATION_EXPORT': {
      const store = getCurationStore();
      const json = await store.exportAsJson();
      // Persist to a Chrome download; returns the download id.
      try {
        const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
        const id = await chrome.downloads.download({
          url,
          filename: `accessbridge-curations-${new Date().toISOString().slice(0, 10)}.json`,
          saveAs: true,
        });
        return { ok: true, downloadId: id };
      } catch (err) {
        // Downloads API may be unavailable; return raw JSON so caller can
        // fall back to a data URL in the side panel.
        return { ok: true, json };
      }
    }

    case 'EXTRACT_ACTION_ITEMS': {
      const { text, context } = message.payload as { text: string; context?: 'email' | 'meeting' | 'doc' | 'generic' };
      const start = performance.now();
      try {
        const items = await getActionItemsService().extractActionItems(text, context ?? 'generic');
        const latencyMs = Math.round(performance.now() - start);
        return { items, latencyMs };
      } catch (err) {
        return { items: [], error: String(err) };
      }
    }

    case 'ACTION_ITEMS_UPDATE': {
      const { items: newItems } = message.payload as { items: Array<{ id: string; [key: string]: unknown }> };
      const stored = await chrome.storage.local.get('actionItemsHistory');
      const existing = (stored.actionItemsHistory as Array<{ id: string; timestamp?: number }>) ?? [];

      // Merge: dedupe by id, keep newest 50
      const byId = new Map<string, { id: string; timestamp?: number; [key: string]: unknown }>();
      for (const item of existing) byId.set(item.id, item);
      for (const item of newItems) byId.set(item.id, item);

      // Sort by timestamp desc and cap at 50
      const merged = Array.from(byId.values())
        .sort((a, b) => ((b.timestamp ?? 0) as number) - ((a.timestamp ?? 0) as number))
        .slice(0, 50);

      await chrome.storage.local.set({ actionItemsHistory: merged });

      // Forward to all extension views (popup, sidepanel) — swallow errors
      chrome.runtime
        .sendMessage({ type: 'ACTION_ITEMS_UPDATE', payload: { items: merged } })
        .catch(() => {});

      return { received: true };
    }

    // --- Session 11: Fusion pipeline ---
    case 'FUSION_INTENT_EMITTED': {
      const payload = message.payload as {
        intent: string;
        confidence: number;
        suggestedAdaptations: string[];
        supportingEventCount: number;
        timestamp: number;
      };
      const tabId = sender?.tab?.id;
      const record: FusionIntentRecord = {
        intent: payload.intent,
        confidence: payload.confidence,
        suggestedAdaptations: payload.suggestedAdaptations ?? [],
        supportingEventCount: payload.supportingEventCount ?? 0,
        timestamp: payload.timestamp ?? Date.now(),
        ...(typeof tabId === 'number' ? { tabId } : {}),
      };
      fusionIntentHistory.unshift(record);
      if (fusionIntentHistory.length > FUSION_HISTORY_MAX) {
        fusionIntentHistory.length = FUSION_HISTORY_MAX;
      }
      // Route to Decision Engine's intent path for adaptation suggestions.
      // Confidence gate applied on both sides (content + here) to avoid
      // flapping at the boundary.
      if (currentProfile && payload.confidence >= (currentProfile.fusionIntentMinConfidence ?? 0.65)) {
        const adaptations = evaluateIntentForProfile(payload, currentProfile);
        for (const adaptation of adaptations) {
          activeAdaptations.set(adaptation.id, adaptation);
          if (typeof tabId === 'number') {
            chrome.tabs
              .sendMessage(tabId, { type: 'APPLY_ADAPTATION', payload: adaptation })
              .catch(() => {});
          }
        }
      }
      // Broadcast to popup/sidepanel so Intelligence tab can stream it live.
      chrome.runtime
        .sendMessage({ type: 'FUSION_INTENT_EMITTED', payload: record })
        .catch(() => {});
      return { received: true };
    }

    case 'FUSION_GET_STATS': {
      // Forward to active tab's content script and await its response.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { running: false };
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'FUSION_GET_STATS' });
        return response ?? { running: false };
      } catch {
        return { running: false };
      }
    }

    case 'FUSION_GET_HISTORY': {
      return { history: [...fusionIntentHistory] };
    }

    // --- Session 12: On-Device ONNX Models ---
    case 'ONNX_GET_STATUS': {
      return getOnnxStatusSnapshot();
    }

    case 'ONNX_LOAD_TIER': {
      const { tier } = message.payload as { tier: ModelTier };
      if (tier !== 0 && tier !== 1 && tier !== 2 && tier !== 3) {
        return { ok: false, error: `invalid-tier:${tier}` };
      }
      // Fire-and-forget so the popup can poll progress via ONNX_GET_STATUS.
      loadOnnxTier(tier).catch(() => {});
      return { ok: true, state: onnxTierState[tier] };
    }

    case 'ONNX_UNLOAD_TIER': {
      const { tier } = message.payload as { tier: ModelTier };
      if (!onnxRuntime) return { ok: true };
      const model = Object.values(MODEL_REGISTRY).find((m) => m.loadTier === tier);
      if (model) {
        onnxRuntime.unloadModel(model.id);
        onnxTierState[tier] = 'idle';
        onnxTierProgress[tier] = 0;
      }
      return { ok: true };
    }

    case 'ONNX_CLEAR_CACHE': {
      if (onnxRuntime) await onnxRuntime.clearCache();
      onnxTierState[0] = onnxTierState[1] = onnxTierState[2] = onnxTierState[3] = 'idle';
      onnxTierProgress[0] = onnxTierProgress[1] = onnxTierProgress[2] = onnxTierProgress[3] = 0;
      return { ok: true };
    }

    case 'ONNX_SET_FORCE_FALLBACK': {
      const { enabled } = message.payload as { enabled: boolean };
      if (currentProfile) {
        const updated = { ...currentProfile, onnxForceFallback: enabled, updatedAt: Date.now() };
        await saveProfile(updated);
      }
      return { ok: true };
    }

    case 'ONNX_RUN_BENCHMARK': {
      if (!struggleClassifier || onnxTierState[0] !== 'loaded') {
        return { error: 'tier0-not-loaded' };
      }
      const N = 10;
      const classifierScores: number[] = [];
      const heuristicScores: number[] = [];
      let totalMs = 0;
      for (let i = 0; i < N; i++) {
        const features = new Float32Array(60).map(() => Math.random());
        const t0 = performance.now();
        const result = await struggleClassifier.predict(features);
        totalMs += performance.now() - t0;
        classifierScores.push(result ? result.score : 0);
        heuristicScores.push(struggleDetector.getStruggleScore().score);
      }
      return {
        avgLatencyMs: Math.round((totalMs / N) * 100) / 100,
        classifierScores,
        heuristicScores,
      };
    }

    // --- Session 17: Indic Whisper STT ---
    case 'INDIC_WHISPER_TRANSCRIBE': {
      const payload = message.payload as {
        audioBase64?: string;
        mime?: string;
        language?: string;
      } | undefined;
      if (!payload || typeof payload.audioBase64 !== 'string' || typeof payload.language !== 'string') {
        return { ok: false, error: 'bad-payload' };
      }
      // Security-boundary note (RCA: audio is privacy-class input):
      //   - We never persist audioBase64 anywhere; it is decoded into a
      //     Uint8Array local to this block and dropped once inference resolves.
      //   - Whisper sample rate is set by the wrapper; we pass 16 000 as a
      //     placeholder and let IndicWhisper resample if upstream didn't.
      //   - No logging of audio bytes under any logger; only metadata + lengths.
      if (!indicWhisper || !indicWhisper.ready()) {
        return { ok: false, error: 'indic-whisper-not-loaded' };
      }
      // Session 17 adversarial finding: the `in` operator accepts
      // inherited keys like 'toString' / 'hasOwnProperty', which would
      // bypass the language gate. hasOwnProperty.call is the correct check.
      if (!Object.prototype.hasOwnProperty.call(BCP47_TO_WHISPER, payload.language)) {
        return { ok: false, error: `unsupported-language:${payload.language}` };
      }
      let audioBytes: Uint8Array;
      try {
        audioBytes = base64ToBytes(payload.audioBase64);
      } catch (err) {
        return { ok: false, error: `decode-failed:${String(err)}` };
      }
      // TODO(session-18): decode the container (webm/opus) into Float32 PCM.
      // For now we pass an empty Float32Array; IndicWhisper returns a
      // structured null-ish result so the wiring is exercised end-to-end
      // without pretending to transcribe.
      const pcm = new Float32Array(0);
      audioBytes = new Uint8Array(0); // drop the buffer
      void audioBytes;
      const result = await indicWhisper.transcribe(pcm, 16_000, {
        language: payload.language,
      });
      maybeRecordVoiceTier('b', payload.language);
      maybeRecordObservatoryOnnx(result ? 'tier3' : 'fallback');
      if (!result) return { ok: false, error: 'inference-returned-null' };
      return {
        ok: true,
        text: result.text,
        confidence: result.confidence,
        language: result.language,
        latencyMs: result.latencyMs,
        real: result.real,
      };
    }

    case 'VOICE_TIER_RECORD': {
      const p = message.payload as { tier?: 'a' | 'b' | 'c'; language?: string } | undefined;
      if (p && (p.tier === 'a' || p.tier === 'b' || p.tier === 'c')) {
        maybeRecordVoiceTier(p.tier, p.language);
      }
      return { ok: true };
    }

    // --- Session 16: ZK attestation ---
    case 'OBSERVATORY_ROTATE_KEY': {
      try {
        await rotateDeviceKeypair();
        // Force-refresh the ring so the new pubkey is picked up
        await getOrRefreshRing(true);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }

    // --- Session 19: Desktop Agent Bridge ---
    case 'AGENT_GET_STATUS': {
      const status = agentBridge.getStatus();
      // Augment with live agentInfo (may differ from lastStatus if client reconnected)
      return { ...status, agentInfo: agentBridge.getAgentInfo() };
    }

    case 'AGENT_GET_INFO': {
      const info = agentBridge.getAgentInfo();
      if (info) return { agentInfo: info };
      // Async fallback: check chrome.storage for last-known persisted value
      const persisted = await agentBridge.getAgentInfoAsync();
      return { agentInfo: persisted };
    }

    case 'AGENT_HAS_PSK': {
      const hasPsk = await agentBridge.hasPsk();
      return { hasPsk };
    }

    case 'AGENT_SET_PSK': {
      const pskB64 = (message as unknown as { type: string; pskB64: string }).pskB64;
      try {
        await agentBridge.setPskFromBase64(pskB64);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error)?.message ?? 'unknown' };
      }
    }

    case 'AGENT_CLEAR_PSK': {
      await agentBridge.clearPsk();
      return { ok: true };
    }

    case 'AGENT_INSPECT_NATIVE': {
      const elements = await agentBridge.listNativeWindows();
      return { elements };
    }

    case 'AGENT_APPLY_NATIVE': {
      const { target, adaptation } = message as unknown as { type: string; target: NativeTargetHint; adaptation: NativeAdaptation };
      return agentBridge.applyNativeAdaptation(target, adaptation);
    }

    case 'AGENT_REVERT_NATIVE': {
      const { id } = message as unknown as { type: string; id: string };
      const ok = await agentBridge.revertNativeAdaptation(id);
      return { ok };
    }

    // --- Session 20: Enterprise Managed Policy ---
    case 'ENTERPRISE_GET_POLICY': {
      return currentManagedPolicy;
    }

    case 'ENTERPRISE_GET_LOCKDOWN': {
      return { lockedKeys: currentLockdown ? Array.from(currentLockdown.lockedKeys) : [] };
    }

    default: {
      // Handle voice command messages (format: { action: 'nextTab' })
      const msg = message as unknown as Record<string, string>;
      if (msg.action) {
        const actionMap: Record<string, string> = {
          nextTab: 'next-tab',
          previousTab: 'prev-tab',
          closeTab: 'close-tab',
          newTab: 'new-tab',
        };
        const command = actionMap[msg.action];
        if (command) return handleTabCommand(command);
      }
      return { error: `Unknown message type: ${(message as Message).type}` };
    }
  }
}

// ---------- Feature toggles (from popup/voice commands) ----------

async function handleToggleFeature(feature: string, enabled: boolean): Promise<unknown> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) return { error: 'No active tab' };

  // Map feature names to adaptation types
  const featureMap: Record<string, AdaptationType> = {
    'focus-mode': AdaptationType.FOCUS_MODE,
    'reading-mode': AdaptationType.READING_MODE,
    'distraction-shield': AdaptationType.LAYOUT_SIMPLIFY,
    'smart-targets': AdaptationType.CLICK_TARGET_ENLARGE,
    'text-simplify': AdaptationType.TEXT_SIMPLIFY,
    'reduced-motion': AdaptationType.REDUCED_MOTION,
    'auto-summarize': AdaptationType.AUTO_SUMMARIZE,
    'voice-nav': AdaptationType.VOICE_NAV,
    'eye-tracking': AdaptationType.EYE_TRACKING,
    'keyboard-only': AdaptationType.KEYBOARD_ONLY,
    'predictive-input': AdaptationType.PREDICTIVE_INPUT,
  };

  const adaptationType = featureMap[feature];
  if (!adaptationType) return { error: `Unknown feature: ${feature}` };

  if (enabled) {
    const adaptation: Adaptation = {
      id: `manual-${feature}-${Date.now()}`,
      type: adaptationType,
      value: true,
      confidence: 1,
      applied: true,
      timestamp: Date.now(),
      reversible: true,
    };
    activeAdaptations.set(adaptation.id, adaptation);
    if (currentProfile?.shareAnonymousMetrics) {
      observatoryCollector.recordFeatureEnabled(feature);
      observatoryCollector.persistToStorage().catch(() => {});
    }
    await chrome.tabs.sendMessage(activeTab.id, {
      type: 'APPLY_ADAPTATION',
      payload: adaptation,
    });
  } else {
    // Find and revert adaptations of this type
    for (const [id, a] of activeAdaptations) {
      if (a.type === adaptationType) {
        activeAdaptations.delete(id);
        await chrome.tabs.sendMessage(activeTab.id, {
          type: 'REVERT_ADAPTATION',
          payload: id,
        });
      }
    }
  }

  return { success: true };
}

// ---------- Tab commands (from voice navigation) ----------

async function handleTabCommand(command: string): Promise<unknown> {
  switch (command) {
    case 'next-tab': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.index !== undefined) {
        const nextIndex = (active.index + 1) % tabs.length;
        const nextTab = tabs[nextIndex];
        if (nextTab?.id) await chrome.tabs.update(nextTab.id, { active: true });
      }
      return { success: true };
    }
    case 'prev-tab': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.index !== undefined) {
        const prevIndex = (active.index - 1 + tabs.length) % tabs.length;
        const prevTab = tabs[prevIndex];
        if (prevTab?.id) await chrome.tabs.update(prevTab.id, { active: true });
      }
      return { success: true };
    }
    case 'close-tab': {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.id) await chrome.tabs.remove(active.id);
      return { success: true };
    }
    case 'new-tab': {
      await chrome.tabs.create({});
      return { success: true };
    }
    default:
      return { error: `Unknown tab command: ${command}` };
  }
}

// --- Session 17: Indic Whisper STT ---

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node fallback — service worker always has atob, but be defensive for tests.
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ---------- Version comparison ----------

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

console.log('AccessBridge service worker initialized');

// --- Session 19: Desktop Agent Bridge ---
// Non-blocking, fail-silent. Extension works standalone if no agent present.
agentBridge.start({
  getLocalProfile: () => currentProfile,
  onProfilePushFromAgent: (profile) => {
    // Merge agent-pushed profile into local store + broadcast.
    currentProfile = { ...currentProfile, ...profile, updatedAt: Date.now() } as typeof currentProfile;
    chrome.storage.local.set({ profile: currentProfile }).catch(() => {});
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id !== undefined) {
          chrome.tabs.sendMessage(tab.id, { type: 'PROFILE_UPDATED', profile: currentProfile }).catch(() => {});
        }
      }
    });
  },
  clientInfo: {
    version: chrome.runtime.getManifest().version,
    platform: 'chrome',
    capabilities: ['profile-sync'],
  },
}).catch((err) => console.warn('[background] agentBridge.start failed', err));

// --- Session 20: Load enterprise managed policy on startup + subscribe to changes ---
loadManagedPolicy().then(async (policy) => {
  currentManagedPolicy = policy;
  // Session 20: push org_hash into the observatory publisher so daily bundles
  // carry the enterprise device-ring hash when managed policy provides it.
  setManagedOrgHash(policy.orgHash);
  if (currentProfile) {
    currentLockdown = mergeWithProfile(currentProfile, policy);
    // Broadcast any policy-forced profile updates to content scripts
    if (currentLockdown.lockedKeys.size > 0) {
      currentProfile = currentLockdown.profile;
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id !== undefined) {
          chrome.tabs.sendMessage(tab.id, { type: 'PROFILE_UPDATED', payload: currentProfile }).catch(() => {});
        }
      }
    }
  }
}).catch(() => {});

subscribeToPolicyChanges((newPolicy) => {
  currentManagedPolicy = newPolicy;
  // Session 20: keep observatory publisher in sync with policy changes.
  setManagedOrgHash(newPolicy.orgHash);
  if (currentProfile) {
    currentLockdown = mergeWithProfile(currentProfile, newPolicy);
    currentProfile = currentLockdown.profile;
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id !== undefined) {
          chrome.tabs.sendMessage(tab.id, { type: 'PROFILE_UPDATED', payload: currentProfile }).catch(() => {});
        }
      }
    });
  }
});
