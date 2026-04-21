/**
 * Compliance Observatory — in-memory counter collector + daily publish scheduler.
 *
 * Counters reset at local midnight. A deterministic-per-device publish hour in
 * the 02:00–05:00 local window spreads daily submissions across devices. The
 * chrome.alarms API wakes the service worker hourly to check.
 */

import {
  aggregateDailyBundle,
  publishDailyBundle,
  recordPublish,
  runDailyAttestation,
  shouldPublishNow,
  type RawCounters,
} from './observatory-publisher.js';

export const DAILY_ALARM_NAME = 'accessbridge-observatory-daily';

const STORAGE_COUNTERS = 'observatory_counters';
const STORAGE_DAYS_CONTRIBUTED = 'observatory_days_contributed';
const STORAGE_DEVICE_SALT = 'observatory_device_salt';

interface PersistedState {
  date: string;
  adaptations_applied: Record<string, number>;
  struggle_events_triggered: number;
  features_enabled: Record<string, number>;
  languages_used: string[];
  domain_connectors_activated: Record<string, number>;
  estimated_accessibility_score_improvement: number;
  /** Session 12: keys are 'tier0', 'tier1', 'tier2', 'fallback'. Session 17: adds 'tier3'. */
  onnx_inferences: Record<string, number>;
  /** Session 17: voice STT tier usage counts: 'a' (native), 'b' (onnx), 'c' (cloud). */
  voice_tier_counts: Record<string, number>;
}

function todayLocalISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function blankState(): PersistedState {
  return {
    date: todayLocalISO(),
    adaptations_applied: {},
    struggle_events_triggered: 0,
    features_enabled: {},
    languages_used: [],
    domain_connectors_activated: {},
    estimated_accessibility_score_improvement: 0,
    onnx_inferences: {},
    voice_tier_counts: {},
  };
}

export class ObservatoryCollector {
  private state: PersistedState = blankState();
  private hydrated = false;

  private rollIfNewDay(): void {
    const today = todayLocalISO();
    if (this.state.date !== today) {
      this.state = blankState();
    }
  }

  recordAdaptation(type: string): void {
    this.rollIfNewDay();
    this.state.adaptations_applied[type] =
      (this.state.adaptations_applied[type] ?? 0) + 1;
  }

  recordStruggleEvent(): void {
    this.rollIfNewDay();
    this.state.struggle_events_triggered += 1;
  }

  recordFeatureEnabled(feature: string): void {
    this.rollIfNewDay();
    this.state.features_enabled[feature] =
      (this.state.features_enabled[feature] ?? 0) + 1;
  }

  recordLanguageUsed(lang: string): void {
    this.rollIfNewDay();
    if (!this.state.languages_used.includes(lang)) {
      this.state.languages_used.push(lang);
    }
  }

  recordDomainConnector(domain: string): void {
    this.rollIfNewDay();
    this.state.domain_connectors_activated[domain] =
      (this.state.domain_connectors_activated[domain] ?? 0) + 1;
  }

  setScoreImprovement(value: number): void {
    this.rollIfNewDay();
    this.state.estimated_accessibility_score_improvement = Math.max(
      0,
      Math.min(100, Math.round(value)),
    );
  }

  /** Session 12: log a single ONNX inference. Session 17 adds 'tier3' (IndicWhisper). */
  recordOnnxInference(
    bucket: 'tier0' | 'tier1' | 'tier2' | 'tier3' | 'fallback',
  ): void {
    this.rollIfNewDay();
    this.state.onnx_inferences[bucket] =
      (this.state.onnx_inferences[bucket] ?? 0) + 1;
  }

  /** Session 17: log a single voice-STT utterance against tier 'a' | 'b' | 'c'. */
  recordVoiceTier(tier: 'a' | 'b' | 'c'): void {
    this.rollIfNewDay();
    this.state.voice_tier_counts[tier] =
      (this.state.voice_tier_counts[tier] ?? 0) + 1;
  }

  getRawCounters(): RawCounters {
    this.rollIfNewDay();
    return {
      adaptations_applied: { ...this.state.adaptations_applied },
      struggle_events_triggered: this.state.struggle_events_triggered,
      features_enabled: { ...this.state.features_enabled },
      languages_used: [...this.state.languages_used],
      domain_connectors_activated: { ...this.state.domain_connectors_activated },
      estimated_accessibility_score_improvement:
        this.state.estimated_accessibility_score_improvement,
      onnx_inferences: { ...this.state.onnx_inferences },
      voice_tier_counts: { ...this.state.voice_tier_counts },
    };
  }

  resetCounters(): void {
    this.state = blankState();
  }

  async hydrateFromStorage(): Promise<void> {
    if (this.hydrated) return;
    try {
      const res = await chrome.storage.local.get(STORAGE_COUNTERS);
      const persisted = res[STORAGE_COUNTERS] as PersistedState | undefined;
      if (persisted && persisted.date === todayLocalISO()) {
        this.state = { ...blankState(), ...persisted };
      }
    } catch {
      // Ignore — start with blank state.
    }
    this.hydrated = true;
  }

  async persistToStorage(): Promise<void> {
    try {
      await chrome.storage.local.set({ [STORAGE_COUNTERS]: this.state });
    } catch {
      // Non-fatal — we'll retry on next event.
    }
  }
}

// ---------- Deterministic publish-hour assignment ----------

function djb2Hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

async function getOrCreateDeviceSalt(): Promise<string> {
  const res = await chrome.storage.local.get(STORAGE_DEVICE_SALT);
  const existing = res[STORAGE_DEVICE_SALT];
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const buf = new Uint8Array(16);
  globalThis.crypto.getRandomValues(buf);
  let salt = '';
  for (const b of buf) salt += b.toString(16).padStart(2, '0');
  await chrome.storage.local.set({ [STORAGE_DEVICE_SALT]: salt });
  return salt;
}

/**
 * Deterministic publish hour in [2, 5] derived from device salt — spreads
 * submissions across the 4-hour low-traffic window so we don't DDoS the
 * observatory endpoint at any single clock-time.
 */
export async function getPublishHour(): Promise<number> {
  const salt = await getOrCreateDeviceSalt();
  return 2 + (djb2Hash(salt) % 4);
}

export async function incrementDaysContributed(): Promise<number> {
  const res = await chrome.storage.local.get(STORAGE_DAYS_CONTRIBUTED);
  const current = (res[STORAGE_DAYS_CONTRIBUTED] as number | undefined) ?? 0;
  const next = current + 1;
  await chrome.storage.local.set({ [STORAGE_DAYS_CONTRIBUTED]: next });
  return next;
}

/**
 * Install a 60-min repeating alarm. On each fire, publish if:
 *   - user is opted in (authoritative check reads from chrome.storage.local;
 *     MV3 service-worker wake may run this handler before any message path
 *     hydrates `currentProfile` in background/index.ts),
 *   - current local hour matches the device's deterministic publish hour,
 *   - at least 24h have elapsed since last publish.
 */
export function installDailyAlarm(
  collector: ObservatoryCollector,
  _isOptedInHint: () => boolean,
): void {
  chrome.alarms.create(DAILY_ALARM_NAME, { periodInMinutes: 60 });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== DAILY_ALARM_NAME) return;
    try {
      const stored = await chrome.storage.local.get('profile');
      const profile = stored.profile as { shareAnonymousMetrics?: boolean } | undefined;
      if (!profile || profile.shareAnonymousMetrics !== true) return;

      const hour = new Date().getHours();
      const publishHour = await getPublishHour();
      if (hour !== publishHour) return;
      if (!(await shouldPublishNow())) return;

      await collector.hydrateFromStorage();
      await collector.persistToStorage();
      const raw = collector.getRawCounters();
      const bundle = await aggregateDailyBundle(raw);
      // Session 16: ring-signed attestation is the primary path. The legacy
      // publishDailyBundle is retained but only invoked as a fallback if the
      // ring is empty (bootstrap phase — waiting on 2nd device to enroll).
      let result = await runDailyAttestation({ bundle });
      if (!result.ok && result.error && /ring-size-too-small/.test(result.error)) {
        result = await publishDailyBundle(bundle);
      }
      if (result.ok) {
        await recordPublish(Date.now());
        await incrementDaysContributed();
        collector.resetCounters();
        await collector.persistToStorage();
      } else {
        // Keep counters intact — alarm will retry next hour.
        console.warn('[observatory] publish failed:', result.error ?? result.status);
      }
    } catch (err) {
      console.error('[observatory] alarm handler error:', err);
    }
  });
}
