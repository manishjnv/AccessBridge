import React, { useCallback, useEffect, useState } from 'react';
import type {
  AccessibilityProfile,
  SensoryProfile,
  CognitiveProfile,
  MotorProfile,
} from '@accessbridge/core/types';
import {
  DEFAULT_PROFILE,
} from '@accessbridge/core/types';
import { TabNav } from './components/TabNav.js';
import { Slider } from './components/Slider.js';
import { Toggle } from './components/Toggle.js';

type Tab = 'overview' | 'sensory' | 'cognitive' | 'motor' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'sensory', label: 'Sensory' },
  { id: 'cognitive', label: 'Cognitive' },
  { id: 'motor', label: 'Motor' },
  { id: 'settings', label: 'Settings' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [profile, setProfile] = useState<AccessibilityProfile>({ ...DEFAULT_PROFILE });
  const [struggleScore, setStruggleScore] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [enabled, setEnabled] = useState(true);

  // Load profile and poll struggle score
  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_PROFILE' }).then((p) => {
      if (p) setProfile(p as AccessibilityProfile);
    }).catch(() => {});

    const pollScore = () => {
      chrome.runtime.sendMessage({ type: 'GET_STRUGGLE_SCORE' }).then((s) => {
        if (s && typeof s === 'object' && 'score' in s) {
          setStruggleScore((s as { score: number }).score);
        }
      }).catch(() => {});
      chrome.runtime.sendMessage({ type: 'GET_ACTIVE_ADAPTATIONS' }).then((a) => {
        if (Array.isArray(a)) setActiveCount(a.length);
      }).catch(() => {});
    };

    pollScore();
    const interval = setInterval(pollScore, 3000);
    return () => clearInterval(interval);
  }, []);

  const saveProfile = useCallback(
    (updated: AccessibilityProfile) => {
      setProfile(updated);
      chrome.runtime.sendMessage({ type: 'SAVE_PROFILE', payload: updated }).catch(() => {});
    },
    [],
  );

  const updateSensory = useCallback(
    (patch: Partial<SensoryProfile>) => {
      const updated = { ...profile, sensory: { ...profile.sensory, ...patch }, updatedAt: Date.now() };
      saveProfile(updated);
    },
    [profile, saveProfile],
  );

  const updateCognitive = useCallback(
    (patch: Partial<CognitiveProfile>) => {
      const updated = { ...profile, cognitive: { ...profile.cognitive, ...patch }, updatedAt: Date.now() };
      saveProfile(updated);
    },
    [profile, saveProfile],
  );

  const updateMotor = useCallback(
    (patch: Partial<MotorProfile>) => {
      const updated = { ...profile, motor: { ...profile.motor, ...patch }, updatedAt: Date.now() };
      saveProfile(updated);
    },
    [profile, saveProfile],
  );

  const handleToggleAll = useCallback(() => {
    if (enabled) {
      chrome.runtime.sendMessage({ type: 'REVERT_ALL' }).catch(() => {});
    }
    setEnabled(!enabled);
  }, [enabled]);

  const handleExport = useCallback(() => {
    const json = JSON.stringify(profile, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'accessbridge-profile.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [profile]);

  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const imported = JSON.parse(text) as AccessibilityProfile;
        saveProfile(imported);
      } catch {
        console.error('Invalid profile JSON');
      }
    };
    input.click();
  }, [saveProfile]);

  return (
    <div className="bg-a11y-bg text-a11y-text min-h-[300px] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-a11y-surface border-b border-a11y-primary/30">
        <div className="flex items-center gap-2">
          <span className="text-a11y-accent font-bold text-base">AccessBridge</span>
          <span className="text-a11y-muted text-xs">v0.1.0</span>
        </div>
        <Toggle value={enabled} onChange={handleToggleAll} size="sm" />
      </div>

      {/* Tab navigation */}
      <TabNav tabs={TABS} active={tab} onChange={(id) => setTab(id as Tab)} />

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {tab === 'overview' && (
          <OverviewTab score={struggleScore} activeCount={activeCount} />
        )}
        {tab === 'sensory' && (
          <SensoryTab sensory={profile.sensory} onChange={updateSensory} />
        )}
        {tab === 'cognitive' && (
          <CognitiveTab cognitive={profile.cognitive} onChange={updateCognitive} />
        )}
        {tab === 'motor' && (
          <MotorTab motor={profile.motor} onChange={updateMotor} />
        )}
        {tab === 'settings' && (
          <SettingsTab
            profile={profile}
            onSave={saveProfile}
            onExport={handleExport}
            onImport={handleImport}
          />
        )}
      </div>
    </div>
  );
}

// ---------- Tab panels ----------

function OverviewTab({ score, activeCount }: { score: number; activeCount: number }) {
  const scoreColor =
    score < 30 ? 'text-green-400' : score < 60 ? 'text-yellow-400' : 'text-red-400';

  return (
    <>
      <div className="text-center py-4">
        <div className="text-xs text-a11y-muted uppercase tracking-wider mb-1">Struggle Score</div>
        <div className={`text-5xl font-bold ${scoreColor}`}>{score}</div>
        <div className="text-xs text-a11y-muted mt-1">/ 100</div>
      </div>
      <div className="flex justify-between bg-a11y-surface rounded-lg p-3">
        <div className="text-center">
          <div className="text-lg font-semibold">{activeCount}</div>
          <div className="text-xs text-a11y-muted">Active Adaptations</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-semibold">{score < 30 ? 'Low' : score < 60 ? 'Medium' : 'High'}</div>
          <div className="text-xs text-a11y-muted">Struggle Level</div>
        </div>
      </div>
    </>
  );
}

function SensoryTab({
  sensory,
  onChange,
}: {
  sensory: SensoryProfile;
  onChange: (patch: Partial<SensoryProfile>) => void;
}) {
  return (
    <>
      <Slider
        label="Font Scale"
        value={sensory.fontScale}
        min={0.8}
        max={2.0}
        step={0.1}
        onChange={(v) => onChange({ fontScale: v })}
        unit="x"
      />
      <Slider
        label="Contrast"
        value={sensory.contrastLevel}
        min={0.5}
        max={2.0}
        step={0.1}
        onChange={(v) => onChange({ contrastLevel: v })}
        unit="x"
      />
      <Slider
        label="Line Height"
        value={sensory.lineHeight}
        min={1.0}
        max={3.0}
        step={0.1}
        onChange={(v) => onChange({ lineHeight: v })}
      />
      <Slider
        label="Letter Spacing"
        value={sensory.letterSpacing}
        min={0}
        max={5}
        step={0.5}
        onChange={(v) => onChange({ letterSpacing: v })}
        unit="px"
      />
      <div className="space-y-1">
        <label className="text-xs text-a11y-muted">Color Correction</label>
        <select
          className="w-full bg-a11y-surface text-a11y-text border border-a11y-primary/30 rounded px-2 py-1.5 text-sm"
          value={sensory.colorCorrectionMode}
          onChange={(e) =>
            onChange({
              colorCorrectionMode: e.target.value as SensoryProfile['colorCorrectionMode'],
            })
          }
        >
          <option value="none">None</option>
          <option value="protanopia">Protanopia (Red-blind)</option>
          <option value="deuteranopia">Deuteranopia (Green-blind)</option>
          <option value="tritanopia">Tritanopia (Blue-blind)</option>
        </select>
      </div>
      <Toggle
        label="Reduced Motion"
        value={sensory.reducedMotion}
        onChange={(v) => onChange({ reducedMotion: v })}
      />
      <Toggle
        label="High Contrast"
        value={sensory.highContrast}
        onChange={(v) => onChange({ highContrast: v })}
      />
    </>
  );
}

function toggleFeature(feature: string, enabled: boolean): void {
  chrome.runtime.sendMessage({
    type: 'TOGGLE_FEATURE',
    payload: { feature, enabled },
  }).catch(() => {});
}

function CognitiveTab({
  cognitive,
  onChange,
}: {
  cognitive: CognitiveProfile;
  onChange: (patch: Partial<CognitiveProfile>) => void;
}) {
  return (
    <>
      <Toggle
        label="Focus Mode"
        value={cognitive.focusModeEnabled}
        onChange={(v) => {
          onChange({ focusModeEnabled: v });
          toggleFeature('focus-mode', v);
        }}
      />
      <Toggle
        label="Reading Mode"
        value={cognitive.readingModeEnabled}
        onChange={(v) => {
          onChange({ readingModeEnabled: v });
          toggleFeature('reading-mode', v);
        }}
      />
      <div className="space-y-1">
        <label className="text-xs text-a11y-muted">Text Simplification</label>
        <select
          className="w-full bg-a11y-surface text-a11y-text border border-a11y-primary/30 rounded px-2 py-1.5 text-sm"
          value={cognitive.textSimplification}
          onChange={(e) => {
            const val = e.target.value as CognitiveProfile['textSimplification'];
            onChange({ textSimplification: val });
            toggleFeature('text-simplify', val !== 'off');
          }}
        >
          <option value="off">Off</option>
          <option value="mild">Mild</option>
          <option value="strong">Strong</option>
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-a11y-muted">Notification Level</label>
        <select
          className="w-full bg-a11y-surface text-a11y-text border border-a11y-primary/30 rounded px-2 py-1.5 text-sm"
          value={cognitive.notificationLevel}
          onChange={(e) =>
            onChange({
              notificationLevel: e.target.value as CognitiveProfile['notificationLevel'],
            })
          }
        >
          <option value="all">All</option>
          <option value="important">Important Only</option>
          <option value="critical">Critical Only</option>
          <option value="none">None</option>
        </select>
      </div>
      <Toggle
        label="Auto Summarize"
        value={cognitive.autoSummarize}
        onChange={(v) => {
          onChange({ autoSummarize: v });
          toggleFeature('auto-summarize', v);
        }}
      />
      <Toggle
        label="Distraction Shield"
        value={cognitive.distractionShield}
        onChange={(v) => {
          onChange({ distractionShield: v });
          toggleFeature('distraction-shield', v);
        }}
      />
    </>
  );
}

function MotorTab({
  motor,
  onChange,
}: {
  motor: MotorProfile;
  onChange: (patch: Partial<MotorProfile>) => void;
}) {
  return (
    <>
      <Toggle
        label="Voice Navigation"
        value={motor.voiceNavigationEnabled}
        onChange={(v) => {
          onChange({ voiceNavigationEnabled: v });
          toggleFeature('voice-nav', v);
        }}
      />
      <Toggle
        label="Eye Tracking"
        value={motor.eyeTrackingEnabled}
        onChange={(v) => {
          onChange({ eyeTrackingEnabled: v });
          toggleFeature('eye-tracking', v);
        }}
      />
      <Toggle
        label="Smart Click Targets"
        value={motor.smartClickTargets}
        onChange={(v) => {
          onChange({ smartClickTargets: v });
          toggleFeature('smart-targets', v);
        }}
      />
      <Toggle
        label="Keyboard-Only Mode"
        value={motor.keyboardOnlyMode}
        onChange={(v) => onChange({ keyboardOnlyMode: v })}
      />
      <Toggle
        label="Predictive Input"
        value={motor.predictiveInput}
        onChange={(v) => onChange({ predictiveInput: v })}
      />
      <Toggle
        label="Dwell Click"
        value={motor.dwellClickEnabled}
        onChange={(v) => onChange({ dwellClickEnabled: v })}
      />
      {motor.dwellClickEnabled && (
        <Slider
          label="Dwell Delay"
          value={motor.dwellClickDelay}
          min={200}
          max={2000}
          step={100}
          onChange={(v) => onChange({ dwellClickDelay: v })}
          unit="ms"
        />
      )}
    </>
  );
}

function SettingsTab({
  profile,
  onSave,
  onExport,
  onImport,
}: {
  profile: AccessibilityProfile;
  onSave: (p: AccessibilityProfile) => void;
  onExport: () => void;
  onImport: () => void;
}) {
  return (
    <>
      <div className="space-y-1">
        <label className="text-xs text-a11y-muted">Adaptation Mode</label>
        <select
          className="w-full bg-a11y-surface text-a11y-text border border-a11y-primary/30 rounded px-2 py-1.5 text-sm"
          value={profile.adaptationMode}
          onChange={(e) =>
            onSave({
              ...profile,
              adaptationMode: e.target.value as AccessibilityProfile['adaptationMode'],
              updatedAt: Date.now(),
            })
          }
        >
          <option value="auto">Automatic</option>
          <option value="manual">Manual</option>
          <option value="suggest">Suggest</option>
        </select>
      </div>
      <Slider
        label="Confidence Threshold"
        value={profile.confidenceThreshold}
        min={0.1}
        max={1.0}
        step={0.05}
        onChange={(v) => onSave({ ...profile, confidenceThreshold: v, updatedAt: Date.now() })}
      />
      <div className="space-y-1">
        <label className="text-xs text-a11y-muted">Language</label>
        <select
          className="w-full bg-a11y-surface text-a11y-text border border-a11y-primary/30 rounded px-2 py-1.5 text-sm"
          value={profile.language}
          onChange={(e) =>
            onSave({ ...profile, language: e.target.value, updatedAt: Date.now() })
          }
        >
          <option value="en">English</option>
          <option value="es">Spanish</option>
          <option value="fr">French</option>
          <option value="de">German</option>
          <option value="zh">Chinese</option>
          <option value="ja">Japanese</option>
          <option value="ar">Arabic</option>
          <option value="hi">Hindi</option>
        </select>
      </div>
      <div className="flex gap-2 pt-2">
        <button
          onClick={onExport}
          className="flex-1 bg-a11y-primary hover:bg-a11y-primary/80 text-a11y-text text-sm py-2 rounded transition-colors"
        >
          Export Profile
        </button>
        <button
          onClick={onImport}
          className="flex-1 bg-a11y-surface hover:bg-a11y-surface/80 text-a11y-text text-sm py-2 rounded border border-a11y-primary/30 transition-colors"
        >
          Import Profile
        </button>
      </div>
    </>
  );
}
