import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AccessibilityProfile, Adaptation } from '@accessbridge/core/types';
import { DEFAULT_PROFILE, AdaptationType } from '@accessbridge/core/types';
import '../content/styles.css';
import './audit/audit.css';
import { AuditPanel } from './audit/AuditPanel.js';
// --- Priority 1: Captions + Actions ---
import ActionsPanel from './actions/ActionsPanel.js';
// --- Session 10: Vision Recovery ---
import VisionPanel from './vision/VisionPanel.js';
// --- Session 11: Multi-Modal Fusion ---
import IntelligencePanel from './intelligence/IntelligencePanel.js';

type SidePanelTab = 'dashboard' | 'audit' | 'actions' | 'vision' | 'intelligence' | 'compliance';

// ─── Types ───────────────────────────────────────────────────────────────────

interface StruggleScoreMsg {
  score: number;
  signals?: unknown[];
}

interface AdaptationHistoryEntry {
  id: string;
  type: AdaptationType | string;
  label: string;
  status: 'applied' | 'reverted';
  timestamp: number;
}

interface AccessibilityCheckResult {
  score: number;
  checks: {
    headings: boolean;
    altText: boolean;
    contrast: boolean;
    formLabels: boolean;
    landmarks: boolean;
  };
}

interface AiInsights {
  pageComplexity: number;
  recommendedAdaptations: Array<{ feature: string; label: string; reason: string }>;
  usageSummary: string;
}

interface QuickFeature {
  id: string;
  label: string;
  icon: string;
  profileKey: keyof AccessibilityProfile['cognitive'] | keyof AccessibilityProfile['motor'];
  profileGroup: 'cognitive' | 'motor';
  featureName: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const VERSION = chrome.runtime.getManifest().version;

const QUICK_FEATURES: QuickFeature[] = [
  {
    id: 'focus-mode',
    label: 'Focus Mode',
    icon: '🎯',
    profileKey: 'focusModeEnabled',
    profileGroup: 'cognitive',
    featureName: 'focus-mode',
  },
  {
    id: 'voice-nav',
    label: 'Voice Nav',
    icon: '🎙️',
    profileKey: 'voiceNavigationEnabled',
    profileGroup: 'motor',
    featureName: 'voice-nav',
  },
  {
    id: 'eye-tracking',
    label: 'Eye Track',
    icon: '👁️',
    profileKey: 'eyeTrackingEnabled',
    profileGroup: 'motor',
    featureName: 'eye-tracking',
  },
  {
    id: 'dwell-click',
    label: 'Dwell Click',
    icon: '🖱️',
    profileKey: 'dwellClickEnabled',
    profileGroup: 'motor',
    featureName: 'dwell-click',
  },
  {
    id: 'reading-mode',
    label: 'Reading',
    icon: '📖',
    profileKey: 'readingModeEnabled',
    profileGroup: 'cognitive',
    featureName: 'reading-mode',
  },
  {
    id: 'distraction-shield',
    label: 'Shield',
    icon: '🛡️',
    profileKey: 'distractionShield',
    profileGroup: 'cognitive',
    featureName: 'distraction-shield',
  },
];

const ADAPTATION_LABELS: Record<string, string> = {
  [AdaptationType.FONT_SCALE]: 'Font Scale',
  [AdaptationType.CONTRAST]: 'Contrast',
  [AdaptationType.COLOR_CORRECTION]: 'Color Correction',
  [AdaptationType.LINE_HEIGHT]: 'Line Height',
  [AdaptationType.LETTER_SPACING]: 'Letter Spacing',
  [AdaptationType.LAYOUT_SIMPLIFY]: 'Layout Simplify',
  [AdaptationType.TEXT_SIMPLIFY]: 'Text Simplify',
  [AdaptationType.FOCUS_MODE]: 'Focus Mode',
  [AdaptationType.READING_MODE]: 'Reading Mode',
  [AdaptationType.CLICK_TARGET_ENLARGE]: 'Click Targets',
  [AdaptationType.VOICE_NAV]: 'Voice Navigation',
  [AdaptationType.EYE_TRACKING]: 'Eye Tracking',
  [AdaptationType.CURSOR_SIZE]: 'Cursor Size',
  [AdaptationType.REDUCED_MOTION]: 'Reduced Motion',
  [AdaptationType.AUTO_SUMMARIZE]: 'Auto Summarize',
  [AdaptationType.LANGUAGE_SWITCH]: 'Language Switch',
};

const ADAPTATION_ICONS: Record<string, string> = {
  [AdaptationType.FONT_SCALE]: 'Aa',
  [AdaptationType.CONTRAST]: '◑',
  [AdaptationType.COLOR_CORRECTION]: '🎨',
  [AdaptationType.LINE_HEIGHT]: '↕',
  [AdaptationType.LETTER_SPACING]: '↔',
  [AdaptationType.LAYOUT_SIMPLIFY]: '▦',
  [AdaptationType.TEXT_SIMPLIFY]: '≡',
  [AdaptationType.FOCUS_MODE]: '⊙',
  [AdaptationType.READING_MODE]: '📖',
  [AdaptationType.CLICK_TARGET_ENLARGE]: '⊕',
  [AdaptationType.VOICE_NAV]: '🎙',
  [AdaptationType.EYE_TRACKING]: '👁',
  [AdaptationType.CURSOR_SIZE]: '↖',
  [AdaptationType.REDUCED_MOTION]: '⏸',
  [AdaptationType.AUTO_SUMMARIZE]: '∑',
  [AdaptationType.LANGUAGE_SWITCH]: '🌐',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function scoreColor(score: number): string {
  if (score < 30) return '#10b981';   // green-400
  if (score < 60) return '#f59e0b';   // yellow-400
  return '#ef4444';                   // red-400
}

function scoreLabel(score: number): string {
  if (score < 30) return 'Low';
  if (score < 60) return 'Medium';
  return 'High';
}

function a11yScoreColor(score: number): string {
  if (score >= 80) return 'text-green-400';
  if (score >= 50) return 'text-yellow-400';
  return 'text-red-400';
}

function complexityLabel(score: number): string {
  if (score < 30) return 'Simple';
  if (score < 60) return 'Moderate';
  if (score < 80) return 'Complex';
  return 'Very Complex';
}

function complexityColor(score: number): string {
  if (score < 30) return 'text-green-400';
  if (score < 60) return 'text-yellow-400';
  return 'text-red-400';
}

// Gauge SVG for struggle score
function StruggleGauge({ score }: { score: number }) {
  const radius = 52;
  const cx = 64;
  const cy = 64;
  // Arc spans 220 degrees (from 200° to 340° going clockwise through 0° back to ~160°)
  const startAngle = -220;
  const endAngle = 40;
  const totalArc = 260;
  const fillArc = (score / 100) * totalArc;

  function polarToXY(angleDeg: number, r: number) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function describeArc(start: number, end: number, r: number) {
    const s = polarToXY(start, r);
    const e = polarToXY(end, r);
    const largeArc = end - start > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 1 ${e.x} ${e.y}`;
  }

  const fillColor = scoreColor(score);

  return (
    <svg viewBox="0 0 128 80" className="w-36 h-24 mx-auto" aria-label={`Struggle score: ${score} out of 100`}>
      {/* Track arc */}
      <path
        d={describeArc(startAngle, endAngle, radius)}
        fill="none"
        stroke="rgba(255,255,255,0.1)"
        strokeWidth="8"
        strokeLinecap="round"
      />
      {/* Fill arc */}
      {score > 0 && (
        <path
          d={describeArc(startAngle, startAngle + fillArc, radius)}
          fill="none"
          stroke={fillColor}
          strokeWidth="8"
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 6px ${fillColor})` }}
        />
      )}
      {/* Score text */}
      <text
        x={cx}
        y={cy - 4}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={fillColor}
        fontSize="22"
        fontWeight="bold"
        style={{ fontFamily: 'system-ui, sans-serif' }}
      >
        {score}
      </text>
      <text
        x={cx}
        y={cy + 14}
        textAnchor="middle"
        fill="rgba(255,255,255,0.4)"
        fontSize="8"
        style={{ fontFamily: 'system-ui, sans-serif' }}
      >
        / 100
      </text>
    </svg>
  );
}

// Small circular progress for accessibility score
function CircleScore({ score, size = 48 }: { score: number; size?: number }) {
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const fill = (score / 100) * circ;
  const color = score >= 80 ? '#10b981' : score >= 50 ? '#f59e0b' : '#ef4444';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="4" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${fill} ${circ}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ filter: `drop-shadow(0 0 4px ${color})` }}
      />
    </svg>
  );
}

// Section wrapper
function Section({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`bg-a11y-surface rounded-xl p-4 ${className}`} aria-label={title}>
      <h2 className="text-xs font-semibold uppercase tracking-widest text-a11y-muted mb-3">{title}</h2>
      {children}
    </section>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

function SidePanel() {
  // Core state
  const [profile, setProfile] = useState<AccessibilityProfile>({ ...DEFAULT_PROFILE });
  const [struggleScore, setStruggleScore] = useState(0);
  const [activeAdaptations, setActiveAdaptations] = useState<Adaptation[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [currentApp, setCurrentApp] = useState('—');
  const [tab, setTab] = useState<SidePanelTab>('dashboard');

  // Session timer
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const sessionStart = useRef(Date.now());

  // Adaptation history (local ring-buffer, max 40)
  const [history, setHistory] = useState<AdaptationHistoryEntry[]>([]);

  // Accessibility score for current page
  const [a11yScore, setA11yScore] = useState<AccessibilityCheckResult | null>(null);

  // AI insights
  const [insights, setInsights] = useState<AiInsights>({
    pageComplexity: 0,
    recommendedAdaptations: [],
    usageSummary: 'Loading usage patterns…',
  });
  const [insightsLoading, setInsightsLoading] = useState(false);

  // Prev active adaptations ref for diffing
  const prevAdaptationIds = useRef<Set<string>>(new Set());

  // ── Session timer ──────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = setInterval(() => {
      setSessionSeconds(Math.floor((Date.now() - sessionStart.current) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  // ── Detect current tab URL → app name ─────────────────────────────────────
  useEffect(() => {
    const detect = () => {
      if (typeof chrome !== 'undefined' && chrome.tabs) {
        chrome.tabs
          .query({ active: true, currentWindow: true })
          .then(([tab]) => {
            if (tab?.url) {
              try {
                const host = new URL(tab.url).hostname.replace(/^www\./, '');
                setCurrentApp(host || '—');
              } catch {
                setCurrentApp('—');
              }
            }
          })
          .catch(() => {});
      }
    };
    detect();
    const iv = setInterval(detect, 5000);
    return () => clearInterval(iv);
  }, []);

  // ── Poll background script ─────────────────────────────────────────────────
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime) return;

    // Initial profile load
    chrome.runtime
      .sendMessage({ type: 'GET_PROFILE' })
      .then((p) => { if (p) setProfile(p as AccessibilityProfile); })
      .catch(() => {});

    const poll = () => {
      chrome.runtime
        .sendMessage({ type: 'GET_STRUGGLE_SCORE' })
        .then((s) => {
          if (s && typeof s === 'object' && 'score' in s) {
            setStruggleScore((s as StruggleScoreMsg).score);
          }
        })
        .catch(() => {});

      chrome.runtime
        .sendMessage({ type: 'GET_ACTIVE_ADAPTATIONS' })
        .then((a) => {
          if (Array.isArray(a)) {
            const adaptations = a as Adaptation[];
            setActiveAdaptations(adaptations);

            // Diff for history
            const newIds = new Set(adaptations.map((x) => x.id));
            const prev = prevAdaptationIds.current;

            // Newly applied
            adaptations.forEach((ad) => {
              if (!prev.has(ad.id)) {
                addHistory({
                  id: ad.id,
                  type: ad.type,
                  label: ADAPTATION_LABELS[ad.type] ?? ad.type,
                  status: 'applied',
                  timestamp: ad.timestamp ?? Date.now(),
                });
              }
            });

            // Reverted
            prev.forEach((id) => {
              if (!newIds.has(id)) {
                addHistory({
                  id: `rev-${id}-${Date.now()}`,
                  type: 'reverted',
                  label: 'Adaptation reverted',
                  status: 'reverted',
                  timestamp: Date.now(),
                });
              }
            });

            prevAdaptationIds.current = newIds;
          }
        })
        .catch(() => {});
    };

    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, []);

  // ── Compute page accessibility score ──────────────────────────────────────
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.scripting) return;

    const compute = () => {
      chrome.tabs
        .query({ active: true, currentWindow: true })
        .then(([tab]) => {
          if (!tab?.id || tab.url?.startsWith('chrome://')) return;
          chrome.scripting
            .executeScript({
              target: { tabId: tab.id },
              func: () => {
                const headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6').length > 0;
                const imgs = document.querySelectorAll('img');
                const imgsMissingAlt = Array.from(imgs).filter(
                  (i) => !i.getAttribute('alt') && !i.getAttribute('aria-label'),
                ).length;
                const altText = imgs.length === 0 || imgsMissingAlt / imgs.length < 0.3;
                const inputs = document.querySelectorAll('input,select,textarea');
                const labeledInputs = Array.from(inputs).filter((el) => {
                  const id = el.getAttribute('id');
                  return (
                    (id && document.querySelector(`label[for="${id}"]`)) ||
                    el.getAttribute('aria-label') ||
                    el.getAttribute('aria-labelledby') ||
                    el.closest('label')
                  );
                }).length;
                const formLabels = inputs.length === 0 || labeledInputs / inputs.length > 0.7;
                const landmarks =
                  document.querySelector('main,[role="main"]') !== null ||
                  document.querySelector('nav,[role="navigation"]') !== null;
                // Simplified contrast check: look for very light text on light bg via computed style sampling
                const bodyCss = window.getComputedStyle(document.body);
                const bgLum = bodyCss.backgroundColor;
                const contrast = !bgLum.includes('255, 255, 255') || bodyCss.color !== 'rgb(255, 255, 255)';

                const checks = { headings, altText, contrast, formLabels, landmarks };
                const passed = Object.values(checks).filter(Boolean).length;
                const score = Math.round((passed / Object.keys(checks).length) * 100);
                return { score, checks };
              },
            })
            .then((results) => {
              const result = results?.[0]?.result as AccessibilityCheckResult | undefined;
              if (result) setA11yScore(result);
            })
            .catch(() => {});
        })
        .catch(() => {});
    };

    compute();
    const iv = setInterval(compute, 10000);
    return () => clearInterval(iv);
  }, []);

  // ── Compute AI insights ────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.scripting) return;

    setInsightsLoading(true);

    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (!tab?.id || tab.url?.startsWith('chrome://')) {
          setInsightsLoading(false);
          return;
        }
        chrome.scripting
          .executeScript({
            target: { tabId: tab.id },
            func: () => {
              const allEls = document.body?.querySelectorAll('*').length ?? 0;
              const interactive = document.querySelectorAll(
                'a,button,input,select,textarea,[tabindex],[role="button"]',
              ).length;
              const nested = document.querySelectorAll('table table, div > div > div > div > div').length;
              const iframes = document.querySelectorAll('iframe').length;
              const animations = document.querySelectorAll('[class*="animate"],[style*="animation"]').length;
              // Complexity: weighted mix of element count, nesting, interactive density, animations
              const raw =
                Math.min(allEls / 200, 1) * 30 +
                Math.min(nested / 20, 1) * 25 +
                Math.min(animations / 10, 1) * 20 +
                Math.min(iframes / 3, 1) * 15 +
                Math.min(interactive / 100, 1) * 10;
              return Math.round(Math.min(raw, 100));
            },
          })
          .then((results) => {
            const complexity = (results?.[0]?.result as number) ?? 0;

            // Build recommended adaptations based on complexity + current profile
            const recs: AiInsights['recommendedAdaptations'] = [];
            if (complexity > 60) {
              recs.push({
                feature: 'distraction-shield',
                label: 'Distraction Shield',
                reason: 'High page complexity detected',
              });
              recs.push({
                feature: 'focus-mode',
                label: 'Focus Mode',
                reason: 'Reduce visual noise',
              });
            }
            if (complexity > 40) {
              recs.push({
                feature: 'reading-mode',
                label: 'Reading Mode',
                reason: 'Improve text readability',
              });
            }
            if (complexity < 30) {
              recs.push({
                feature: 'voice-nav',
                label: 'Voice Navigation',
                reason: 'Simple page — ideal for voice control',
              });
            }

            const sessionMin = Math.floor((Date.now() - sessionStart.current) / 60000);
            const usageSummary =
              sessionMin < 1
                ? 'Session just started. Monitoring your browsing patterns…'
                : `Active for ${sessionMin} min. ${
                    activeAdaptations.length
                  } adaptation(s) currently helping you.`;

            setInsights({ pageComplexity: complexity, recommendedAdaptations: recs, usageSummary });
            setInsightsLoading(false);
          })
          .catch(() => setInsightsLoading(false));
      })
      .catch(() => setInsightsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentApp]);

  // ── History helper ─────────────────────────────────────────────────────────
  const addHistory = useCallback((entry: AdaptationHistoryEntry) => {
    setHistory((prev) => [entry, ...prev].slice(0, 40));
  }, []);

  // ── Master toggle ──────────────────────────────────────────────────────────
  const handleMasterToggle = useCallback(() => {
    if (enabled) {
      chrome.runtime?.sendMessage({ type: 'REVERT_ALL' }).catch(() => {});
    }
    setEnabled((v) => !v);
  }, [enabled]);

  // ── Quick feature toggle ───────────────────────────────────────────────────
  const handleQuickToggle = useCallback(
    (feature: QuickFeature) => {
      const group = profile[feature.profileGroup] as unknown as Record<string, unknown>;
      const current = Boolean(group[feature.profileKey]);
      const next = !current;

      const updatedProfile: AccessibilityProfile = {
        ...profile,
        [feature.profileGroup]: {
          ...profile[feature.profileGroup],
          [feature.profileKey]: next,
        },
        updatedAt: Date.now(),
      };
      setProfile(updatedProfile);
      chrome.runtime
        ?.sendMessage({ type: 'SAVE_PROFILE', payload: updatedProfile })
        .catch(() => {});
      chrome.runtime
        ?.sendMessage({ type: 'TOGGLE_FEATURE', payload: { feature: feature.featureName, enabled: next } })
        .catch(() => {});

      addHistory({
        id: `manual-${feature.id}-${Date.now()}`,
        type: feature.featureName,
        label: feature.label,
        status: next ? 'applied' : 'reverted',
        timestamp: Date.now(),
      });
    },
    [profile, addHistory],
  );

  // ── Apply recommended adaptation ──────────────────────────────────────────
  const applyRecommended = useCallback((featureName: string, label: string) => {
    chrome.runtime
      ?.sendMessage({ type: 'TOGGLE_FEATURE', payload: { feature: featureName, enabled: true } })
      .catch(() => {});
    addHistory({
      id: `rec-${featureName}-${Date.now()}`,
      type: featureName,
      label,
      status: 'applied',
      timestamp: Date.now(),
    });
    // Optimistically update profile for known features
    const featureToProfileKey: Record<string, { group: 'cognitive' | 'motor'; key: string }> = {
      'focus-mode': { group: 'cognitive', key: 'focusModeEnabled' },
      'reading-mode': { group: 'cognitive', key: 'readingModeEnabled' },
      'distraction-shield': { group: 'cognitive', key: 'distractionShield' },
      'voice-nav': { group: 'motor', key: 'voiceNavigationEnabled' },
      'eye-tracking': { group: 'motor', key: 'eyeTrackingEnabled' },
      'dwell-click': { group: 'motor', key: 'dwellClickEnabled' },
    };
    const mapping = featureToProfileKey[featureName];
    if (mapping) {
      setProfile((prev) => ({
        ...prev,
        [mapping.group]: { ...prev[mapping.group], [mapping.key]: true },
        updatedAt: Date.now(),
      }));
    }
  }, [addHistory]);

  // ── Refresh insights ───────────────────────────────────────────────────────
  const refreshInsights = useCallback(() => {
    setCurrentApp((prev) => prev + ' '); // trigger re-run of insight effect
    setTimeout(() => setCurrentApp((prev) => prev.trim()), 50);
  }, []);

  return (
    <div className="bg-a11y-bg text-a11y-text min-h-screen flex flex-col text-sm" role="main">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 bg-a11y-surface border-b border-a11y-primary/30 shadow-md">
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-6 h-6 rounded bg-a11y-accent flex items-center justify-center text-white font-bold text-xs"
            aria-hidden="true"
          >
            A
          </span>
          <span className="text-a11y-accent font-bold text-base tracking-tight">AccessBridge</span>
          <span className="text-a11y-muted text-xs bg-a11y-bg px-1.5 py-0.5 rounded">v{VERSION}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-a11y-muted">{enabled ? 'ON' : 'OFF'}</span>
          <MasterToggle enabled={enabled} onChange={handleMasterToggle} />
        </div>
      </header>

      {/* ── Tab bar ────────────────────────────────────────────────────────── */}
      <nav
        className="flex border-b border-a11y-primary/20 bg-a11y-surface px-3"
        role="tablist"
        aria-label="Side panel sections"
      >
        <TabButton label="Dashboard" active={tab === 'dashboard'} onClick={() => setTab('dashboard')} />
        <TabButton label="Audit" active={tab === 'audit'} onClick={() => setTab('audit')} />
        {/* --- Priority 1: Captions + Actions --- */}
        <TabButton label="Actions" active={tab === 'actions'} onClick={() => setTab('actions')} />
        {/* --- Session 10: Vision Recovery --- */}
        <TabButton label="Vision" active={tab === 'vision'} onClick={() => setTab('vision')} />
        {/* --- Session 11: Multi-Modal Fusion --- */}
        <TabButton label="Intelligence" active={tab === 'intelligence'} onClick={() => setTab('intelligence')} />
        {/* --- Session 16: ZK Attestation --- */}
        <TabButton label="Compliance" active={tab === 'compliance'} onClick={() => setTab('compliance')} />
      </nav>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {/* --- Priority 1: Captions + Actions --- */}
        {tab === 'compliance' ? (
          <CompliancePanel />
        ) : tab === 'intelligence' ? (
          <IntelligencePanel />
        ) : tab === 'vision' ? (
          <VisionPanel />
        ) : tab === 'actions' ? (
          <ActionsPanel />
        ) : tab === 'audit' ? (
          <AuditPanel />
        ) : (
        <>
        {/* Disabled banner */}
        {!enabled && (
          <div
            className="flex items-center gap-2 bg-red-900/40 border border-red-500/50 rounded-lg px-3 py-2 text-red-300 text-xs"
            role="alert"
          >
            <span>⚠️</span>
            <span>AccessBridge is disabled. All adaptations have been reverted.</span>
          </div>
        )}

        {/* ── 1. Real-time Dashboard ───────────────────────────────────────── */}
        <Section title="Real-Time Dashboard">
          {/* Gauge row */}
          <div className="flex items-center gap-3">
            <div className="flex-shrink-0">
              <div className="text-xs text-a11y-muted text-center mb-1">Struggle Score</div>
              <StruggleGauge score={struggleScore} />
              <div
                className="text-center text-xs mt-1 font-semibold"
                style={{ color: scoreColor(struggleScore) }}
              >
                {scoreLabel(struggleScore)}
              </div>
            </div>

            <div className="flex-1 grid grid-cols-1 gap-2">
              <StatCard
                value={String(activeAdaptations.length)}
                label="Active Adaptations"
                accent="text-a11y-accent"
              />
              <StatCard
                value={formatDuration(sessionSeconds)}
                label="Session Duration"
                accent="text-blue-400"
              />
              <StatCard
                value={currentApp}
                label="Current App"
                accent="text-purple-400"
                mono
              />
            </div>
          </div>
        </Section>

        {/* ── 2. Quick Controls ────────────────────────────────────────────── */}
        <Section title="Quick Controls">
          <div className="grid grid-cols-3 gap-2">
            {QUICK_FEATURES.map((f) => {
              const group = profile[f.profileGroup] as unknown as Record<string, unknown>;
              const active = Boolean(group[f.profileKey]);
              return (
                <QuickControlButton
                  key={f.id}
                  feature={f}
                  active={active}
                  disabled={!enabled}
                  onClick={() => handleQuickToggle(f)}
                />
              );
            })}
          </div>
        </Section>

        {/* ── 3. Accessibility Score ───────────────────────────────────────── */}
        <Section title="Page Accessibility">
          {a11yScore ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="relative flex items-center justify-center w-14 h-14 flex-shrink-0">
                  <CircleScore score={a11yScore.score} size={56} />
                  <span
                    className={`absolute text-base font-bold ${a11yScoreColor(a11yScore.score)}`}
                  >
                    {a11yScore.score}
                  </span>
                </div>
                <div>
                  <div className={`text-lg font-bold ${a11yScoreColor(a11yScore.score)}`}>
                    {a11yScore.score >= 80 ? 'Good' : a11yScore.score >= 50 ? 'Fair' : 'Poor'}
                  </div>
                  <div className="text-xs text-a11y-muted">Accessibility Score</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {(
                  Object.entries(a11yScore.checks) as Array<[string, boolean]>
                ).map(([check, passed]) => (
                  <CheckRow key={check} label={CHECK_LABELS[check] ?? check} passed={passed} />
                ))}
              </div>
            </div>
          ) : (
            <div className="text-a11y-muted text-xs text-center py-3">
              <span className="inline-block animate-spin mr-1">⟳</span> Analysing page…
            </div>
          )}
        </Section>

        {/* ── 4. AI Insights ──────────────────────────────────────────────── */}
        <Section title="AI Insights">
          <div className="space-y-3">
            {/* Page complexity */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-a11y-muted">Page Complexity</span>
                <span className={`text-xs font-semibold ${complexityColor(insights.pageComplexity)}`}>
                  {complexityLabel(insights.pageComplexity)}
                </span>
              </div>
              <ProgressBar value={insights.pageComplexity} color={scoreColor(insights.pageComplexity)} />
            </div>

            {/* Recommended adaptations */}
            <div>
              <div className="text-xs text-a11y-muted mb-2">Recommended Adaptations</div>
              {insightsLoading ? (
                <div className="text-a11y-muted text-xs text-center py-2">
                  <span className="inline-block animate-spin mr-1">⟳</span> Computing…
                </div>
              ) : insights.recommendedAdaptations.length === 0 ? (
                <div className="text-a11y-muted text-xs text-center py-2 bg-a11y-bg rounded-lg">
                  No recommendations for this page.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {insights.recommendedAdaptations.map((rec) => (
                    <RecommendationRow
                      key={rec.feature}
                      rec={rec}
                      onApply={() => applyRecommended(rec.feature, rec.label)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Usage summary */}
            <div className="bg-a11y-bg rounded-lg px-3 py-2">
              <div className="text-xs text-a11y-muted mb-1">Usage Summary</div>
              <p className="text-xs text-a11y-text leading-relaxed">{insights.usageSummary}</p>
            </div>

            <button
              onClick={refreshInsights}
              className="w-full text-xs py-1.5 rounded border border-a11y-primary/30 text-a11y-muted hover:text-a11y-text hover:border-a11y-accent/50 transition-colors"
            >
              Refresh Insights
            </button>
          </div>
        </Section>

        {/* ── 4b. On-Device Models (Session 12) ──────────────────────────── */}
        <Section title="On-Device Models">
          <OnnxModelPanel />
        </Section>

        {/* ── 5. Adaptation History ────────────────────────────────────────── */}
        <Section title="Adaptation History">
          {history.length === 0 ? (
            <div className="text-a11y-muted text-xs text-center py-4">
              No adaptations recorded yet this session.
            </div>
          ) : (
            <div className="space-y-1 max-h-52 overflow-y-auto pr-1" role="log" aria-live="polite">
              {history.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </Section>
        </>
        )}
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer className="px-4 py-2 border-t border-a11y-primary/20 flex items-center justify-between text-a11y-muted text-xs">
        <span>AccessBridge v{VERSION}</span>
        <span>{new Date().toLocaleDateString()}</span>
      </footer>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`
        px-3 py-2 text-xs font-semibold uppercase tracking-widest transition-colors
        border-b-2 -mb-px
        ${active
          ? 'text-a11y-accent border-a11y-accent'
          : 'text-a11y-muted border-transparent hover:text-a11y-text'}
      `}
    >
      {label}
    </button>
  );
}

function MasterToggle({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={enabled}
      aria-label={`AccessBridge ${enabled ? 'enabled' : 'disabled'}. Click to toggle.`}
      onClick={onChange}
      className={`
        relative inline-flex items-center rounded-full transition-colors w-10 h-5
        ${enabled ? 'bg-a11y-accent' : 'bg-a11y-primary/50'}
      `}
    >
      <span
        className={`
          inline-block rounded-full bg-white shadow w-4 h-4 transform transition-transform
          ${enabled ? 'translate-x-5' : 'translate-x-0.5'}
        `}
      />
    </button>
  );
}

function StatCard({
  value,
  label,
  accent,
  mono = false,
}: {
  value: string;
  label: string;
  accent: string;
  mono?: boolean;
}) {
  return (
    <div className="bg-a11y-bg rounded-lg px-3 py-2">
      <div
        className={`font-semibold truncate text-sm ${accent} ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </div>
      <div className="text-a11y-muted text-xs">{label}</div>
    </div>
  );
}

function QuickControlButton({
  feature,
  active,
  disabled,
  onClick,
}: {
  feature: QuickFeature;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={`${feature.label} — ${active ? 'on' : 'off'}`}
      className={`
        flex flex-col items-center justify-center gap-1 py-3 rounded-xl transition-all text-center
        focus:outline-none focus-visible:ring-2 focus-visible:ring-a11y-accent
        ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:scale-105'}
        ${
          active
            ? 'bg-a11y-accent/20 border border-a11y-accent/60 text-a11y-accent shadow-sm shadow-a11y-accent/20'
            : 'bg-a11y-bg border border-a11y-primary/20 text-a11y-muted hover:border-a11y-accent/40 hover:text-a11y-text'
        }
      `}
    >
      <span className="text-base leading-none" aria-hidden="true">{feature.icon}</span>
      <span className="text-xs leading-tight font-medium">{feature.label}</span>
    </button>
  );
}

const CHECK_LABELS: Record<string, string> = {
  headings: 'Heading Structure',
  altText: 'Image Alt Text',
  contrast: 'Color Contrast',
  formLabels: 'Form Labels',
  landmarks: 'Landmarks',
};

function CheckRow({ label, passed }: { label: string; passed: boolean }) {
  return (
    <div className="flex items-center gap-2 bg-a11y-bg rounded px-2 py-1.5">
      <span
        className={`text-xs flex-shrink-0 ${passed ? 'text-green-400' : 'text-red-400'}`}
        aria-hidden="true"
      >
        {passed ? '✓' : '✗'}
      </span>
      <span className={`text-xs truncate ${passed ? 'text-a11y-text' : 'text-a11y-muted'}`}>{label}</span>
    </div>
  );
}

function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-1.5 rounded-full bg-a11y-bg overflow-hidden" aria-hidden="true">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.min(value, 100)}%`, background: color }}
      />
    </div>
  );
}

function RecommendationRow({
  rec,
  onApply,
}: {
  rec: { feature: string; label: string; reason: string };
  onApply: () => void;
}) {
  return (
    <div className="flex items-center gap-2 bg-a11y-bg rounded-lg px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-a11y-text truncate">{rec.label}</div>
        <div className="text-xs text-a11y-muted truncate">{rec.reason}</div>
      </div>
      <button
        onClick={onApply}
        className="flex-shrink-0 text-xs px-2 py-1 rounded bg-a11y-accent/20 text-a11y-accent border border-a11y-accent/40 hover:bg-a11y-accent/30 transition-colors"
        aria-label={`Apply ${rec.label}`}
      >
        Apply
      </button>
    </div>
  );
}

function HistoryRow({ entry }: { entry: AdaptationHistoryEntry }) {
  const icon =
    entry.status === 'applied'
      ? (ADAPTATION_ICONS[entry.type] ?? '⚡')
      : '↩';

  return (
    <div className="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-a11y-bg transition-colors">
      <span
        className={`
          flex-shrink-0 w-6 h-6 rounded flex items-center justify-center text-xs
          ${entry.status === 'applied' ? 'bg-a11y-accent/20 text-a11y-accent' : 'bg-a11y-primary/20 text-a11y-muted'}
        `}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-a11y-text truncate">{entry.label}</div>
      </div>
      <div className="flex-shrink-0 flex flex-col items-end gap-0.5">
        <span
          className={`text-xs font-medium ${entry.status === 'applied' ? 'text-green-400' : 'text-a11y-muted'}`}
        >
          {entry.status === 'applied' ? 'Applied' : 'Reverted'}
        </span>
        <span className="text-a11y-muted text-xs">{formatTime(entry.timestamp)}</span>
      </div>
    </div>
  );
}

// ─── Session 12: On-Device Models panel ─────────────────────────────────────

interface BenchmarkResult {
  avgLatencyMs: number;
  classifierScores: number[];
  heuristicScores: number[];
}

interface OnnxStatusForSidepanel {
  tiers: Record<0 | 1 | 2, {
    state: 'idle' | 'loading' | 'loaded' | 'failed';
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
}

function OnnxModelPanel() {
  const [status, setStatus] = useState<OnnxStatusForSidepanel | null>(null);
  const [benchRunning, setBenchRunning] = useState(false);
  const [benchResult, setBenchResult] = useState<BenchmarkResult | null>(null);
  const [benchError, setBenchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      chrome.runtime
        .sendMessage({ type: 'ONNX_GET_STATUS' })
        .then((r: unknown) => {
          if (!cancelled) setStatus(r as OnnxStatusForSidepanel);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const toggleForceFallback = (enabled: boolean) =>
    chrome.runtime
      .sendMessage({ type: 'ONNX_SET_FORCE_FALLBACK', payload: { enabled } })
      .catch(() => {});

  const runBenchmark = () => {
    setBenchRunning(true);
    setBenchError(null);
    chrome.runtime
      .sendMessage({ type: 'ONNX_RUN_BENCHMARK', tier: 0 })
      .then((r: unknown) => {
        const res = r as { error?: string } & Partial<BenchmarkResult>;
        if (res.error) {
          setBenchError(res.error);
        } else {
          setBenchResult(res as BenchmarkResult);
        }
      })
      .catch((e: unknown) => setBenchError(String(e)))
      .finally(() => setBenchRunning(false));
  };

  if (!status) {
    return <div className="text-a11y-muted text-xs text-center py-2">Loading…</div>;
  }

  const fmtBytes = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  const stateDot = (state: string): string => {
    if (state === 'loaded') return '#10b981';
    if (state === 'loading') return '#f59e0b';
    if (state === 'failed') return '#ef4444';
    return '#94a3b8';
  };

  return (
    <div className="space-y-3">
      {/* Tier status rows */}
      <div className="space-y-2">
        {([0, 1, 2] as const).map((tier) => {
          const snap = status.tiers[tier];
          return (
            <div key={tier} className="flex items-center gap-2 text-xs">
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: stateDot(snap.state) }}
                aria-label={`Tier ${tier} ${snap.state}`}
              />
              <span className="flex-1 text-a11y-text">{snap.label}</span>
              <span className="text-a11y-muted font-mono">
                {snap.state === 'loading'
                  ? `${snap.progress}%`
                  : snap.state === 'loaded'
                    ? 'ready'
                    : snap.state}
              </span>
            </div>
          );
        })}
      </div>

      {/* Stats */}
      <div className="bg-a11y-bg rounded-lg px-3 py-2 space-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-a11y-muted">Cache</span>
          <span className="text-a11y-text font-mono">
            {fmtBytes(status.runtime.cacheBytes)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-a11y-muted">Fallbacks</span>
          <span className="text-a11y-text font-mono">
            {status.runtime.fallbackCount}
          </span>
        </div>
        {Object.entries(status.runtime.inferenceCount).map(([id, count]) => (
          <div key={id} className="flex justify-between">
            <span className="text-a11y-muted truncate">{id}</span>
            <span className="text-a11y-text font-mono">
              {count} · {status.runtime.avgLatencyMs[id] ?? 0}ms
            </span>
          </div>
        ))}
      </div>

      {/* Force fallback debug switch */}
      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={status.forceFallback}
          onChange={(e) => toggleForceFallback(e.target.checked)}
          className="accent-a11y-accent"
        />
        <span className="text-a11y-text">Force fallback (debug)</span>
      </label>
      <p className="text-a11y-muted" style={{ fontSize: '10px', lineHeight: 1.4 }}>
        Forces every on-device model to return null so the heuristic path runs.
        Useful for demoing the baseline behaviour.
      </p>

      {/* Benchmark */}
      <button
        onClick={runBenchmark}
        disabled={benchRunning || !status || status.tiers[0].state !== 'loaded'}
        style={{
          width: '100%',
          padding: '8px 16px',
          borderRadius: '10px',
          fontSize: '12px',
          fontWeight: 600,
          background: 'linear-gradient(135deg, var(--primary, #7b68ee), var(--accent, #bb86fc))',
          color: '#fff',
          border: 'none',
          cursor: benchRunning || !status || status.tiers[0].state !== 'loaded' ? 'not-allowed' : 'pointer',
          opacity: benchRunning || !status || status.tiers[0].state !== 'loaded' ? 0.5 : 1,
          boxShadow: '0 4px 12px rgba(123,104,238,0.35)',
          transition: 'opacity 0.2s',
        }}
        aria-busy={benchRunning}
      >
        {benchRunning ? '⟳ Running…' : 'Run Benchmark (10 inferences)'}
      </button>

      {benchError && (
        <p className="text-xs" style={{ color: '#ef4444' }}>
          Error: {benchError}
        </p>
      )}

      {benchResult && !benchError && (() => {
        const { avgLatencyMs, classifierScores, heuristicScores } = benchResult;
        const meanClassifier = classifierScores.reduce((a, b) => a + b, 0) / classifierScores.length;
        const meanHeuristic = heuristicScores.reduce((a, b) => a + b, 0) / heuristicScores.length;
        return (
          <div className="space-y-2">
            <div
              className="bg-a11y-bg rounded-lg px-3 py-2 text-xs font-mono"
              style={{ color: 'var(--muted, #94a3b8)' }}
            >
              avg latency: <span style={{ color: 'var(--accent, #bb86fc)' }}>{avgLatencyMs} ms</span>
              {'  |  '}mean classifier: <span style={{ color: '#10b981' }}>{meanClassifier.toFixed(1)}</span>
              {'  |  '}mean heuristic: <span style={{ color: '#f59e0b' }}>{meanHeuristic.toFixed(1)}</span>
            </div>
            <div className="bg-a11y-bg rounded-lg overflow-hidden">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', fontFamily: 'var(--font-mono, monospace)' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(123,104,238,0.2)' }}>
                    {['#', 'classifier', 'heuristic', 'diff'].map((h) => (
                      <th key={h} style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--muted, #94a3b8)', fontWeight: 600 }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {classifierScores.map((cs, i) => {
                    const hs = heuristicScores[i];
                    const diff = cs - hs;
                    return (
                      <tr key={i} style={{ borderBottom: '1px solid rgba(123,104,238,0.08)' }}>
                        <td style={{ padding: '3px 8px', textAlign: 'right', color: 'var(--muted, #94a3b8)' }}>{i + 1}</td>
                        <td style={{ padding: '3px 8px', textAlign: 'right', color: '#10b981' }}>{cs.toFixed(1)}</td>
                        <td style={{ padding: '3px 8px', textAlign: 'right', color: '#f59e0b' }}>{hs.toFixed(1)}</td>
                        <td style={{ padding: '3px 8px', textAlign: 'right', color: diff >= 0 ? '#10b981' : '#ef4444' }}>
                          {diff >= 0 ? '+' : ''}{diff.toFixed(1)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── Session 16: Compliance Observatory panel ────────────────────────────────

interface ComplianceRingCache {
  version: number;
  pubKeys: string[];
  ringHash: string;
  fetchedAt: number;
}

interface ComplianceAttestation {
  date: string;
  valid: boolean;
  reason?: string;
}

interface ComplianceLastKeyImage {
  date: string;
  hex: string;
}

interface AttestationLogRow {
  date: string;
  keyImagePrefix: string;
  valid: boolean;
  reason?: string;
}

function todayISOCompliance(): string {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

function CompliancePanel() {
  const [ringCache, setRingCache] = useState<ComplianceRingCache | null>(null);
  const [lastAttestation, setLastAttestation] = useState<ComplianceAttestation | null>(null);
  const [lastKeyImage, setLastKeyImage] = useState<ComplianceLastKeyImage | null>(null);
  const [daysContributed, setDaysContributed] = useState(0);
  const [rawCounters, setRawCounters] = useState<Record<string, unknown> | null>(null);
  const [logRows, setLogRows] = useState<AttestationLogRow[]>([]);
  const [logLoading, setLogLoading] = useState(true);
  const [exportBusy, setExportBusy] = useState(false);
  const [copiedVerifier, setCopiedVerifier] = useState(false);

  // Load from chrome.storage on mount
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage) return;

    chrome.storage.local
      .get([
        'observatory_ring_cache',
        'observatory_last_attestation',
        'observatory_last_key_image',
        'observatory_days_contributed',
        'observatory_counters',
      ])
      .then((res) => {
        const rc = res.observatory_ring_cache;
        setRingCache(rc && typeof rc === 'object' ? (rc as ComplianceRingCache) : null);
        const la = res.observatory_last_attestation;
        setLastAttestation(la && typeof la === 'object' ? (la as ComplianceAttestation) : null);
        const lki = res.observatory_last_key_image;
        setLastKeyImage(lki && typeof lki === 'object' ? (lki as ComplianceLastKeyImage) : null);
        setDaysContributed(typeof res.observatory_days_contributed === 'number' ? res.observatory_days_contributed : 0);
        const ctr = res.observatory_counters;
        setRawCounters(ctr && typeof ctr === 'object' ? (ctr as Record<string, unknown>) : null);
      })
      .catch(() => {})
      .finally(() => {
        // Build attestation log from stored data (last 30 days where we contributed)
        buildLogRows();
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buildLogRows = () => {
    setLogLoading(true);
    chrome.storage.local
      .get(['observatory_last_attestation', 'observatory_last_key_image', 'observatory_days_contributed'])
      .then((res) => {
        const contributed = typeof res.observatory_days_contributed === 'number' ? res.observatory_days_contributed : 0;
        if (contributed === 0) {
          setLogRows([]);
          return;
        }
        // Build rows for the last 30 calendar days; mark days where we have an attestation record
        const la = res.observatory_last_attestation as ComplianceAttestation | undefined;
        const lki = res.observatory_last_key_image as ComplianceLastKeyImage | undefined;
        const rows: AttestationLogRow[] = [];
        const today = new Date();
        for (let i = 0; i < 30; i++) {
          const d = new Date(today);
          d.setDate(today.getDate() - i);
          const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          // Only include dates that match stored attestation (client-side only — no server fetch to avoid CORS in sidepanel)
          if (la && la.date === iso) {
            rows.push({
              date: iso,
              keyImagePrefix: lki?.hex ? lki.hex.slice(0, 12) + '…' : '—',
              valid: la.valid,
              reason: la.reason,
            });
          }
        }
        setLogRows(rows);
      })
      .catch(() => {})
      .finally(() => setLogLoading(false));
  };

  const handleExport = () => {
    setExportBusy(true);
    const today = todayISOCompliance();
    const bundle = {
      attestation: lastAttestation ?? null,
      keyImage: lastKeyImage ?? null,
      ring: ringCache
        ? {
            version: ringCache.version,
            ringHash: ringCache.ringHash,
            ringSize: ringCache.pubKeys.length,
            fetchedAt: new Date(ringCache.fetchedAt).toISOString(),
          }
        : null,
      counters: rawCounters ?? null,
      exportedAt: new Date().toISOString(),
      date: today,
    };
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `accessbridge-compliance-${today}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setExportBusy(false);
  };

  const handleCopyVerifier = () => {
    const today = todayISOCompliance();
    const url = `http://72.61.227.64:8300/observatory/verifier?date=${today}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedVerifier(true);
      setTimeout(() => setCopiedVerifier(false), 2000);
    }).catch(() => {});
  };

  const VERIFIER_URL = `http://72.61.227.64:8300/observatory/verifier?date=${todayISOCompliance()}`;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div
        className="rounded-xl p-4"
        style={{
          background: '#1a1a2e',
          border: '1px solid rgba(123,104,238,0.18)',
          borderTop: '4px solid transparent',
          borderImage: 'linear-gradient(135deg, #7b68ee, #bb86fc) 1',
        }}
      >
        <div className="flex items-center gap-3 mb-1">
          {/* Brand mark */}
          <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true">
            <rect width="64" height="64" rx="14" fill="url(#cg)" />
            <defs>
              <linearGradient id="cg" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#7b68ee" />
                <stop offset="100%" stopColor="#bb86fc" />
              </linearGradient>
            </defs>
            <polyline points="18,32 27,42 46,22" fill="none" stroke="#fff" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <h2 className="text-sm font-bold" style={{ color: '#e2e8f0' }}>Compliance Observatory</h2>
            <p className="text-xs" style={{ color: '#94a3b8' }}>Zero-knowledge ring attestation</p>
          </div>
        </div>
      </div>

      {/* Ring snapshot */}
      <div
        className="rounded-xl p-3 space-y-2 text-xs"
        style={{ background: '#1a1a2e', border: '1px solid rgba(123,104,238,0.18)' }}
      >
        <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: '#bb86fc', letterSpacing: '1.2px' }}>
          Ring Snapshot
        </div>
        <div className="flex justify-between">
          <span style={{ color: '#94a3b8' }}>Ring size</span>
          <span className="font-mono" style={{ color: '#e2e8f0' }}>{ringCache ? ringCache.pubKeys.length : '—'}</span>
        </div>
        <div className="flex justify-between">
          <span style={{ color: '#94a3b8' }}>Ring version</span>
          <span className="font-mono" style={{ color: '#e2e8f0' }}>{ringCache ? ringCache.version : '—'}</span>
        </div>
        <div className="flex justify-between">
          <span style={{ color: '#94a3b8' }}>Days contributed</span>
          <span className="font-mono" style={{ color: '#e2e8f0' }}>{daysContributed}</span>
        </div>
        {lastKeyImage && (
          <div className="flex justify-between">
            <span style={{ color: '#94a3b8' }}>Last key image</span>
            <span className="font-mono text-xs" style={{ color: '#bb86fc' }} title={lastKeyImage.hex}>
              {lastKeyImage.hex.slice(0, 12)}…
            </span>
          </div>
        )}
      </div>

      {/* Attestation log */}
      <div
        className="rounded-xl p-3"
        style={{ background: '#1a1a2e', border: '1px solid rgba(123,104,238,0.18)' }}
      >
        <div className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: '#bb86fc', letterSpacing: '1.2px' }}>
          Attestation Log (last 30 days)
        </div>
        {logLoading ? (
          <div className="text-xs text-center py-4" style={{ color: '#94a3b8' }}>
            <span className="inline-block animate-spin mr-1">⟳</span> Loading…
          </div>
        ) : logRows.length === 0 ? (
          <div
            className="text-xs text-center py-4 rounded-lg"
            style={{ color: '#94a3b8', background: '#0a0a1a' }}
          >
            No attestations recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(123,104,238,0.2)' }}>
                  {['Date', 'Attested', 'Valid', 'Key image'].map((h) => (
                    <th
                      key={h}
                      style={{ padding: '4px 6px', textAlign: 'left', color: '#94a3b8', fontWeight: 600, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.8px' }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logRows.map((row) => (
                  <tr key={row.date} style={{ borderBottom: '1px solid rgba(123,104,238,0.08)' }}>
                    <td style={{ padding: '5px 6px', color: '#e2e8f0', fontFamily: 'monospace' }}>{row.date}</td>
                    <td style={{ padding: '5px 6px' }}>
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: '999px',
                          fontSize: '10px',
                          fontWeight: 700,
                          letterSpacing: '0.8px',
                          textTransform: 'uppercase',
                          background: 'rgba(123,104,238,0.15)',
                          color: '#bb86fc',
                        }}
                      >
                        You
                      </span>
                    </td>
                    <td style={{ padding: '5px 6px' }}>
                      {row.valid ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-label="Valid">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <span title={row.reason ?? 'Invalid'} style={{ cursor: 'help' }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-label={`Invalid: ${row.reason ?? ''}`}>
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '5px 6px', color: '#94a3b8', fontFamily: 'monospace', fontSize: '10px' }}>{row.keyImagePrefix}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Export bundle */}
      <button
        onClick={handleExport}
        disabled={exportBusy}
        style={{
          width: '100%',
          padding: '10px 16px',
          borderRadius: '10px',
          fontSize: '13px',
          fontWeight: 600,
          background: 'linear-gradient(135deg, #7b68ee, #bb86fc)',
          color: '#fff',
          border: 'none',
          cursor: exportBusy ? 'not-allowed' : 'pointer',
          opacity: exportBusy ? 0.6 : 1,
          boxShadow: '0 4px 12px rgba(123,104,238,0.35)',
          transition: 'opacity 0.2s, transform 0.2s',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
        }}
        aria-busy={exportBusy}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        {exportBusy ? 'Exporting…' : 'Export today\'s bundle'}
      </button>

      {/* Verifier URL */}
      <div
        className="rounded-xl p-3 space-y-2"
        style={{ background: '#1a1a2e', border: '1px solid rgba(123,104,238,0.18)' }}
      >
        <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#bb86fc', letterSpacing: '1.2px' }}>
          Verifier URL
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={VERIFIER_URL}
            className="flex-1 rounded text-xs font-mono"
            style={{
              background: '#0a0a1a',
              border: '1px solid rgba(123,104,238,0.2)',
              color: '#94a3b8',
              padding: '6px 8px',
              outline: 'none',
            }}
            aria-label="Verifier URL"
          />
          <button
            onClick={handleCopyVerifier}
            style={{
              padding: '6px 10px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 600,
              background: copiedVerifier ? 'rgba(16,185,129,0.15)' : 'rgba(123,104,238,0.15)',
              color: copiedVerifier ? '#10b981' : '#bb86fc',
              border: `1px solid ${copiedVerifier ? 'rgba(16,185,129,0.4)' : 'rgba(123,104,238,0.3)'}`,
              cursor: 'pointer',
              transition: 'color 0.2s, background 0.2s, border-color 0.2s',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              flexShrink: 0,
            }}
            aria-label="Copy verifier URL"
          >
            {copiedVerifier ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {copiedVerifier ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <p className="text-xs" style={{ color: '#94a3b8', lineHeight: 1.4 }}>
          Share this link with an auditor to let them verify your ring membership without revealing your identity.
        </p>
      </div>
    </div>
  );
}

// ─── Mount ────────────────────────────────────────────────────────────────────

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <SidePanel />
    </React.StrictMode>,
  );
}
