/**
 * AccessBridge Content Script
 * Detects the current application, sets up signal collection,
 * and applies accessibility adaptations.
 * Day 2: Integrates Cognitive Simplifier, Voice Commands, Fatigue Adaptive UI.
 */

import type { Adaptation, BehaviorSignal } from '@accessbridge/core/types';
import { SignalType, AdaptationType } from '@accessbridge/core/types';
import { SensoryAdapter } from './sensory/adapter.js';
import { GmailAdapter } from './adapters/gmail.js';
import { OutlookAdapter } from './adapters/outlook.js';
import { GenericAdapter } from './adapters/generic.js';
import type { BaseAdapter } from './adapters/base.js';
import { CognitiveSimplifier } from './cognitive/simplifier.js';
import { VoiceCommandSystem } from './motor/voice-commands.js';
import { FatigueAdaptiveUI } from './fatigue/adaptive-ui.js';
import { AIBridge } from './ai/bridge.js';
import { matchHindiCommand } from './motor/hindi-commands.js';
import { DwellClickSystem } from './motor/dwell-click.js';
import { EyeTracker } from './motor/eye-tracker.js';

// ---------- App Detection ----------

type AppType = 'gmail' | 'outlook' | 'docs' | 'teams' | 'sap-fiori' | 'servicenow' | 'generic';

function detectApp(): AppType {
  const { hostname } = window.location;
  if (hostname.includes('mail.google.com')) return 'gmail';
  if (hostname.includes('outlook.live.com') || hostname.includes('outlook.office.com'))
    return 'outlook';
  if (hostname.includes('docs.google.com')) return 'docs';
  if (hostname.includes('teams.microsoft.com')) return 'teams';
  if (document.querySelector('[data-sap-ui-area]') || hostname.includes('fiori')) return 'sap-fiori';
  if (hostname.includes('service-now.com') || hostname.includes('servicenow.com'))
    return 'servicenow';
  return 'generic';
}

// ---------- Adapter selection ----------

function createAdapter(app: AppType): BaseAdapter {
  switch (app) {
    case 'gmail':
      return new GmailAdapter();
    case 'outlook':
      return new OutlookAdapter();
    default:
      return new GenericAdapter();
  }
}

// ---------- Signal collection ----------

const signalBuffer: BehaviorSignal[] = [];
const SIGNAL_FLUSH_INTERVAL = 5_000;

function collectScrollSignal(): void {
  let lastScrollY = window.scrollY;
  let lastScrollTime = Date.now();

  window.addEventListener(
    'scroll',
    () => {
      const now = Date.now();
      const dt = now - lastScrollTime;
      if (dt === 0) return;
      const distance = Math.abs(window.scrollY - lastScrollY);
      const velocity = distance / dt;

      signalBuffer.push({
        type: SignalType.SCROLL_VELOCITY,
        value: velocity,
        timestamp: now,
        normalized: Math.min(velocity / 5, 1),
      });

      lastScrollY = window.scrollY;
      lastScrollTime = now;
    },
    { passive: true },
  );
}

function collectClickSignal(): void {
  let lastClickTime = 0;

  document.addEventListener('click', (e: MouseEvent) => {
    const now = Date.now();
    const target = e.target as HTMLElement;

    const rect = target.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const distance = Math.sqrt((e.clientX - centerX) ** 2 + (e.clientY - centerY) ** 2);
    const maxDistance = Math.sqrt(rect.width ** 2 + rect.height ** 2) / 2;
    const accuracy = maxDistance > 0 ? 1 - Math.min(distance / maxDistance, 1) : 1;

    signalBuffer.push({
      type: SignalType.CLICK_ACCURACY,
      value: accuracy,
      timestamp: now,
      normalized: accuracy,
    });

    if (lastClickTime > 0) {
      const gap = now - lastClickTime;
      signalBuffer.push({
        type: SignalType.HESITATION,
        value: gap,
        timestamp: now,
        normalized: Math.min(gap / 10_000, 1),
      });
    }
    lastClickTime = now;
  });
}

function collectTypingSignal(): void {
  let keyTimes: number[] = [];
  let backspaceCount = 0;
  let totalKeys = 0;

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const now = Date.now();
    totalKeys++;

    if (e.key === 'Backspace' || e.key === 'Delete') {
      backspaceCount++;
      if (totalKeys > 5) {
        signalBuffer.push({
          type: SignalType.BACKSPACE_RATE,
          value: backspaceCount / totalKeys,
          timestamp: now,
          normalized: Math.min((backspaceCount / totalKeys) * 5, 1),
        });
      }
    }

    keyTimes.push(now);
    if (keyTimes.length > 10) {
      const intervals = [];
      for (let i = 1; i < keyTimes.length; i++) {
        intervals.push(keyTimes[i] - keyTimes[i - 1]);
      }
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance =
        intervals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / intervals.length;
      const stddev = Math.sqrt(variance);

      signalBuffer.push({
        type: SignalType.TYPING_RHYTHM,
        value: stddev,
        timestamp: now,
        normalized: Math.min(stddev / 500, 1),
      });

      keyTimes = keyTimes.slice(-5);
    }
  });
}

function collectMouseSignal(): void {
  let lastPos = { x: 0, y: 0, time: 0 };
  let pathDeviation = 0;
  let moveCount = 0;

  document.addEventListener(
    'mousemove',
    (e: MouseEvent) => {
      const now = Date.now();
      if (lastPos.time > 0 && now - lastPos.time < 200) {
        const dx = e.clientX - lastPos.x;
        const dy = e.clientY - lastPos.y;
        const distance = Math.sqrt(dx ** 2 + dy ** 2);
        pathDeviation += Math.abs(Math.atan2(dy, dx));
        moveCount++;

        if (moveCount % 20 === 0) {
          signalBuffer.push({
            type: SignalType.CURSOR_PATH,
            value: pathDeviation / moveCount,
            timestamp: now,
            normalized: Math.min((pathDeviation / moveCount) / Math.PI, 1),
          });
          pathDeviation = 0;
          moveCount = 0;
        }

        const dt = now - lastPos.time;
        if (dt > 0 && distance / dt < 0.05) {
          signalBuffer.push({
            type: SignalType.DWELL_TIME,
            value: dt,
            timestamp: now,
            normalized: Math.min(dt / 3000, 1),
          });
        }
      }
      lastPos = { x: e.clientX, y: e.clientY, time: now };
    },
    { passive: true },
  );
}

function flushSignals(): void {
  if (signalBuffer.length === 0) return;

  const batch = signalBuffer.splice(0, signalBuffer.length);

  const avgNormalized =
    batch.reduce((sum, s) => sum + s.normalized, 0) / batch.length;

  chrome.runtime.sendMessage({
    type: 'SIGNAL_BATCH',
    payload: {
      score: Math.round(avgNormalized * 100),
      confidence: Math.min(batch.length / 50, 1),
      signals: batch,
      timestamp: Date.now(),
    },
  }).catch(() => {});
}

// ---------- Feature module instances ----------

let cognitiveSimplifier: CognitiveSimplifier | null = null;
let voiceCommands: VoiceCommandSystem | null = null;
let fatigueUI: FatigueAdaptiveUI | null = null;
let aiBridge: AIBridge | null = null;
let dwellClick: DwellClickSystem | null = null;
let eyeTracker: EyeTracker | null = null;

function getAI(): AIBridge {
  if (!aiBridge) {
    aiBridge = new AIBridge();
  }
  return aiBridge;
}

function getDwell(): DwellClickSystem {
  if (!dwellClick) {
    dwellClick = new DwellClickSystem();
  }
  return dwellClick;
}

function getEyeTracker(): EyeTracker {
  if (!eyeTracker) {
    eyeTracker = new EyeTracker();
  }
  return eyeTracker;
}

function getCognitive(): CognitiveSimplifier {
  if (!cognitiveSimplifier) {
    cognitiveSimplifier = new CognitiveSimplifier();
  }
  return cognitiveSimplifier;
}

function getVoice(): VoiceCommandSystem {
  if (!voiceCommands) {
    voiceCommands = new VoiceCommandSystem({
      onCommand: (command: string, args: string) => {
        handleVoiceCommand(command, args);
      },
    });
  }
  return voiceCommands;
}

function getFatigue(): FatigueAdaptiveUI {
  if (!fatigueUI) {
    fatigueUI = new FatigueAdaptiveUI();
  }
  return fatigueUI;
}

// ---------- Voice command handler ----------

function handleVoiceCommand(command: string, args: string): void {
  // Try Hindi command matching if the command doesn't match English commands
  const hindiMatch = matchHindiCommand(command + (args ? ' ' + args : ''));
  if (hindiMatch) {
    handleVoiceCommand(hindiMatch.action, hindiMatch.args);
    return;
  }

  switch (command) {
    case 'scroll-up':
      window.scrollBy({ top: -300, behavior: 'smooth' });
      break;
    case 'scroll-down':
      window.scrollBy({ top: 300, behavior: 'smooth' });
      break;
    case 'go-to-top':
      window.scrollTo({ top: 0, behavior: 'smooth' });
      break;
    case 'go-to-bottom':
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      break;
    case 'go-back':
      history.back();
      break;
    case 'go-forward':
      history.forward();
      break;
    case 'reload':
      location.reload();
      break;
    case 'zoom-in':
      document.body.style.zoom = String(parseFloat(document.body.style.zoom || '1') + 0.1);
      break;
    case 'zoom-out':
      document.body.style.zoom = String(Math.max(0.5, parseFloat(document.body.style.zoom || '1') - 0.1));
      break;
    case 'focus-mode':
      getCognitive().enableFocusMode();
      break;
    case 'reading-mode':
      getCognitive().enableReadingGuide();
      break;
    case 'next-tab':
    case 'prev-tab':
    case 'close-tab':
    case 'new-tab':
      chrome.runtime.sendMessage({ type: 'TAB_COMMAND', payload: { command } }).catch(() => {});
      break;
    case 'click':
      clickElementByText(args);
      break;
    case 'type':
      typeIntoFocused(args);
      break;
    case 'find':
      highlightText(args);
      break;
    case 'stop-listening':
      getVoice().stop();
      break;
    case 'summarize':
      getAI().summarizePage(true).catch(() => {});
      break;
    case 'simplify':
      getAI().simplifyContent('mild').catch(() => {});
      break;
    case 'summarize-email':
      getAI().summarizeEmail().catch(() => {});
      break;
  }
}

function clickElementByText(text: string): void {
  if (!text) return;
  const lower = text.toLowerCase();
  const interactives = document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]');
  for (const el of interactives) {
    if ((el.textContent ?? '').toLowerCase().includes(lower)) {
      (el as HTMLElement).click();
      return;
    }
  }
}

function typeIntoFocused(text: string): void {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.value += text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (el?.getAttribute('contenteditable') === 'true') {
    document.execCommand('insertText', false, text);
  }
}

function highlightText(text: string): void {
  if (!text) return;
  // Use window.find for basic text search
  (window as unknown as { find: (s: string) => boolean }).find(text);
}

// ---------- Message listener from background ----------

function listenForCommands(adapter: BaseAdapter, sensory: SensoryAdapter): void {
  chrome.runtime.onMessage.addListener(
    (message: { type: string; payload?: unknown }, _sender, sendResponse) => {
      switch (message.type) {
        case 'APPLY_ADAPTATION': {
          const adaptation = message.payload as Adaptation;
          applyAdaptation(adaptation, adapter, sensory);
          sendResponse({ applied: true });
          break;
        }
        case 'REVERT_ADAPTATION': {
          const id = message.payload as string;
          revertAdaptation(id, adapter, sensory);
          sendResponse({ reverted: true });
          break;
        }
        case 'REVERT_ALL': {
          sensory.revertAll();
          getCognitive().disableAll();
          getVoice().stop();
          getDwell().stop();
          getEyeTracker().stop();
          getAI().dismiss();
          sendResponse({ reverted: true });
          break;
        }
        case 'TOGGLE_DWELL_CLICK': {
          const { enabled, delay } = message.payload as { enabled: boolean; delay?: number };
          if (enabled) getDwell().start(delay);
          else getDwell().stop();
          sendResponse({ success: true });
          break;
        }
        case 'PROFILE_UPDATED': {
          sendResponse({ received: true });
          break;
        }
      }
      return false;
    },
  );
}

function applyAdaptation(adaptation: Adaptation, adapter: BaseAdapter, sensory: SensoryAdapter): void {
  switch (adaptation.type) {
    // Sensory adaptations
    case AdaptationType.FONT_SCALE:
    case AdaptationType.CONTRAST:
    case AdaptationType.COLOR_CORRECTION:
    case AdaptationType.LINE_HEIGHT:
    case AdaptationType.LETTER_SPACING:
    case AdaptationType.CURSOR_SIZE:
    case AdaptationType.REDUCED_MOTION:
    case AdaptationType.READING_MODE:
      sensory.applyAdaptation(adaptation);
      break;

    // Cognitive adaptations
    case AdaptationType.FOCUS_MODE:
      if (adaptation.value) getCognitive().enableFocusMode();
      else getCognitive().disableFocusMode();
      break;
    case AdaptationType.LAYOUT_SIMPLIFY:
      if (adaptation.value) getCognitive().enableDistractionShield();
      else getCognitive().disableDistractionShield();
      break;
    case AdaptationType.TEXT_SIMPLIFY:
      if (adaptation.value) {
        getAI().simplifyContent('mild').catch(() => {});
      } else {
        getAI().dismiss();
      }
      break;
    case AdaptationType.AUTO_SUMMARIZE:
      if (adaptation.value) {
        getAI().summarizePage(true).catch(() => {});
      } else {
        getAI().dismiss();
      }
      break;

    // Motor adaptations
    case AdaptationType.CLICK_TARGET_ENLARGE:
      adapter.apply(adaptation);
      break;
    case AdaptationType.VOICE_NAV:
      if (adaptation.value) getVoice().start();
      else getVoice().stop();
      break;
    case AdaptationType.EYE_TRACKING:
      if (adaptation.value) getEyeTracker().start();
      else getEyeTracker().stop();
      break;

    default:
      adapter.apply(adaptation);
      break;
  }
}

function revertAdaptation(id: string, adapter: BaseAdapter, _sensory: SensoryAdapter): void {
  adapter.revert(id);
}

// ---------- Mutation observer for dynamic content ----------

function observeDynamicContent(adapter: BaseAdapter): void {
  const observer = new MutationObserver((mutations) => {
    let significantChange = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 3 || m.removedNodes.length > 3) {
        significantChange = true;
        break;
      }
    }
    if (significantChange) {
      adapter.collectSignals();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ---------- Initialisation ----------

function init(): void {
  const app = detectApp();
  console.log(`[AccessBridge] Detected app: ${app}`);

  const adapter = createAdapter(app);
  const sensory = new SensoryAdapter();

  // Set up signal collection
  collectScrollSignal();
  collectClickSignal();
  collectTypingSignal();
  collectMouseSignal();

  // Flush signals periodically
  setInterval(flushSignals, SIGNAL_FLUSH_INTERVAL);

  // Listen for adaptation commands
  listenForCommands(adapter, sensory);

  // Watch for dynamic content
  observeDynamicContent(adapter);

  // Start fatigue monitoring
  getFatigue().start();

  // Load profile and check for pre-enabled features
  chrome.runtime.sendMessage({ type: 'GET_PROFILE' }).then((profile) => {
    if (!profile || typeof profile !== 'object') return;
    const p = profile as {
      language?: string;
      motor?: { voiceNavigationEnabled?: boolean };
      cognitive?: { focusModeEnabled?: boolean; distractionShield?: boolean };
    };
    // Set voice command language based on profile
    const langMap: Record<string, string> = {
      'en': 'en-US', 'hi': 'hi-IN', 'es': 'es-ES',
      'fr': 'fr-FR', 'de': 'de-DE', 'zh': 'zh-CN',
      'ja': 'ja-JP', 'ar': 'ar-SA',
    };
    if (p.language && langMap[p.language]) {
      // Voice system will use this language for recognition
      voiceCommands = new VoiceCommandSystem({
        lang: langMap[p.language],
        onCommand: (command: string, args: string) => {
          handleVoiceCommand(command, args);
        },
      });
    }
    if (p.motor?.voiceNavigationEnabled) getVoice().start();
    if (p.cognitive?.focusModeEnabled) getCognitive().enableFocusMode();
    if (p.cognitive?.distractionShield) getCognitive().enableDistractionShield();
    // Dwell click and eye tracking from profile
    const pm = profile as { motor?: { dwellClickEnabled?: boolean; dwellClickDelay?: number; eyeTrackingEnabled?: boolean } };
    if (pm.motor?.dwellClickEnabled) getDwell().start(pm.motor?.dwellClickDelay);
    if (pm.motor?.eyeTrackingEnabled) getEyeTracker().start();
  }).catch(() => {});

  console.log('[AccessBridge] Content script initialized (Day 2)');
}

init();
