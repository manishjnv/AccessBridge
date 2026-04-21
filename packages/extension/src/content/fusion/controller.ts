/**
 * Session 11: Multi-Modal Fusion — content-side orchestrator.
 *
 * Owns a FusionEngine instance. Wires all active sensors (keyboard, mouse,
 * touch, screen, environment, gaze, voice) into a single unified event stream
 * via adapter factories. Subscribes to the engine's fused context + intent
 * hypotheses and forwards high-confidence intents to the service worker for
 * decision-engine evaluation.
 *
 * All fusion stays on-device. The only cross-origin surface is the existing
 * `chrome.runtime.sendMessage` to our own background — no raw event data
 * leaves the tab.
 *
 * IIFE-safe: no short module-level vars (see RCA BUG-008 / BUG-012).
 */

import type {
  FusedContext,
  FusionStats,
  IntentHypothesis,
  EnvironmentConditions,
} from '@accessbridge/core/types';
import { FusionEngine } from '@accessbridge/core/fusion';
import {
  attachKeyboardAdapter,
  attachMouseAdapter,
  attachTouchAdapter,
  attachScreenAdapter,
  emitGazeSample,
  emitVoiceSample,
  emitEnvironmentSample,
  snapshotToConditions,
  type Unsubscribe,
} from './adapters.js';

export interface FusionControllerOptions {
  enabled: boolean;
  windowMs: number;
  compensationEnabled: boolean;
  intentMinConfidence: number;
}

export const DEFAULT_FUSION_CONTROLLER_OPTS: FusionControllerOptions = {
  enabled: false,
  windowMs: 3000,
  compensationEnabled: true,
  intentMinConfidence: 0.65,
};

export class FusionController {
  private engine: FusionEngine | null = null;
  private opts: FusionControllerOptions;
  private unsubscribers: Unsubscribe[] = [];
  private intentUnsub: (() => void) | null = null;
  private contextUnsub: (() => void) | null = null;
  private running = false;
  private lastIntentByType: Map<string, number> = new Map();
  private recentContext: FusedContext | null = null;

  constructor(opts: Partial<FusionControllerOptions> = {}) {
    this.opts = { ...DEFAULT_FUSION_CONTROLLER_OPTS, ...opts };
  }

  setOptions(patch: Partial<FusionControllerOptions>): void {
    this.opts = { ...this.opts, ...patch };
    if (this.engine && this.running) {
      if (patch.windowMs !== undefined || patch.compensationEnabled !== undefined) {
        this.stop();
        this.start();
      }
    }
  }

  getOptions(): FusionControllerOptions {
    return { ...this.opts };
  }

  start(): void {
    if (this.running || !this.opts.enabled) return;

    this.engine = new FusionEngine({
      windowMs: this.opts.windowMs,
      compensationRulesEnabled: this.opts.compensationEnabled,
      intentMinConfidence: this.opts.intentMinConfidence,
    });

    const ingest = this.engine.ingest.bind(this.engine);
    this.unsubscribers.push(attachKeyboardAdapter(ingest));
    this.unsubscribers.push(attachMouseAdapter(ingest));
    this.unsubscribers.push(attachTouchAdapter(ingest));
    this.unsubscribers.push(attachScreenAdapter(ingest));

    this.contextUnsub = this.engine.subscribe((ctx) => {
      this.recentContext = ctx;
    });

    this.intentUnsub = this.engine.subscribeIntent((hypothesis) => {
      this.onIntent(hypothesis);
    });

    this.engine.start();
    this.running = true;
  }

  stop(): void {
    this.running = false;
    for (const u of this.unsubscribers) {
      try {
        u();
      } catch {
        // no-op
      }
    }
    this.unsubscribers = [];
    if (this.intentUnsub) {
      this.intentUnsub();
      this.intentUnsub = null;
    }
    if (this.contextUnsub) {
      this.contextUnsub();
      this.contextUnsub = null;
    }
    if (this.engine) {
      this.engine.dispose();
      this.engine = null;
    }
    this.recentContext = null;
    this.lastIntentByType.clear();
  }

  /** Called by the integrating module when EyeTracker emits a gaze sample. */
  reportGaze(
    x: number,
    y: number,
    quality?: { brightness?: number; faceDetected?: boolean; blinkRate?: number },
  ): void {
    if (!this.engine || !this.running) return;
    emitGazeSample(this.engine.ingest.bind(this.engine), x, y, quality);
  }

  /** Called by the integrating module when Voice commands emits a transcript. */
  reportVoice(
    transcript: string,
    opts?: { final?: boolean; snr?: number; transcriptConfidence?: number },
  ): void {
    if (!this.engine || !this.running) return;
    emitVoiceSample(this.engine.ingest.bind(this.engine), transcript, opts);
  }

  /** Called when EnvironmentSensor emits a new snapshot. */
  reportEnvironment(snapshot: {
    lightLevel?: number;
    noiseLevel?: number;
    networkQuality?: number;
  }): void {
    if (!this.engine || !this.running) return;
    emitEnvironmentSample(this.engine.ingest.bind(this.engine), snapshot);
    const conditions = snapshotToConditions(snapshot);
    this.engine.setEnvironmentConditions(conditions as Partial<EnvironmentConditions>);
  }

  getCurrentContext(): FusedContext | null {
    if (!this.engine) return null;
    return this.engine.getCurrentContext();
  }

  getStats(): FusionStats | null {
    if (!this.engine) return null;
    return this.engine.getStats();
  }

  getCompensationWeights(): Record<string, number> {
    if (!this.engine) return {};
    return this.engine.getCompensationWeights();
  }

  getActiveCompensationRules(): string[] {
    if (!this.engine) return [];
    return this.engine.getActiveCompensationRules();
  }

  isRunning(): boolean {
    return this.running;
  }

  private onIntent(hypothesis: IntentHypothesis): void {
    const lastFireT = this.lastIntentByType.get(hypothesis.intent) ?? 0;
    const nowT = Date.now();
    // Rate-limit: fire each intent-type at most once per 1500ms to avoid
    // flooding the decision engine with repeated hypotheses.
    if (nowT - lastFireT < 1500) return;
    this.lastIntentByType.set(hypothesis.intent, nowT);

    try {
      chrome.runtime
        .sendMessage({
          type: 'FUSION_INTENT_EMITTED',
          payload: {
            intent: hypothesis.intent,
            confidence: hypothesis.confidence,
            suggestedAdaptations: hypothesis.suggestedAdaptations,
            // Intentionally NOT forwarding supportingEvents raw data —
            // only IDs + intent-level summary crosses the bridge.
            supportingEventCount: hypothesis.supportingEvents.length,
            timestamp: nowT,
          },
        })
        .catch(() => {});
    } catch {
      // sendMessage can throw if the SW is cold; swallowed — the next
      // emit will retry.
    }
  }
}

/** Register a listener for FUSION_GET_STATS messages from popup/sidepanel. */
export function registerFusionStatsHandler(
  getController: () => FusionController | null,
): void {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'FUSION_GET_STATS') return false;
    const ctl = getController();
    if (!ctl || !ctl.isRunning()) {
      sendResponse({ running: false });
      return false;
    }
    const stats = ctl.getStats();
    const ctx = ctl.getCurrentContext();
    sendResponse({
      running: true,
      stats,
      weights: ctl.getCompensationWeights(),
      activeRules: ctl.getActiveCompensationRules(),
      environmentConditions: ctx?.environmentConditions ?? null,
      channelQualities: ctx?.channelQualities ?? null,
    });
    return false;
  });
}
