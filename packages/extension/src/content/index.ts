/**
 * AccessBridge Content Script
 * Detects the current application, sets up signal collection,
 * and applies accessibility adaptations.
 */

import type { Adaptation, BehaviorSignal } from '@accessbridge/core/types';
import { SignalType } from '@accessbridge/core/types';
import { SensoryAdapter } from './sensory/adapter.js';
import { GmailAdapter } from './adapters/gmail.js';
import { OutlookAdapter } from './adapters/outlook.js';
import { GenericAdapter } from './adapters/generic.js';
import type { BaseAdapter } from './adapters/base.js';

// ---------- App Detection ----------

type AppType = 'gmail' | 'outlook' | 'docs' | 'teams' | 'sap-fiori' | 'servicenow' | 'generic';

function detectApp(): AppType {
  const { hostname, pathname } = window.location;
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
const SIGNAL_FLUSH_INTERVAL = 5_000; // 5 seconds

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
      const velocity = distance / dt; // px/ms

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

    // Click accuracy: distance from center of target
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

    // Hesitation between clicks
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

        // Dwell detection – slow movement
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

  // Compute a simple struggle score from the batch
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
  }).catch(() => {
    // Extension context may be invalidated – ignore
  });
}

// ---------- Message listener from background ----------

function listenForCommands(adapter: BaseAdapter, sensory: SensoryAdapter): void {
  chrome.runtime.onMessage.addListener(
    (message: { type: string; payload?: unknown }, _sender, sendResponse) => {
      switch (message.type) {
        case 'APPLY_ADAPTATION': {
          const adaptation = message.payload as Adaptation;
          sensory.applyAdaptation(adaptation);
          adapter.apply(adaptation);
          sendResponse({ applied: true });
          break;
        }
        case 'REVERT_ADAPTATION': {
          const id = message.payload as string;
          adapter.revert(id);
          sendResponse({ reverted: true });
          break;
        }
        case 'REVERT_ALL': {
          sensory.revertAll();
          sendResponse({ reverted: true });
          break;
        }
        case 'PROFILE_UPDATED': {
          // Profile was updated – could trigger re-evaluation
          sendResponse({ received: true });
          break;
        }
      }
      return false;
    },
  );
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
      // Re-collect signals for new content regions if needed
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

  console.log('[AccessBridge] Content script initialized');
}

init();
