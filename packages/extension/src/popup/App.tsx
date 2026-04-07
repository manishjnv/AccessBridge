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

interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  changelog: string;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [profile, setProfile] = useState<AccessibilityProfile>({ ...DEFAULT_PROFILE });
  const [struggleScore, setStruggleScore] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [enabled, setEnabled] = useState(true);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateStep, setUpdateStep] = useState<'idle' | 'downloading' | 'downloaded' | 'reloading'>('idle');

  // Load profile and poll struggle score
  useEffect(() => {
    // Restore enabled state from storage
    chrome.storage.local.get('accessbridge_enabled').then((result) => {
      if (result.accessbridge_enabled === false) setEnabled(false);
    }).catch(() => {});

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
      // Apply immediately to active tab
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'APPLY_SENSORY',
            payload: { ...profile.sensory, ...patch },
          }).catch(() => {});
        }
      });
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
    const newState = !enabled;
    setEnabled(newState);
    chrome.storage.local.set({ accessbridge_enabled: newState });

    if (!newState) {
      // Disable: revert all adaptations — send to background AND directly to all tabs
      chrome.runtime.sendMessage({ type: 'REVERT_ALL' }).catch(() => {});
      chrome.tabs.query({}).then((tabs) => {
        for (const tab of tabs) {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, { type: 'REVERT_ALL' }).catch(() => {});
          }
        }
      });
    }
    // When re-enabled, user manually turns on features they want
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

  const handleCheckUpdate = useCallback(() => {
    setCheckingUpdate(true);
    setUpdateInfo(null);
    setUpdateStep('idle');
    chrome.runtime.sendMessage({ type: 'CHECK_UPDATE' }).then((res) => {
      setCheckingUpdate(false);
      if (res && typeof res === 'object' && 'hasUpdate' in res) {
        setUpdateInfo(res as UpdateInfo);
      }
    }).catch(() => {
      setCheckingUpdate(false);
      setUpdateInfo({ hasUpdate: false, currentVersion: chrome.runtime.getManifest().version, latestVersion: '', downloadUrl: '', changelog: '' });
    });
  }, []);

  const handleDownloadUpdate = useCallback(() => {
    if (!updateInfo?.downloadUrl) return;
    setUpdateStep('downloading');
    // Use chrome.downloads API to auto-download the zip
    chrome.downloads.download({
      url: updateInfo.downloadUrl,
      filename: 'accessbridge-extension.zip',
      saveAs: false,
    }, (downloadId) => {
      if (downloadId) {
        // Monitor download completion
        const listener = (delta: chrome.downloads.DownloadDelta) => {
          if (delta.id === downloadId && delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(listener);
            setUpdateStep('downloaded');
          }
        };
        chrome.downloads.onChanged.addListener(listener);
      } else {
        // Fallback: open in tab if downloads API fails
        chrome.tabs.create({ url: updateInfo.downloadUrl });
        setUpdateStep('downloaded');
      }
    });
  }, [updateInfo]);

  const handleReloadExtension = useCallback(() => {
    setUpdateStep('reloading');
    // Short delay so user sees the state change
    setTimeout(() => {
      chrome.runtime.reload();
    }, 500);
  }, []);

  return (
    <div className="bg-a11y-bg text-a11y-text min-h-[300px] flex flex-col">
      {/* Update banner — 2-step: Download then Reload */}
      {updateInfo?.hasUpdate && (
        <div style={{
          background: 'linear-gradient(135deg, rgba(16,185,129,0.15), rgba(123,104,238,0.1))',
          borderBottom: '1px solid rgba(16,185,129,0.3)',
          padding: '10px 16px',
          fontSize: '12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
            <span style={{ color: '#10b981', fontWeight: 700, fontSize: '13px' }}>v{updateInfo.latestVersion} available</span>
          </div>
          <div style={{ color: '#94a3b8', fontSize: '11px', marginBottom: '10px' }}>{updateInfo.changelog}</div>

          {updateStep === 'idle' && (
            <button
              onClick={handleDownloadUpdate}
              style={{
                background: 'linear-gradient(135deg, #7b68ee, #bb86fc)',
                border: 'none', color: 'white', borderRadius: '6px',
                padding: '8px 16px', fontSize: '12px', fontWeight: 600,
                cursor: 'pointer', width: '100%',
              }}
            >
              Step 1: Download Update
            </button>
          )}

          {updateStep === 'downloading' && (
            <div style={{ textAlign: 'center', color: '#bb86fc', padding: '8px 0' }}>
              Downloading...
            </div>
          )}

          {updateStep === 'downloaded' && (
            <>
              <div style={{ color: '#10b981', fontSize: '11px', marginBottom: '8px', textAlign: 'center' }}>
                Downloaded! Extract zip to the same folder, then:
              </div>
              <button
                onClick={handleReloadExtension}
                style={{
                  background: 'linear-gradient(135deg, #10b981, #059669)',
                  border: 'none', color: 'white', borderRadius: '6px',
                  padding: '8px 16px', fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer', width: '100%',
                }}
              >
                Step 2: Reload Extension
              </button>
            </>
          )}

          {updateStep === 'reloading' && (
            <div style={{ textAlign: 'center', color: '#10b981', padding: '8px 0' }}>
              Reloading...
            </div>
          )}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-a11y-surface border-b border-a11y-primary/30">
        <div className="flex items-center gap-2">
          <span className="text-a11y-accent font-bold text-base">AccessBridge</span>
          <span className="text-a11y-muted text-xs">v{chrome.runtime.getManifest().version}</span>
        </div>
        <Toggle value={enabled} onChange={handleToggleAll} size="sm" />
      </div>

      {/* Tab navigation */}
      <TabNav tabs={TABS} active={tab} onChange={(id) => setTab(id as Tab)} />

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" style={!enabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
        {!enabled && (
          <div style={{
            textAlign: 'center',
            padding: '24px 12px',
            color: '#94a3b8',
            fontSize: '13px',
          }}>
            AccessBridge is disabled. Toggle On to use features.
          </div>
        )}
        {enabled && tab === 'overview' && (
          <OverviewTab score={struggleScore} activeCount={activeCount} />
        )}
        {enabled && tab === 'sensory' && (
          <SensoryTab sensory={profile.sensory} onChange={updateSensory} />
        )}
        {enabled && tab === 'cognitive' && (
          <CognitiveTab cognitive={profile.cognitive} onChange={updateCognitive} />
        )}
        {enabled && tab === 'motor' && (
          <MotorTab motor={profile.motor} onChange={updateMotor} />
        )}
        {enabled && tab === 'settings' && (
          <SettingsTab
            profile={profile}
            onSave={saveProfile}
            onExport={handleExport}
            onImport={handleImport}
            onCheckUpdate={handleCheckUpdate}
            checkingUpdate={checkingUpdate}
            updateInfo={updateInfo}
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
  // 1. Save to storage (survives popup close, content script listens for changes)
  chrome.storage.local.get('activeFeatures').then((result) => {
    const features = (result.activeFeatures as Record<string, boolean>) || {};
    features[feature] = enabled;
    chrome.storage.local.set({ activeFeatures: features });
  }).catch(() => {});

  // 2. Send to background (for tracking active adaptations)
  chrome.runtime.sendMessage({
    type: 'TOGGLE_FEATURE',
    payload: { feature, enabled },
  }).catch(() => {});

  // 3. Send directly to active tab's content script
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_FEATURE_DIRECT',
        payload: { feature, enabled },
      }).catch(() => {});
    }
  });
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
        onChange={(v) => {
          onChange({ keyboardOnlyMode: v });
          chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
            if (tab?.id) {
              chrome.tabs.sendMessage(tab.id, {
                type: 'TOGGLE_KEYBOARD_MODE',
                payload: { enabled: v },
              }).catch(() => {});
            }
          });
        }}
      />
      <Toggle
        label="Predictive Input"
        value={motor.predictiveInput}
        onChange={(v) => {
          onChange({ predictiveInput: v });
          chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
            if (tab?.id) {
              chrome.tabs.sendMessage(tab.id, {
                type: 'TOGGLE_PREDICTIVE_INPUT',
                payload: { enabled: v },
              }).catch(() => {});
            }
          });
        }}
      />
      <Toggle
        label="Dwell Click"
        value={motor.dwellClickEnabled}
        onChange={(v) => {
          onChange({ dwellClickEnabled: v });
          // Direct message to content script for dwell click
          chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
            if (tab?.id) {
              chrome.tabs.sendMessage(tab.id, {
                type: 'TOGGLE_DWELL_CLICK',
                payload: { enabled: v, delay: motor.dwellClickDelay },
              }).catch(() => {});
            }
          });
        }}
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
  onCheckUpdate,
  checkingUpdate,
  updateInfo,
}: {
  profile: AccessibilityProfile;
  onSave: (p: AccessibilityProfile) => void;
  onExport: () => void;
  onImport: () => void;
  onCheckUpdate: () => void;
  checkingUpdate: boolean;
  updateInfo: UpdateInfo | null;
}) {
  return (
    <>
      {/* Update section */}
      <div className="bg-a11y-surface rounded-lg p-3 border border-a11y-primary/20">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-a11y-muted">Version</span>
          <span className="text-xs font-mono text-a11y-text">v{chrome.runtime.getManifest().version}</span>
        </div>
        <button
          onClick={onCheckUpdate}
          disabled={checkingUpdate}
          className="w-full bg-a11y-primary hover:bg-a11y-primary/80 text-a11y-text text-sm py-2 rounded transition-colors disabled:opacity-50"
        >
          {checkingUpdate ? 'Checking...' : 'Check for Update'}
        </button>
        {updateInfo && !updateInfo.hasUpdate && (
          <div className="text-xs text-center mt-2" style={{ color: '#10b981' }}>
            You are on the latest version
          </div>
        )}
      </div>

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
