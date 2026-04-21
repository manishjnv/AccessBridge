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
import { EmailSummarizationUI } from './ai/email-ui.js';
import { matchAnyIndicCommand } from './motor/indic-commands.js';
import { DwellClickSystem } from './motor/dwell-click.js';
import { EyeTracker } from './motor/eye-tracker.js';
import { KeyboardOnlyMode } from './motor/keyboard-mode.js';
import { PredictiveInputSystem } from './motor/predictive-input.js';
import { DomainConnectorRegistry } from './domains/index.js';
import { TransliterationController } from './i18n/transliteration.js';
import { detectPageLanguage, detectedLangToVoiceLocale } from './i18n/language-detect.js';
import { collectAuditInput } from './audit-collector.js';
import { runAxeInPage } from './audit/axe-runner.js';
import {
  EnvironmentSensor,
  EnvironmentIndicator,
  showPermissionExplainer,
  getStoredDecision,
} from './context/index.js';
// --- Task C: Gesture Shortcuts ---
import { GestureController } from './motor/gestures.js';
// --- Priority 1: Captions + Actions ---
import { CaptionsController } from './sensory/captions.js';
import { ActionItemsExtractor } from './cognitive/action-items.js';
import { ActionItemsUI } from './cognitive/action-items-ui.js';
// --- Priority 5: Time-Awareness ---
import {
  TimeAwarenessController,
  ensureTimeAwarenessStyles,
} from './cognitive/time-awareness.js';
// --- Session 10: Vision-Assisted Semantic Recovery ---
import {
  VisionRecoveryController,
  registerVisionRecoveryHandlers,
} from './vision/recovery.js';
import { VisionRecoveryUI } from './vision/recovery-ui.js';
// --- Session 11: Multi-Modal Fusion (Layer 5) ---
import {
  FusionController,
  registerFusionStatsHandler,
} from './fusion/controller.js';

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
let keyboardMode: KeyboardOnlyMode | null = null;
let predictiveInput: PredictiveInputSystem | null = null;
let emailUI: EmailSummarizationUI | null = null;
let domainRegistry: DomainConnectorRegistry | null = null;
let transliterationCtl: TransliterationController | null = null;
let envSensor: EnvironmentSensor | null = null;
let envIndicator: EnvironmentIndicator | null = null;
let envSensingEnabled = false;
let envSensingUnsubscribe: (() => void) | null = null;
// --- Task C: Gesture Shortcuts ---
let gestureController: GestureController | null = null;
// --- Priority 1: Captions + Actions ---
let captionsController: CaptionsController | null = null;
let actionItemsExtractor: ActionItemsExtractor | null = null;
let actionItemsUI: ActionItemsUI | null = null;

function getCaptionsController(): CaptionsController {
  if (!captionsController) {
    captionsController = new CaptionsController({
      translate: (text, from, to) =>
        chrome.runtime
          .sendMessage({ type: 'AI_TRANSLATE', payload: { text, from, to } })
          .then((r: unknown) => {
            const res = r as { text?: string } | undefined;
            return res?.text ?? text;
          })
          .catch(() => text),
    });
  }
  return captionsController;
}

function captionsOptionsFromSensory(s: {
  captionsLanguage?: string;
  captionsTranslateTo?: string | null;
  captionsFontSize?: number;
  captionsPosition?: 'top' | 'bottom';
}) {
  return {
    ...(s.captionsLanguage !== undefined ? { language: s.captionsLanguage } : {}),
    ...(s.captionsTranslateTo !== undefined ? { targetLanguage: s.captionsTranslateTo } : {}),
    ...(s.captionsFontSize !== undefined ? { fontSize: s.captionsFontSize } : {}),
    ...(s.captionsPosition !== undefined ? { position: s.captionsPosition } : {}),
  };
}

function getActionItemsExtractor(): ActionItemsExtractor {
  if (!actionItemsExtractor) actionItemsExtractor = new ActionItemsExtractor();
  return actionItemsExtractor;
}

function getActionItemsUI(): ActionItemsUI {
  if (!actionItemsUI) actionItemsUI = new ActionItemsUI(getActionItemsExtractor());
  return actionItemsUI;
}

// --- Priority 5: Time-Awareness ---
let timeAwarenessController: TimeAwarenessController | null = null;
// --- Session 10: Vision Recovery ---
let visionRecoveryController: VisionRecoveryController | null = null;
let visionRecoveryUI: VisionRecoveryUI | null = null;
// --- Session 11: Multi-Modal Fusion ---
let fusionController: FusionController | null = null;

function getFusionController(): FusionController {
  if (!fusionController) {
    fusionController = new FusionController({ enabled: false });
  }
  return fusionController;
}

function getVisionRecovery(): VisionRecoveryController {
  if (!visionRecoveryController) {
    visionRecoveryController = new VisionRecoveryController({ enabled: false });
  }
  return visionRecoveryController;
}

function getVisionRecoveryUI(): VisionRecoveryUI {
  if (!visionRecoveryUI) visionRecoveryUI = new VisionRecoveryUI();
  return visionRecoveryUI;
}

function getTimeAwarenessController(): TimeAwarenessController {
  if (!timeAwarenessController) {
    ensureTimeAwarenessStyles();
    timeAwarenessController = new TimeAwarenessController();
  }
  return timeAwarenessController;
}

function getGestureController(): GestureController {
  if (!gestureController) {
    gestureController = new GestureController({
      enabled: false,
      showHints: true,
      minSwipeDistance: 50,
      longPressMs: 600,
      mouseModeRequiresShift: true,
    });
  }
  return gestureController;
}

function getTransliteration(): TransliterationController {
  if (!transliterationCtl) {
    transliterationCtl = new TransliterationController('devanagari');
  }
  return transliterationCtl;
}

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
    eyeTracker = new EyeTracker({
      // --- Session 11: tap gaze samples into fusion engine ---
      onGaze: (x: number, y: number) => {
        fusionController?.reportGaze(x, y);
      },
    });
  }
  return eyeTracker;
}

function getKeyboard(): KeyboardOnlyMode {
  if (!keyboardMode) {
    keyboardMode = new KeyboardOnlyMode();
  }
  return keyboardMode;
}

function getPredictive(): PredictiveInputSystem {
  if (!predictiveInput) {
    predictiveInput = new PredictiveInputSystem();
  }
  return predictiveInput;
}

function getEmailUI(): EmailSummarizationUI {
  if (!emailUI) {
    emailUI = new EmailSummarizationUI();
  }
  return emailUI;
}

function getDomainRegistry(): DomainConnectorRegistry {
  if (!domainRegistry) {
    domainRegistry = new DomainConnectorRegistry();
  }
  return domainRegistry;
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

// ---------- Environment sensor lifecycle ----------

async function startEnvironmentSensor(
  lightSampling: boolean,
  noiseSampling: boolean,
): Promise<void> {
  if (envSensor) return; // already running

  // Show in-page explainer before triggering the native getUserMedia prompt,
  // but only when at least one stream is requested and the user hasn't said 'deny' before.
  const wantLight = lightSampling;
  const wantNoise = noiseSampling;
  const needsExplainer = wantLight || wantNoise;

  if (needsExplainer) {
    const prior = await getStoredDecision();
    if (prior !== 'accept') {
      const choice = await showPermissionExplainer({ wantLight, wantNoise });
      if (choice === 'deny') {
        // Still start the sensor for time-of-day + network, but skip media streams.
        envSensor = new EnvironmentSensor({
          lightSamplingEnabled: false,
          noiseSamplingEnabled: false,
          samplingIntervalMs: 30_000,
        });
        await envSensor.start();
        bindEnvIndicator();
        bindEnvSnapshotForwarding();
        return;
      }
    }
  }

  envSensor = new EnvironmentSensor({
    lightSamplingEnabled: wantLight,
    noiseSamplingEnabled: wantNoise,
    samplingIntervalMs: 30_000,
  });
  await envSensor.start();
  bindEnvIndicator();
  bindEnvSnapshotForwarding();
}

function bindEnvIndicator(): void {
  if (!envSensor) return;
  if (!envIndicator) envIndicator = new EnvironmentIndicator();
  envIndicator.attach(envSensor);
}

function bindEnvSnapshotForwarding(): void {
  if (!envSensor) return;
  envSensingUnsubscribe = envSensor.onSnapshot((snapshot) => {
    chrome.runtime.sendMessage({
      type: 'ENVIRONMENT_UPDATE',
      payload: snapshot,
    }).catch(() => {});
    envIndicator?.refresh();
    // --- Session 11: feed env snapshot into fusion engine ---
    // NetworkQuality is a string enum ('poor' | 'fair' | 'good' | 'excellent').
    // Map to a 0-1 numeric quality proxy for the fusion pipeline.
    const netScoreMap: Record<string, number> = {
      poor: 0.2,
      fair: 0.5,
      good: 0.8,
      excellent: 1.0,
    };
    const snap = snapshot as unknown as {
      lightLevel?: number | null;
      noiseLevel?: number | null;
      networkQuality?: string;
    };
    fusionController?.reportEnvironment({
      lightLevel: typeof snap.lightLevel === 'number' ? snap.lightLevel : undefined,
      noiseLevel: typeof snap.noiseLevel === 'number' ? snap.noiseLevel : undefined,
      networkQuality:
        typeof snap.networkQuality === 'string'
          ? netScoreMap[snap.networkQuality] ?? 0.5
          : undefined,
    });
  });
}

function stopEnvironmentSensor(): void {
  if (envSensingUnsubscribe) {
    envSensingUnsubscribe();
    envSensingUnsubscribe = null;
  }
  if (envSensor) {
    envSensor.stop();
    envSensor = null;
  }
  if (envIndicator) {
    envIndicator.detach();
    envIndicator = null;
  }
}

// ---------- Voice command handler ----------

function handleVoiceCommand(command: string, args: string): void {
  // --- Session 11: tap voice command into fusion engine ---
  fusionController?.reportVoice(command + (args ? ' ' + args : ''), {
    final: true,
    snr: 0.8,
    transcriptConfidence: 0.85,
  });

  // Try native-script matching across all 10 Indic languages first.
  // If the transcript is an Indic phrase, it routes to the same English action.
  const indicMatch = matchAnyIndicCommand(command + (args ? ' ' + args : ''));
  if (indicMatch) {
    handleVoiceCommand(indicMatch.result.action, indicMatch.result.args);
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
        case 'APPLY_SENSORY': {
          const s = message.payload as {
            fontScale?: number; contrastLevel?: number; lineHeight?: number;
            letterSpacing?: number; colorCorrectionMode?: string;
            reducedMotion?: boolean; highContrast?: boolean;
          };
          if (s.fontScale !== undefined) {
            if (s.fontScale !== 1.0) sensory.applyFontScale(s.fontScale);
            else document.body.style.zoom = '';
          }
          if (s.contrastLevel !== undefined) {
            sensory.applyContrast(s.contrastLevel);
          }
          if (s.lineHeight !== undefined) {
            if (s.lineHeight !== 1.5) sensory.applyLineHeight(s.lineHeight);
            else document.getElementById('a11y-rule-a11y-line-height')?.remove();
          }
          if (s.letterSpacing !== undefined) {
            if (s.letterSpacing !== 0) sensory.applyLetterSpacing(s.letterSpacing);
            else document.getElementById('a11y-rule-a11y-letter-spacing')?.remove();
          }
          if (s.colorCorrectionMode !== undefined) sensory.applyColorCorrection(s.colorCorrectionMode);
          if (s.reducedMotion !== undefined) sensory.applyReducedMotion(s.reducedMotion);
          if (s.highContrast !== undefined) sensory.applyHighContrast(s.highContrast);
          sendResponse({ applied: true });
          break;
        }
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
          getKeyboard().stop();
          getPredictive().stop();
          getEmailUI().stop();
          getAI().dismiss();
          getDomainRegistry().deactivateAll();
          getTransliteration().stop();
          stopEnvironmentSensor();
          envSensingEnabled = false;
          // --- Task C: Gesture Shortcuts ---
          gestureController?.stop();
          // --- Priority 1: Captions + Actions ---
          captionsController?.stop();
          actionItemsExtractor?.stop();
          actionItemsUI?.unmount();
          // --- Priority 5: Time-Awareness ---
          timeAwarenessController?.stop();
          // --- Session 10: Vision Recovery ---
          visionRecoveryController?.stop();
          visionRecoveryUI?.unmount();
          // --- Session 11: Multi-Modal Fusion ---
          fusionController?.stop();
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
        case 'TOGGLE_KEYBOARD_MODE': {
          const { enabled: kbEnabled } = message.payload as { enabled: boolean };
          if (kbEnabled) getKeyboard().start();
          else getKeyboard().stop();
          sendResponse({ success: true });
          break;
        }
        case 'TOGGLE_PREDICTIVE_INPUT': {
          const { enabled: piEnabled } = message.payload as { enabled: boolean };
          if (piEnabled) getPredictive().start();
          else getPredictive().stop();
          sendResponse({ success: true });
          break;
        }
        case 'AUDIT_SCAN_REQUEST': {
          try {
            const input = collectAuditInput();
            sendResponse({ input });
          } catch (err) {
            sendResponse({ error: String(err) });
          }
          break;
        }
        case 'AUDIT_RUN_AXE': {
          // Session 18: axe-core runs in the page's MAIN world via script
          // injection. The promise can take up to 30 s on slow/large pages —
          // respond asynchronously by returning `true` from the listener.
          runAxeInPage()
            .then((envelope) => sendResponse(envelope))
            .catch((err) => sendResponse({ error: String(err) }));
          return true;
        }
        case 'HIGHLIGHT_ELEMENT': {
          const { selector } = message.payload as { selector: string };
          try {
            const target = selector ? document.querySelector(selector) : null;
            if (target instanceof HTMLElement) {
              const prevOutline = target.style.outline;
              const prevOffset = target.style.outlineOffset;
              const prevShadow = target.style.boxShadow;
              const prevTransition = target.style.transition;
              target.style.outline = '3px solid #e94560';
              target.style.outlineOffset = '2px';
              target.style.boxShadow = '0 0 0 6px rgba(233, 69, 96, 0.25)';
              target.style.transition = 'outline 0.2s ease, box-shadow 0.2s ease';
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              setTimeout(() => {
                target.style.outline = prevOutline;
                target.style.outlineOffset = prevOffset;
                target.style.boxShadow = prevShadow;
                target.style.transition = prevTransition;
              }, 3000);
              sendResponse({ found: true });
            } else {
              sendResponse({ found: false });
            }
          } catch (err) {
            sendResponse({ error: String(err) });
          }
          break;
        }
        case 'PROFILE_UPDATED': {
          const updatedProfile = message.payload as {
            sensory?: { fontScale?: number; contrastLevel?: number; lineHeight?: number; letterSpacing?: number; colorCorrectionMode?: string; reducedMotion?: boolean; highContrast?: boolean };
            motor?: { gestureShortcutsEnabled?: boolean; gestureShowHints?: boolean; gestureMouseModeRequiresShift?: boolean };
            transliterationEnabled?: boolean;
            transliterationScript?: 'devanagari' | 'tamil' | 'telugu' | 'kannada';
            environmentSensingEnabled?: boolean;
            environmentLightSampling?: boolean;
            environmentNoiseSampling?: boolean;
          };

          // --- Task C: Gesture Shortcuts ---
          if (updatedProfile?.motor) {
            const m = updatedProfile.motor;
            const ctl = getGestureController();
            if (m.gestureShowHints !== undefined || m.gestureMouseModeRequiresShift !== undefined) {
              ctl.setOptions({
                ...(m.gestureShowHints !== undefined ? { showHints: m.gestureShowHints } : {}),
                ...(m.gestureMouseModeRequiresShift !== undefined ? { mouseModeRequiresShift: m.gestureMouseModeRequiresShift } : {}),
              });
            }
            if (m.gestureShortcutsEnabled === true) {
              ctl.setOptions({ enabled: true });
              ctl.start();
            } else if (m.gestureShortcutsEnabled === false) {
              ctl.stop();
            }
          }

          if (typeof updatedProfile?.environmentSensingEnabled === 'boolean') {
            const shouldEnable = updatedProfile.environmentSensingEnabled;
            if (shouldEnable && !envSensingEnabled) {
              envSensingEnabled = true;
              const light = updatedProfile.environmentLightSampling ?? true;
              const noise = updatedProfile.environmentNoiseSampling ?? true;
              startEnvironmentSensor(light, noise).catch((err) => {
                console.warn('[AccessBridge] env sensor start failed', err);
              });
            } else if (!shouldEnable && envSensingEnabled) {
              envSensingEnabled = false;
              stopEnvironmentSensor();
            } else if (shouldEnable && envSensingEnabled) {
              const light = updatedProfile.environmentLightSampling ?? true;
              const noise = updatedProfile.environmentNoiseSampling ?? true;
              const currentLight = envSensor?.isLightActive() ?? false;
              const currentNoise = envSensor?.isNoiseActive() ?? false;
              if (light !== currentLight || noise !== currentNoise) {
                stopEnvironmentSensor();
                startEnvironmentSensor(light, noise).catch(() => {});
              }
            }
          }

          if (updatedProfile?.transliterationEnabled !== undefined) {
            const ctl = getTransliteration();
            if (updatedProfile.transliterationScript) ctl.setScript(updatedProfile.transliterationScript);
            if (updatedProfile.transliterationEnabled) ctl.start();
            else ctl.stop();
          } else if (updatedProfile?.transliterationScript) {
            getTransliteration().setScript(updatedProfile.transliterationScript);
          }
          if (updatedProfile?.sensory) {
            const s = updatedProfile.sensory;
            if (s.fontScale !== undefined && s.fontScale !== 1.0) sensory.applyFontScale(s.fontScale);
            if (s.contrastLevel !== undefined && s.contrastLevel !== 1.0) sensory.applyContrast(s.contrastLevel);
            if (s.lineHeight !== undefined && s.lineHeight !== 1.5) sensory.applyLineHeight(s.lineHeight);
            if (s.letterSpacing !== undefined && s.letterSpacing !== 0) sensory.applyLetterSpacing(s.letterSpacing);
            if (s.colorCorrectionMode !== undefined) sensory.applyColorCorrection(s.colorCorrectionMode);
            if (s.reducedMotion !== undefined) sensory.applyReducedMotion(s.reducedMotion);
            if (s.highContrast !== undefined && s.highContrast) document.body.classList.add('a11y-high-contrast');
            else document.body.classList.remove('a11y-high-contrast');
            // Reset to defaults if values are back to normal
            if (s.fontScale === 1.0) { document.documentElement.style.removeProperty('--a11y-font-scale'); document.body.classList.remove('a11y-font-scaled'); }
            if (s.contrastLevel === 1.0) { document.documentElement.style.removeProperty('--a11y-contrast'); document.body.classList.remove('a11y-contrast'); }
            if (s.lineHeight === 1.5) { document.documentElement.style.removeProperty('--a11y-line-height'); document.body.classList.remove('a11y-line-height'); }
            if (s.letterSpacing === 0) { document.documentElement.style.removeProperty('--a11y-letter-spacing'); document.body.classList.remove('a11y-letter-spacing'); }
            // --- Priority 1: Captions + Actions ---
            const sCap = s as {
              liveCaptionsEnabled?: boolean;
              captionsLanguage?: string;
              captionsTranslateTo?: string | null;
              captionsFontSize?: number;
              captionsPosition?: 'top' | 'bottom';
            };
            const capPatch = captionsOptionsFromSensory(sCap);
            if (Object.keys(capPatch).length > 0) {
              getCaptionsController().configure(capPatch);
            }
            if (typeof sCap.liveCaptionsEnabled === 'boolean') {
              if (sCap.liveCaptionsEnabled) getCaptionsController().start();
              else captionsController?.stop();
            }
          }
          // --- Priority 1: Captions + Actions ---
          {
            const p = updatedProfile as {
              cognitive?: {
                actionItemsEnabled?: boolean;
                actionItemsAutoScan?: boolean;
                actionItemsMinConfidence?: number;
              };
            };
            const c = p.cognitive;
            if (c) {
              const confPatch: { minConfidence?: number } = {};
              if (typeof c.actionItemsMinConfidence === 'number') {
                confPatch.minConfidence = c.actionItemsMinConfidence;
              }
              if (Object.keys(confPatch).length > 0) {
                getActionItemsExtractor().configure(confPatch);
              }
              if (typeof c.actionItemsEnabled === 'boolean') {
                if (c.actionItemsEnabled) {
                  if (c.actionItemsAutoScan !== false) {
                    getActionItemsExtractor().watch(confPatch);
                  } else {
                    getActionItemsExtractor().scan(confPatch);
                  }
                  getActionItemsUI().mount();
                } else {
                  actionItemsExtractor?.stop();
                  actionItemsUI?.unmount();
                }
              } else if (typeof c.actionItemsMinConfidence === 'number') {
                // min-confidence changed while UI mounted — refresh
                actionItemsUI?.refresh();
              }
            }
          }
          // --- Priority 5: Time-Awareness ---
          {
            const p = updatedProfile as { cognitive?: { timeAwarenessEnabled?: boolean } };
            if (typeof p.cognitive?.timeAwarenessEnabled === 'boolean') {
              if (p.cognitive.timeAwarenessEnabled) getTimeAwarenessController().start();
              else timeAwarenessController?.stop();
            }
          }
          // --- Session 11: Multi-Modal Fusion ---
          {
            const f = updatedProfile as {
              fusionEnabled?: boolean;
              fusionWindowMs?: number;
              fusionCompensationEnabled?: boolean;
              fusionIntentMinConfidence?: number;
            };
            const ctl = getFusionController();
            const patch: Partial<{
              windowMs: number;
              compensationEnabled: boolean;
              intentMinConfidence: number;
            }> = {};
            if (typeof f.fusionWindowMs === 'number') patch.windowMs = f.fusionWindowMs;
            if (typeof f.fusionCompensationEnabled === 'boolean')
              patch.compensationEnabled = f.fusionCompensationEnabled;
            if (typeof f.fusionIntentMinConfidence === 'number')
              patch.intentMinConfidence = f.fusionIntentMinConfidence;
            if (Object.keys(patch).length > 0) ctl.setOptions(patch);
            if (f.fusionEnabled === true && !ctl.isRunning()) {
              ctl.setOptions({ enabled: true });
              ctl.start();
            } else if (f.fusionEnabled === false && ctl.isRunning()) {
              ctl.stop();
            }
          }
          // --- Session 10: Vision Recovery ---
          {
            const sVis = updatedProfile?.sensory as {
              visionRecoveryEnabled?: boolean;
              visionRecoveryAutoScan?: boolean;
              visionRecoveryTier2APIEnabled?: boolean;
              visionRecoveryHighlightRecovered?: boolean;
              visionRecoveryMinConfidence?: number;
            } | undefined;
            if (sVis) {
              const ctl = getVisionRecovery();
              const patch: Partial<{
                autoScan: boolean;
                tier2Enabled: boolean;
                minConfidence: number;
                highlightRecovered: boolean;
              }> = {};
              if (sVis.visionRecoveryAutoScan !== undefined) patch.autoScan = sVis.visionRecoveryAutoScan;
              if (sVis.visionRecoveryTier2APIEnabled !== undefined) patch.tier2Enabled = sVis.visionRecoveryTier2APIEnabled;
              if (sVis.visionRecoveryMinConfidence !== undefined) patch.minConfidence = sVis.visionRecoveryMinConfidence;
              if (sVis.visionRecoveryHighlightRecovered !== undefined) patch.highlightRecovered = sVis.visionRecoveryHighlightRecovered;
              if (Object.keys(patch).length > 0) ctl.setOptions(patch);
              if (sVis.visionRecoveryEnabled === true) {
                ctl.setOptions({ enabled: true });
                getVisionRecoveryUI().mount();
                ctl.setOnResults((results) => {
                  const ui = getVisionRecoveryUI();
                  ui.setResults(results);
                  ui.setStats(ctl.getCacheStats());
                });
                ctl.start().catch(() => {});
              } else if (sVis.visionRecoveryEnabled === false) {
                ctl.stop();
                visionRecoveryUI?.unmount();
              }
            }
          }
          sendResponse({ received: true });
          break;
        }
        case 'TOGGLE_FEATURE_DIRECT': {
          const { feature, enabled } = message.payload as { feature: string; enabled: boolean };
          switch (feature) {
            case 'focus-mode':
              if (enabled) getCognitive().enableFocusMode();
              else getCognitive().disableFocusMode();
              break;
            case 'reading-mode':
              if (enabled) getCognitive().enableReadingGuide();
              else getCognitive().disableReadingGuide();
              break;
            case 'distraction-shield':
              if (enabled) getCognitive().enableDistractionShield();
              else getCognitive().disableDistractionShield();
              break;
            case 'auto-summarize':
              if (enabled) getAI().summarizePage(true).catch(() => {});
              else getAI().dismiss();
              break;
            case 'text-simplify':
              if (enabled) getAI().simplifyContent('mild').catch(() => {});
              else getAI().dismiss();
              break;
            case 'voice-nav':
              if (enabled) getVoice().start();
              else getVoice().stop();
              break;
            case 'eye-tracking':
              if (enabled) getEyeTracker().start();
              else getEyeTracker().stop();
              break;
            case 'smart-targets':
              if (enabled) adapter.apply({ id: 'direct-smart-targets', type: AdaptationType.CLICK_TARGET_ENLARGE, value: true, confidence: 1, applied: true, timestamp: Date.now(), reversible: true });
              else adapter.revert('direct-smart-targets');
              break;
            case 'keyboard-only':
              if (enabled) getKeyboard().start();
              else getKeyboard().stop();
              break;
            case 'predictive-input':
              if (enabled) getPredictive().start();
              else getPredictive().stop();
              break;
          }
          sendResponse({ success: true });
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
    case AdaptationType.KEYBOARD_ONLY:
      if (adaptation.value) getKeyboard().start();
      else getKeyboard().stop();
      break;
    case AdaptationType.PREDICTIVE_INPUT:
      if (adaptation.value) getPredictive().start();
      else getPredictive().stop();
      break;

    default:
      adapter.apply(adaptation);
      break;
  }
}

function revertAdaptation(id: string, adapter: BaseAdapter, _sensory: SensoryAdapter): void {
  // Check if this is a manual feature toggle (id format: "manual-{feature}-{timestamp}")
  if (id.startsWith('manual-')) {
    const feature = id.replace(/^manual-/, '').replace(/-\d+$/, '');
    switch (feature) {
      case 'focus-mode': getCognitive().disableFocusMode(); return;
      case 'reading-mode': getCognitive().disableReadingGuide(); return;
      case 'distraction-shield': getCognitive().disableDistractionShield(); return;
      case 'auto-summarize': getAI().dismiss(); return;
      case 'text-simplify': getAI().dismiss(); return;
      case 'voice-nav': getVoice().stop(); return;
      case 'eye-tracking': getEyeTracker().stop(); return;
      case 'keyboard-only': getKeyboard().stop(); return;
      case 'predictive-input': getPredictive().stop(); return;
    }
  }
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

  // --- Session 10: Vision Recovery — register message handlers ---
  registerVisionRecoveryHandlers(() => getVisionRecovery());

  // --- Session 11: Multi-Modal Fusion — register stats message handler ---
  registerFusionStatsHandler(() => fusionController);

  // Watch for dynamic content
  observeDynamicContent(adapter);

  // Start fatigue monitoring
  getFatigue().start();

  // Start email summarization UI on email providers
  if (app === 'gmail' || app === 'outlook' || app === 'generic') {
    getEmailUI().start(getAI());
  }

  // Detect and activate domain-specific connector (banking, insurance, etc.)
  getDomainRegistry().detectAndActivate();

  // Load profile for language / transliteration settings.
  chrome.runtime.sendMessage({ type: 'GET_PROFILE' }).then((profile) => {
    if (!profile || typeof profile !== 'object') return;
    const p = profile as {
      language?: string;
      autoDetectLanguage?: boolean;
      transliterationEnabled?: boolean;
      transliterationScript?: 'devanagari' | 'tamil' | 'telugu' | 'kannada';
      motor?: {
        gestureShortcutsEnabled?: boolean;
        gestureShowHints?: boolean;
        gestureMouseModeRequiresShift?: boolean;
      };
      sensory?: {
        liveCaptionsEnabled?: boolean;
        captionsLanguage?: string;
        captionsTranslateTo?: string | null;
        captionsFontSize?: number;
        captionsPosition?: 'top' | 'bottom';
      };
      cognitive?: {
        actionItemsEnabled?: boolean;
        actionItemsAutoScan?: boolean;
        actionItemsMinConfidence?: number;
        // --- Priority 5: Time-Awareness ---
        timeAwarenessEnabled?: boolean;
      };
    } & {
      // --- Session 10: Vision Recovery ---
      sensory?: {
        visionRecoveryEnabled?: boolean;
        visionRecoveryAutoScan?: boolean;
        visionRecoveryTier2APIEnabled?: boolean;
        visionRecoveryHighlightRecovered?: boolean;
        visionRecoveryMinConfidence?: number;
      };
    };
    // --- Priority 1: Captions + Actions ---
    if (p.cognitive?.actionItemsEnabled !== false) {
      const minConfidence = p.cognitive?.actionItemsMinConfidence;
      const opts = typeof minConfidence === 'number' ? { minConfidence } : {};
      if (p.cognitive?.actionItemsAutoScan !== false) {
        getActionItemsExtractor().watch(opts);
      } else {
        getActionItemsExtractor().scan(opts);
      }
      getActionItemsUI().mount();
    }
    if (p.sensory) {
      const capPatch = captionsOptionsFromSensory(p.sensory);
      if (Object.keys(capPatch).length > 0) getCaptionsController().configure(capPatch);
    }
    if (p.sensory?.liveCaptionsEnabled === true) {
      getCaptionsController().start();
    }
    // --- Priority 5: Time-Awareness (on by default) ---
    {
      const ta = (p.cognitive as { timeAwarenessEnabled?: boolean } | undefined)?.timeAwarenessEnabled;
      if (ta !== false) {
        getTimeAwarenessController().start();
      }
    }

    // --- Task C: Gesture Shortcuts ---
    if (p.motor?.gestureShortcutsEnabled) {
      const ctl = getGestureController();
      ctl.setOptions({
        enabled: true,
        showHints: p.motor.gestureShowHints ?? true,
        mouseModeRequiresShift: p.motor.gestureMouseModeRequiresShift ?? true,
      });
      ctl.start();
    }

    // BCP-47 mapping covering 28 languages: English + 10 Indian + 17 global.
    const langMap: Record<string, string> = {
      en: 'en-US',
      // 10 Indian languages (native-script commands in indic-commands.ts)
      hi: 'hi-IN', bn: 'bn-IN', ur: 'ur-IN', pa: 'pa-IN', mr: 'mr-IN',
      te: 'te-IN', ta: 'ta-IN', gu: 'gu-IN', kn: 'kn-IN', ml: 'ml-IN',
      // 6 existing global languages
      es: 'es-ES', fr: 'fr-FR', de: 'de-DE', zh: 'zh-CN',
      ja: 'ja-JP', ar: 'ar-SA',
      // 11 new global languages
      pt: 'pt-BR', ru: 'ru-RU', id: 'id-ID', tr: 'tr-TR', vi: 'vi-VN',
      ko: 'ko-KR', tl: 'fil-PH', fa: 'fa-IR', it: 'it-IT', th: 'th-TH',
      pl: 'pl-PL',
    };

    let voiceLocale: string | undefined = p.language ? langMap[p.language] : undefined;

    // Auto-detection overrides explicit setting when a non-English page is found.
    if (p.autoDetectLanguage) {
      try {
        const detection = detectPageLanguage();
        const auto = detectedLangToVoiceLocale(detection.detected);
        if (auto) voiceLocale = auto;
        console.log(`[AccessBridge] Page language auto-detected: ${detection.detected} (sample=${detection.sampleSize})`);
      } catch (err) {
        console.warn('[AccessBridge] Page language detection failed', err);
      }
    }

    if (voiceLocale) {
      voiceCommands = new VoiceCommandSystem({
        lang: voiceLocale,
        onCommand: (command: string, args: string) => {
          handleVoiceCommand(command, args);
        },
      });
    }

    if (p.transliterationEnabled) {
      const ctl = getTransliteration();
      ctl.setScript(p.transliterationScript ?? 'devanagari');
      ctl.start();
    }

    // --- Session 10: Vision Recovery (opt-in, defaults on) ---
    {
      const sVis = p.sensory as {
        visionRecoveryEnabled?: boolean;
        visionRecoveryAutoScan?: boolean;
        visionRecoveryTier2APIEnabled?: boolean;
        visionRecoveryHighlightRecovered?: boolean;
        visionRecoveryMinConfidence?: number;
      } | undefined;
      if (sVis?.visionRecoveryEnabled) {
        const ctl = getVisionRecovery();
        ctl.setOptions({
          enabled: true,
          autoScan: sVis.visionRecoveryAutoScan ?? true,
          tier2Enabled: sVis.visionRecoveryTier2APIEnabled ?? false,
          highlightRecovered: sVis.visionRecoveryHighlightRecovered ?? false,
          minConfidence: sVis.visionRecoveryMinConfidence ?? 0.6,
        });
        getVisionRecoveryUI().mount();
        ctl.setOnResults((results) => {
          const ui = getVisionRecoveryUI();
          ui.setResults(results);
          ui.setStats(ctl.getCacheStats());
        });
        ctl.start().catch(() => {});
      }
    }

    const envProfile = profile as {
      environmentSensingEnabled?: boolean;
      environmentLightSampling?: boolean;
      environmentNoiseSampling?: boolean;
    };
    if (envProfile.environmentSensingEnabled) {
      envSensingEnabled = true;
      const light = envProfile.environmentLightSampling ?? true;
      const noise = envProfile.environmentNoiseSampling ?? true;
      startEnvironmentSensor(light, noise).catch((err) => {
        console.warn('[AccessBridge] env sensor start failed', err);
      });
    }

    // --- Session 11: Multi-Modal Fusion init (profile-driven, default on) ---
    {
      const fProfile = profile as {
        fusionEnabled?: boolean;
        fusionWindowMs?: number;
        fusionCompensationEnabled?: boolean;
        fusionIntentMinConfidence?: number;
      };
      if (fProfile.fusionEnabled !== false) {
        const ctl = getFusionController();
        ctl.setOptions({
          enabled: true,
          windowMs: fProfile.fusionWindowMs ?? 3000,
          compensationEnabled: fProfile.fusionCompensationEnabled ?? true,
          intentMinConfidence: fProfile.fusionIntentMinConfidence ?? 0.65,
        });
        ctl.start();
      }
    }
  }).catch(() => {});

  // Listen for feature toggle changes via storage (survives popup close)
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.activeFeatures) return;
    const oldFeatures = (changes.activeFeatures.oldValue as Record<string, boolean>) || {};
    const newFeatures = (changes.activeFeatures.newValue as Record<string, boolean>) || {};

    for (const [feature, enabled] of Object.entries(newFeatures)) {
      if (oldFeatures[feature] === enabled) continue; // no change
      console.log(`[AccessBridge] Feature toggled via storage: ${feature} = ${enabled}`);
      switch (feature) {
        case 'focus-mode':
          if (enabled) getCognitive().enableFocusMode();
          else getCognitive().disableFocusMode();
          break;
        case 'reading-mode':
          if (enabled) getCognitive().enableReadingGuide();
          else getCognitive().disableReadingGuide();
          break;
        case 'distraction-shield':
          if (enabled) getCognitive().enableDistractionShield();
          else getCognitive().disableDistractionShield();
          break;
        case 'auto-summarize':
          if (enabled) getAI().summarizePage(true).catch(() => {});
          else getAI().dismiss();
          break;
        case 'text-simplify':
          if (enabled) getAI().simplifyContent('mild').catch(() => {});
          else getAI().dismiss();
          break;
        case 'voice-nav':
          if (enabled) getVoice().start();
          else getVoice().stop();
          break;
        case 'eye-tracking':
          if (enabled) getEyeTracker().start();
          else getEyeTracker().stop();
          break;
        case 'smart-targets':
          if (enabled) adapter.apply({ id: 'direct-smart-targets', type: AdaptationType.CLICK_TARGET_ENLARGE, value: true, confidence: 1, applied: true, timestamp: Date.now(), reversible: true });
          else adapter.revert('direct-smart-targets');
          break;
        case 'keyboard-only':
          if (enabled) getKeyboard().start();
          else getKeyboard().stop();
          break;
        case 'predictive-input':
          if (enabled) getPredictive().start();
          else getPredictive().stop();
          break;
      }
    }
  });

  console.log('[AccessBridge] Content script initialized (Day 2)');
}

init();
