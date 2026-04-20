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

// AI Engine — lazy-initialized to keep startup fast
import { AIEngine, SummarizerService, SimplifierService } from '@accessbridge/ai-engine';

// Compliance Observatory — anonymous, DP-noised daily metrics (Feature #10)
import {
  ObservatoryCollector,
  installDailyAlarm,
} from './observatory-collector.js';

const observatoryCollector = new ObservatoryCollector();
observatoryCollector.hydrateFromStorage().catch(() => {});
installDailyAlarm(observatoryCollector, () => currentProfile?.shareAnonymousMetrics === true);

let aiEngine: AIEngine | null = null;
let summarizer: SummarizerService | null = null;
let simplifier: SimplifierService | null = null;

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

// ---------- State ----------

let currentProfile: AccessibilityProfile | null = null;
const struggleDetector = new StruggleDetector();
let decisionEngine: DecisionEngine | null = null;
let latestStruggleScore: StruggleScore | null = null;
const activeAdaptations: Map<string, Adaptation> = new Map();

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
});

chrome.runtime.onStartup.addListener(() => {
  loadProfile().then((p) => {
    currentProfile = p;
    if (p) {
      decisionEngine = new DecisionEngine(p);
    }
  });
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
  | 'AI_SET_KEY'
  | 'AI_GET_STATS'
  | 'CHECK_UPDATE'
  | 'APPLY_UPDATE'
  | 'AUDIT_SCAN_REQUEST'
  | 'HIGHLIGHT_ELEMENT'
  // --- Priority 1: Captions + Actions ---
  | 'ACTION_ITEMS_UPDATE';

interface Message {
  type: MessageType;
  payload?: unknown;
}

chrome.runtime.onMessage.addListener(
  (
    message: Message,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    handleMessage(message)
      .then(sendResponse)
      .catch((err) => {
        console.error('[AccessBridge] message error', err);
        sendResponse({ error: String(err) });
      });
    return true;
  },
);

async function handleMessage(message: Message): Promise<unknown> {
  switch (message.type) {
    case 'GET_PROFILE': {
      if (!currentProfile) {
        currentProfile = await loadProfile();
      }
      return currentProfile;
    }

    case 'SAVE_PROFILE': {
      const profile = message.payload as AccessibilityProfile;
      await saveProfile(profile);
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'PROFILE_UPDATED', payload: profile }).catch(() => {});
        }
      }
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
