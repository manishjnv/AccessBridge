/**
 * Session 11: Multi-Modal Fusion — "Intelligence" side-panel tab.
 *
 * Streams channel-quality bars, the recent intent timeline, and cross-modal
 * compensation state from the active tab's FusionController (via the
 * background service worker's FUSION_GET_STATS / FUSION_GET_HISTORY forwards).
 *
 * Read-only — all mutation goes through the popup Settings section.
 */

import React, { useEffect, useState } from 'react';

const FUSION_CHANNELS: ReadonlyArray<{ id: string; label: string; icon: string }> = [
  { id: 'keyboard', label: 'Keyboard', icon: '⌨' },
  { id: 'mouse', label: 'Mouse', icon: '🖱' },
  { id: 'gaze', label: 'Gaze', icon: '👁' },
  { id: 'voice', label: 'Voice', icon: '🎙' },
  { id: 'touch', label: 'Touch', icon: '👆' },
  { id: 'pointer', label: 'Pointer', icon: '⟐' },
  { id: 'screen', label: 'Screen', icon: '▢' },
  { id: 'env-light', label: 'Light', icon: '☀' },
  { id: 'env-noise', label: 'Noise', icon: '🔊' },
  { id: 'env-network', label: 'Network', icon: '🌐' },
];

const COMPENSATION_RULE_EXPLANATIONS: Record<string, string> = {
  'noise-degrades-voice': 'Ambient noise is high → voice weight reduced, keyboard/touch boosted.',
  'low-light-degrades-gaze': 'Lighting is too low → gaze tracking suppressed, mouse boosted.',
  'poor-network-degrades-voice': 'Network is degraded → cloud STT weight reduced, keyboard boosted.',
  'typing-flurry-suppresses-gaze': 'Active typing detected → gaze-driven adaptations deferred.',
  'reading-elevates-gaze': 'Stable gaze + idle mouse → gaze reliability elevated.',
};

interface ChannelQuality {
  channel: string;
  confidence: number;
  noise: number;
  sampleRate: number;
  lastSampledAt: number;
}

interface FusionStats {
  totalIngested: number;
  eventsPerSec: number;
  activeChannels: number;
  dominantChannel: string | null;
  degradedChannels: string[];
  lastIntent: { intent: string; confidence: number; suggestedAdaptations: string[] } | null;
  lastEmittedAt: number;
}

interface StatsResponse {
  running: boolean;
  stats?: FusionStats;
  weights?: Record<string, number>;
  activeRules?: string[];
  environmentConditions?: {
    lighting: string;
    noise: string;
    network: string;
    timeOfDay: string;
  } | null;
  channelQualities?: Record<string, ChannelQuality> | null;
}

interface IntentHistoryRecord {
  intent: string;
  confidence: number;
  suggestedAdaptations: string[];
  supportingEventCount: number;
  timestamp: number;
}

function QualityBar({ confidence, degraded }: { confidence: number; degraded: boolean }) {
  const width = Math.max(0, Math.min(1, confidence)) * 100;
  const stateClass = confidence === 0 ? 'off' : degraded ? 'degraded' : '';
  return (
    <div className="a11y-fusion-channel-bar">
      <div
        className={`a11y-fusion-channel-bar-fill ${stateClass}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

export default function IntelligencePanel() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [history, setHistory] = useState<IntentHistoryRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    const pollStats = () => {
      chrome.runtime
        .sendMessage({ type: 'FUSION_GET_STATS' })
        .then((r: unknown) => {
          if (!cancelled) setStats(r as StatsResponse);
        })
        .catch(() => {});
    };
    const pollHistory = () => {
      chrome.runtime
        .sendMessage({ type: 'FUSION_GET_HISTORY' })
        .then((r: unknown) => {
          if (!cancelled) {
            const response = r as { history?: IntentHistoryRecord[] } | undefined;
            setHistory(response?.history ?? []);
          }
        })
        .catch(() => {});
    };
    pollStats();
    pollHistory();
    const statsId = setInterval(pollStats, 1500);
    const historyId = setInterval(pollHistory, 3000);

    const onBroadcast = (msg: { type?: string; payload?: IntentHistoryRecord }) => {
      if (msg?.type === 'FUSION_INTENT_EMITTED' && msg.payload) {
        setHistory((prev) => [msg.payload as IntentHistoryRecord, ...prev].slice(0, 50));
      }
    };
    chrome.runtime.onMessage.addListener(onBroadcast);

    return () => {
      cancelled = true;
      clearInterval(statsId);
      clearInterval(historyId);
      chrome.runtime.onMessage.removeListener(onBroadcast);
    };
  }, []);

  const running = stats?.running === true;
  const qualities = stats?.channelQualities ?? {};
  const degraded = new Set(stats?.stats?.degradedChannels ?? []);
  const env = stats?.environmentConditions ?? null;

  return (
    <div className="space-y-3" style={{ fontSize: 12 }}>
      <div
        style={{
          padding: '10px 12px',
          borderRadius: 12,
          background: '#1a1a2e',
          border: '1px solid rgba(123, 104, 238, 0.2)',
          borderLeft: '4px solid #7b68ee',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 1.2,
            textTransform: 'uppercase',
            color: '#bb86fc',
            marginBottom: 6,
          }}
        >
          Multi-Modal Fusion · Layer 5
        </div>
        {!running && (
          <div style={{ color: '#94a3b8' }}>
            Fusion is not running on this tab. Enable it in the popup Settings
            tab, then reload the page.
          </div>
        )}
        {running && stats?.stats && (
          <div style={{ color: '#e2e8f0', lineHeight: 1.55 }}>
            <span style={{ color: '#bb86fc', fontWeight: 600 }}>
              {stats.stats.activeChannels}
            </span>{' '}
            active channels · dominant{' '}
            <span style={{ color: '#bb86fc', fontWeight: 600 }}>
              {stats.stats.dominantChannel ?? '—'}
            </span>{' '}
            · {stats.stats.eventsPerSec} events/s
          </div>
        )}
      </div>

      {/* Channel status grid */}
      {running && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 12,
            background: '#1a1a2e',
            border: '1px solid rgba(123, 104, 238, 0.2)',
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: '#94a3b8',
              textTransform: 'uppercase',
              letterSpacing: 1,
              marginBottom: 8,
            }}
          >
            Channel Quality
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {FUSION_CHANNELS.map((ch) => {
              const q = qualities[ch.id] ?? null;
              const conf = q?.confidence ?? 0;
              return (
                <div
                  key={ch.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <span style={{ width: 16, textAlign: 'center' }}>{ch.icon}</span>
                  <QualityBar confidence={conf} degraded={degraded.has(ch.id)} />
                  <span style={{ color: '#94a3b8', fontSize: 10, minWidth: 52 }}>
                    {ch.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Environment + compensation */}
      {running && env && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 12,
            background: '#1a1a2e',
            border: '1px solid rgba(123, 104, 238, 0.2)',
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: '#94a3b8',
              textTransform: 'uppercase',
              letterSpacing: 1,
              marginBottom: 8,
            }}
          >
            Environment
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            <div>
              <span style={{ color: '#94a3b8' }}>Lighting: </span>
              <span style={{ color: '#e2e8f0' }}>{env.lighting}</span>
            </div>
            <div>
              <span style={{ color: '#94a3b8' }}>Noise: </span>
              <span style={{ color: '#e2e8f0' }}>{env.noise}</span>
            </div>
            <div>
              <span style={{ color: '#94a3b8' }}>Network: </span>
              <span style={{ color: '#e2e8f0' }}>{env.network}</span>
            </div>
            <div>
              <span style={{ color: '#94a3b8' }}>Time: </span>
              <span style={{ color: '#e2e8f0' }}>{env.timeOfDay}</span>
            </div>
          </div>
          {stats?.activeRules && stats.activeRules.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div
                style={{
                  fontSize: 11,
                  color: '#94a3b8',
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                  marginBottom: 6,
                }}
              >
                Active Compensation
              </div>
              {stats.activeRules.map((id) => (
                <div key={id} style={{ color: '#e2e8f0', marginBottom: 4 }}>
                  <span style={{ color: '#bb86fc' }}>• </span>
                  {COMPENSATION_RULE_EXPLANATIONS[id] ?? id}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Intent timeline */}
      <div
        style={{
          padding: '10px 12px',
          borderRadius: 12,
          background: '#1a1a2e',
          border: '1px solid rgba(123, 104, 238, 0.2)',
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: '#94a3b8',
            textTransform: 'uppercase',
            letterSpacing: 1,
            marginBottom: 8,
          }}
        >
          Intent Timeline
        </div>
        {history.length === 0 ? (
          <div style={{ color: '#94a3b8' }}>
            No high-confidence intents detected yet.
          </div>
        ) : (
          history.slice(0, 15).map((record) => (
            <div
              key={`${record.timestamp}-${record.intent}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '4px 0',
                borderBottom: '1px solid rgba(123, 104, 238, 0.08)',
                fontSize: 11,
              }}
            >
              <span style={{ color: '#e2e8f0', fontWeight: 600 }}>
                {record.intent}
              </span>
              <span style={{ color: '#bb86fc', fontFamily: 'monospace' }}>
                {(record.confidence * 100).toFixed(0)}%
              </span>
              <span style={{ color: '#94a3b8', fontSize: 10 }}>
                {formatAgo(record.timestamp)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 1000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}
