/**
 * AccessBridge Service Worker
 * Handles message routing between content scripts, popup, and side panel.
 */

import type {
  AccessibilityProfile,
  Adaptation,
  StruggleScore,
} from '@accessbridge/core/types';

// ---------- Message protocol ----------

type MessageType =
  | 'GET_PROFILE'
  | 'SAVE_PROFILE'
  | 'GET_STRUGGLE_SCORE'
  | 'APPLY_ADAPTATION'
  | 'REVERT_ADAPTATION'
  | 'REVERT_ALL';

interface Message {
  type: MessageType;
  payload?: unknown;
}

// ---------- In-memory state (persisted to chrome.storage) ----------

let currentProfile: AccessibilityProfile | null = null;
let latestStruggleScore: StruggleScore | null = null;
const activeAdaptations: Map<string, Adaptation> = new Map();

// ---------- Storage helpers ----------

async function loadProfile(): Promise<AccessibilityProfile | null> {
  const result = await chrome.storage.local.get('profile');
  return (result.profile as AccessibilityProfile) ?? null;
}

async function saveProfile(profile: AccessibilityProfile): Promise<void> {
  currentProfile = profile;
  await chrome.storage.local.set({ profile });
}

// ---------- Install / Startup ----------

chrome.runtime.onInstalled.addListener((details) => {
  console.log(
    `AccessBridge installed (reason: ${details.reason}, version: ${chrome.runtime.getManifest().version})`,
  );
  loadProfile().then((p) => {
    currentProfile = p;
  });
});

chrome.runtime.onStartup.addListener(() => {
  loadProfile().then((p) => {
    currentProfile = p;
  });
});

// ---------- Message handler ----------

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

    // Return true to keep the message channel open for async response
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
      // Broadcast profile update to all content scripts
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'PROFILE_UPDATED', payload: profile }).catch(() => {
            // Tab may not have content script injected – ignore
          });
        }
      }
      return { success: true };
    }

    case 'GET_STRUGGLE_SCORE': {
      return latestStruggleScore;
    }

    case 'APPLY_ADAPTATION': {
      const adaptation = message.payload as Adaptation;
      activeAdaptations.set(adaptation.id, { ...adaptation, applied: true });
      // Forward to active tab content script
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
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'REVERT_ALL' }).catch(() => {});
        }
      }
      return { success: true };
    }

    default:
      return { error: `Unknown message type: ${(message as Message).type}` };
  }
}

// ---------- Receive signals from content scripts ----------

chrome.runtime.onMessage.addListener(
  (
    message: { type: string; payload?: unknown },
    _sender,
    sendResponse,
  ) => {
    if (message.type === 'SIGNAL_BATCH') {
      // Store latest struggle score computed from signals
      latestStruggleScore = message.payload as StruggleScore;
      sendResponse({ received: true });
    }
    return false;
  },
);

console.log('AccessBridge service worker initialized');
