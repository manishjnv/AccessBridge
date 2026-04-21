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
import { GestureLibrary } from './components/GestureLibrary.js';

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
  // --- Session 19 / 21: Desktop Agent ---
  const [agentStatus, setAgentStatus] = useState<{
    connected: boolean;
    state: string;
    server: { version: string; platform?: string; capabilities?: string[] } | null;
    agentInfo: { version: string; platform: string; capabilities: string[] } | null;
  }>({ connected: false, state: 'idle', server: null, agentInfo: null });
  const [showPairDialog, setShowPairDialog] = useState(false);
  const [pskInput, setPskInput] = useState('');
  const [pairError, setPairError] = useState<string | null>(null);
  // --- Session 20: Enterprise Managed Policy ---
  const [lockedKeys, setLockedKeys] = useState<Set<string>>(new Set());

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

  // --- Session 19: Desktop Agent status polling ---
  useEffect(() => {
    const poll = () => {
      chrome.runtime.sendMessage({ type: 'AGENT_GET_STATUS' }, (status) => {
        if (status && typeof status === 'object') setAgentStatus(status as typeof agentStatus);
      });
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, []);

  // --- Session 20: Enterprise Managed Policy lockdown polling ---
  useEffect(() => {
    const pollLockdown = () => {
      chrome.runtime.sendMessage({ type: 'ENTERPRISE_GET_LOCKDOWN' }).then((res) => {
        if (res && typeof res === 'object' && Array.isArray((res as { lockedKeys: string[] }).lockedKeys)) {
          setLockedKeys(new Set((res as { lockedKeys: string[] }).lockedKeys));
        }
      }).catch(() => {});
    };
    pollLockdown();
    const id = setInterval(pollLockdown, 10_000);
    return () => clearInterval(id);
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

  // --- Session 20: Enterprise policy helper ---
  function isLocked(key: string): boolean {
    return lockedKeys.has(key);
  }

  return (
    <div className="bg-a11y-bg text-a11y-text min-h-[300px] flex flex-col">
      {/* --- Session 19: Desktop Agent Pair Dialog --- */}
      {showPairDialog && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(10, 10, 26, 0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }} onClick={() => setShowPairDialog(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: 'var(--surface, #1a1a2e)',
            border: '1px solid rgba(123, 104, 238, 0.3)',
            borderRadius: 14, padding: 24, minWidth: 320, maxWidth: 420,
          }}>
            <h3 style={{ color: '#e2e8f0', fontSize: 16, margin: '0 0 8px 0' }}>Pair Desktop Agent</h3>
            <p style={{ color: '#94a3b8', fontSize: 12, margin: '0 0 12px 0', lineHeight: 1.5 }}>
              Open the Desktop Agent then Settings then Overview, copy the Pair Key, paste it here.
            </p>
            <textarea
              value={pskInput}
              onChange={(e) => { setPskInput(e.target.value); setPairError(null); }}
              placeholder="Paste base64 pair key..."
              style={{
                width: '100%', minHeight: 80, padding: 10,
                background: '#0a0a1a', color: '#e2e8f0',
                border: '1px solid rgba(123, 104, 238, 0.2)',
                borderRadius: 8, fontFamily: 'monospace', fontSize: 11, resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
            {pairError && <div style={{ color: '#ef4444', fontSize: 11, marginTop: 6 }}>{pairError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button
                onClick={() => setShowPairDialog(false)}
                style={{ padding: '8px 14px', background: 'transparent', color: '#94a3b8', border: '1px solid rgba(148, 163, 184, 0.3)', borderRadius: 8, fontSize: 12, cursor: 'pointer' }}
              >Cancel</button>
              <button
                onClick={() => {
                  const trimmed = pskInput.trim();
                  if (trimmed.length < 40) { setPairError('Pair key looks too short'); return; }
                  chrome.runtime.sendMessage({ type: 'AGENT_SET_PSK', pskB64: trimmed }, (res) => {
                    if (res?.ok) { setShowPairDialog(false); setPskInput(''); }
                    else setPairError(res?.error ?? 'Pairing failed');
                  });
                }}
                style={{ padding: '8px 14px', background: 'linear-gradient(135deg, #7b68ee, #bb86fc)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              >Pair</button>
            </div>
          </div>
        </div>
      )}
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
                  background: '#10b981',
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

      {/* --- Session 20: Enterprise managed-policy banner --- */}
      {lockedKeys.size > 0 && (
        <div style={{ padding: '8px 12px', background: 'rgba(123, 104, 238, 0.15)', color: 'var(--accent, #bb86fc)', fontSize: 12, borderBottom: '1px solid rgba(123, 104, 238, 0.3)' }} role="status" aria-live="polite">
          {lockedKeys.size} setting{lockedKeys.size === 1 ? '' : 's'} managed by your organization
        </div>
      )}
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
          <OverviewTab score={struggleScore} activeCount={activeCount} agentStatus={agentStatus} onPairClick={() => setShowPairDialog(true)} />
        )}
        {enabled && tab === 'sensory' && (
          <SensoryTab sensory={profile.sensory} onChange={updateSensory} isLocked={isLocked} />
        )}
        {enabled && tab === 'cognitive' && (
          <CognitiveTab cognitive={profile.cognitive} onChange={updateCognitive} isLocked={isLocked} />
        )}
        {enabled && tab === 'motor' && (
          <MotorTab motor={profile.motor} onChange={updateMotor} isLocked={isLocked} />
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
            isLocked={isLocked}
          />
        )}
      </div>
    </div>
  );
}

// ---------- Tab panels ----------

// --- Session 21: platform display helper ---
function formatPlatform(p: string): string {
  if (p === 'macos') return 'macOS';
  if (p === 'windows') return 'Windows';
  if (p === 'linux') return 'Linux';
  // Capitalise first letter for unknown platforms
  return p.charAt(0).toUpperCase() + p.slice(1);
}

function OverviewTab({ score, activeCount, agentStatus, onPairClick }: {
  score: number;
  activeCount: number;
  agentStatus: {
    connected: boolean;
    state: string;
    server: { version: string; platform?: string; capabilities?: string[] } | null;
    agentInfo: { version: string; platform: string; capabilities: string[] } | null;
  };
  onPairClick: () => void;
}) {
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
      {/* --- Session 19: Desktop Agent --- */}
      <div style={{
        marginTop: 12,
        padding: '10px 14px',
        background: 'var(--surface, #1a1a2e)',
        border: '1px solid rgba(123, 104, 238, 0.18)',
        borderRadius: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: agentStatus.connected ? '#10b981' : (agentStatus.state === 'handshaking' || agentStatus.state === 'connecting' ? '#f59e0b' : '#94a3b8'),
            boxShadow: agentStatus.connected ? '0 0 6px rgba(16, 185, 129, 0.5)' : 'none',
            display: 'inline-block',
          }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>Desktop Agent</div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>
              {agentStatus.connected
                ? agentStatus.agentInfo
                  ? `Connected (${formatPlatform(agentStatus.agentInfo.platform)}, v${agentStatus.agentInfo.version})`
                  : `Connected (v${agentStatus.server?.version ?? '?'})`
                : agentStatus.state === 'handshaking' ? 'Pairing...'
                : agentStatus.state === 'connecting' ? 'Connecting...'
                : agentStatus.state === 'error' ? 'Error'
                : 'Not installed'}
            </div>
          </div>
        </div>
        {!agentStatus.connected && (
          <button
            onClick={onPairClick}
            style={{
              padding: '6px 12px',
              fontSize: 11,
              fontWeight: 600,
              background: 'linear-gradient(135deg, #7b68ee, #bb86fc)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            Pair
          </button>
        )}
      </div>
    </>
  );
}

function SensoryTab({
  sensory,
  onChange,
  isLocked,
}: {
  sensory: SensoryProfile;
  onChange: (patch: Partial<SensoryProfile>) => void;
  isLocked: (key: string) => boolean;
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
        locked={isLocked('sensory.reducedMotion')}
      />
      <Toggle
        label="High Contrast"
        value={sensory.highContrast}
        onChange={(v) => onChange({ highContrast: v })}
        locked={isLocked('sensory.highContrast')}
      />
      {/* --- Priority 1: Captions + Actions --- */}
      <Toggle
        label="Live Captions"
        value={sensory.liveCaptionsEnabled}
        onChange={(v) => onChange({ liveCaptionsEnabled: v })}
        locked={isLocked('sensory.liveCaptionsEnabled')}
      />
      {sensory.liveCaptionsEnabled && (
        <>
          <div className="space-y-1">
            <label className="text-xs text-a11y-muted">Captions Language</label>
            <select
              className="w-full bg-a11y-surface text-a11y-text border border-a11y-primary/30 rounded px-2 py-1.5 text-sm"
              value={sensory.captionsLanguage}
              onChange={(e) => onChange({ captionsLanguage: e.target.value })}
            >
              <option value="">Auto-detect</option>
              <option value="en-US">English (US)</option>
              <option value="en-GB">English (UK)</option>
              <option value="hi-IN">Hindi</option>
              <option value="ta-IN">Tamil</option>
              <option value="te-IN">Telugu</option>
              <option value="bn-IN">Bengali</option>
              <option value="mr-IN">Marathi</option>
              <option value="es-ES">Spanish</option>
              <option value="fr-FR">French</option>
              <option value="de-DE">German</option>
              <option value="ja-JP">Japanese</option>
              <option value="zh-CN">Chinese</option>
              <option value="ar-SA">Arabic</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-a11y-muted">Translate To</label>
            <select
              className="w-full bg-a11y-surface text-a11y-text border border-a11y-primary/30 rounded px-2 py-1.5 text-sm"
              value={sensory.captionsTranslateTo ?? ''}
              onChange={(e) => onChange({ captionsTranslateTo: e.target.value || null })}
            >
              <option value="">None</option>
              <option value="en-US">English</option>
              <option value="hi-IN">Hindi</option>
              <option value="ta-IN">Tamil</option>
              <option value="te-IN">Telugu</option>
              <option value="bn-IN">Bengali</option>
              <option value="es-ES">Spanish</option>
              <option value="fr-FR">French</option>
              <option value="de-DE">German</option>
              <option value="ja-JP">Japanese</option>
              <option value="zh-CN">Chinese</option>
            </select>
          </div>
          <Slider
            label="Caption Font Size"
            value={sensory.captionsFontSize}
            min={12}
            max={32}
            step={1}
            onChange={(v) => onChange({ captionsFontSize: v })}
            unit="px"
          />
          <div className="space-y-1">
            <label className="text-xs text-a11y-muted">Caption Position</label>
            <select
              className="w-full bg-a11y-surface text-a11y-text border border-a11y-primary/30 rounded px-2 py-1.5 text-sm"
              value={sensory.captionsPosition}
              onChange={(e) =>
                onChange({ captionsPosition: e.target.value as 'top' | 'bottom' })
              }
            >
              <option value="bottom">Bottom</option>
              <option value="top">Top</option>
            </select>
          </div>
        </>
      )}
      {/* --- Session 10: Vision Recovery --- */}
      <div className="pt-2 border-t border-a11y-primary/20 mt-2">
        <div className="text-xs text-a11y-muted uppercase tracking-wider mb-2">Visual Label Recovery</div>
        <Toggle
          label="Enable Vision Recovery"
          value={sensory.visionRecoveryEnabled}
          onChange={(v) => onChange({ visionRecoveryEnabled: v })}
          locked={isLocked('sensory.visionRecoveryEnabled')}
        />
        {sensory.visionRecoveryEnabled && (
          <>
            <Toggle
              label="Auto-scan on DOM change"
              value={sensory.visionRecoveryAutoScan}
              onChange={(v) => onChange({ visionRecoveryAutoScan: v })}
            />
            <Toggle
              label="Tier 2 API (uses configured AI provider; Tier 1 runs free)"
              value={sensory.visionRecoveryTier2APIEnabled}
              onChange={(v) => onChange({ visionRecoveryTier2APIEnabled: v })}
            />
            <Toggle
              label="Highlight recovered elements"
              value={sensory.visionRecoveryHighlightRecovered}
              onChange={(v) => onChange({ visionRecoveryHighlightRecovered: v })}
            />
            <div className="space-y-1">
              <label className="text-xs text-a11y-muted">
                Min confidence: {sensory.visionRecoveryMinConfidence.toFixed(2)}
              </label>
              <input
                type="range"
                min={0.3}
                max={0.9}
                step={0.05}
                value={sensory.visionRecoveryMinConfidence}
                onChange={(e) => onChange({ visionRecoveryMinConfidence: parseFloat(e.target.value) })}
                className="w-full"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="flex-1 bg-gradient-to-br from-a11y-primary to-a11y-accent text-white rounded px-2 py-1.5 text-xs font-semibold"
                onClick={() => {
                  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
                    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'VISION_SCAN_NOW' }).catch(() => {});
                  });
                }}
              >
                Scan Now
              </button>
              <button
                type="button"
                className="flex-1 bg-a11y-surface border border-a11y-primary/30 text-a11y-text rounded px-2 py-1.5 text-xs"
                onClick={() => {
                  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
                    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'VISION_CLEAR_CACHE' }).catch(() => {});
                  });
                }}
              >
                Clear Cache
              </button>
            </div>
          </>
        )}
      </div>
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
  isLocked,
}: {
  cognitive: CognitiveProfile;
  onChange: (patch: Partial<CognitiveProfile>) => void;
  isLocked: (key: string) => boolean;
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
        locked={isLocked('cognitive.focusModeEnabled')}
      />
      <Toggle
        label="Reading Mode"
        value={cognitive.readingModeEnabled}
        onChange={(v) => {
          onChange({ readingModeEnabled: v });
          toggleFeature('reading-mode', v);
        }}
        locked={isLocked('cognitive.readingModeEnabled')}
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
        locked={isLocked('cognitive.autoSummarize')}
      />
      <Toggle
        label="Distraction Shield"
        value={cognitive.distractionShield}
        onChange={(v) => {
          onChange({ distractionShield: v });
          toggleFeature('distraction-shield', v);
        }}
        locked={isLocked('cognitive.distractionShield')}
      />
      {/* --- Priority 1: Captions + Actions --- */}
      <Toggle
        label="Action Items"
        value={cognitive.actionItemsEnabled}
        onChange={(v) => onChange({ actionItemsEnabled: v })}
        locked={isLocked('cognitive.actionItemsEnabled')}
      />
      {cognitive.actionItemsEnabled && (
        <>
          <Toggle
            label="Auto-scan on change"
            value={cognitive.actionItemsAutoScan}
            onChange={(v) => onChange({ actionItemsAutoScan: v })}
          />
          <Slider
            label="Min Confidence"
            value={cognitive.actionItemsMinConfidence}
            min={0.1}
            max={0.9}
            step={0.1}
            onChange={(v) => onChange({ actionItemsMinConfidence: v })}
          />
        </>
      )}
    </>
  );
}

function MotorTab({
  motor,
  onChange,
  isLocked,
}: {
  motor: MotorProfile;
  onChange: (patch: Partial<MotorProfile>) => void;
  isLocked: (key: string) => boolean;
}) {
  const [showLibrary, setShowLibrary] = useState(false);
  return (
    <>
      <Toggle
        label="Voice Navigation"
        value={motor.voiceNavigationEnabled}
        onChange={(v) => {
          onChange({ voiceNavigationEnabled: v });
          toggleFeature('voice-nav', v);
        }}
        locked={isLocked('motor.voiceNavigationEnabled')}
      />
      {/* --- Session 17: Voice Tier Selection --- */}
      <VoiceTierPanel motor={motor} onChange={onChange} />
      <Toggle
        label="Eye Tracking"
        value={motor.eyeTrackingEnabled}
        onChange={(v) => {
          onChange({ eyeTrackingEnabled: v });
          toggleFeature('eye-tracking', v);
        }}
        locked={isLocked('motor.eyeTrackingEnabled')}
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
        locked={isLocked('motor.keyboardOnlyMode')}
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
        locked={isLocked('motor.predictiveInput')}
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
        locked={isLocked('motor.dwellClickEnabled')}
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

      {/* --- Task C: Gesture Shortcuts --- */}
      <div
        className="bg-a11y-surface rounded-lg p-3 border border-a11y-primary/20"
        style={{ borderLeft: '4px solid #7b68ee', marginTop: 8 }}
      >
        <div
          className="text-xs font-bold uppercase mb-2"
          style={{ color: '#bb86fc', letterSpacing: '1.2px' }}
        >
          Gesture Shortcuts
        </div>
        <Toggle
          label="Enable gesture shortcuts"
          value={motor.gestureShortcutsEnabled}
          onChange={(v) => onChange({ gestureShortcutsEnabled: v })}
          locked={isLocked('motor.gestureShortcutsEnabled')}
        />
        {motor.gestureShortcutsEnabled && (
          <>
            <Toggle
              label="Show hints on gesture"
              value={motor.gestureShowHints}
              onChange={(v) => onChange({ gestureShowHints: v })}
            />
            <Toggle
              label="Require Shift for mouse gestures"
              value={motor.gestureMouseModeRequiresShift}
              onChange={(v) => onChange({ gestureMouseModeRequiresShift: v })}
            />
            <p className="text-xs text-a11y-muted mt-2" style={{ lineHeight: 1.5 }}>
              Swipe, circle, or tap with touch / trackpad / mouse. Press <kbd>?</kbd> on
              any page to see all gestures.
            </p>
            <button
              onClick={() => setShowLibrary(true)}
              className="w-full mt-3 text-sm py-2 rounded transition-colors"
              style={{
                background: 'linear-gradient(135deg, #7b68ee, #bb86fc)',
                color: '#fff',
                border: 'none',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              View Gesture Library
            </button>
          </>
        )}
      </div>
      {showLibrary && <GestureLibrary onClose={() => setShowLibrary(false)} />}
    </>
  );
}

// --- Session 17: Voice Tier Selection ---
function VoiceTierPanel({
  motor,
  onChange,
}: {
  motor: MotorProfile;
  onChange: (patch: Partial<MotorProfile>) => void;
}) {
  const [tierState, setTierState] = useState<string>('idle');
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    chrome.runtime
      .sendMessage({ type: 'ONNX_GET_STATUS' })
      .then((res) => {
        const r = res as {
          tiers?: Record<number, { state: string; progress: number; error: string | null }>;
        } | undefined;
        const t3 = r?.tiers?.[3];
        if (t3) {
          setTierState(t3.state);
          setProgress(t3.progress);
          setError(t3.error);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshStatus();
    const id = window.setInterval(refreshStatus, 1000);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  const download = () => {
    setError(null);
    chrome.runtime.sendMessage({ type: 'ONNX_LOAD_TIER', payload: { tier: 3 } }).catch(() => {});
    onChange({ indicWhisperEnabled: true });
  };

  const statusLabel =
    tierState === 'loaded'
      ? 'Ready'
      : tierState === 'loading'
        ? `Downloading ${progress}%`
        : tierState === 'failed'
          ? 'Failed'
          : 'Not loaded';

  const tierBadgeColor =
    tierState === 'loaded' ? '#10b981' : tierState === 'loading' ? '#f59e0b' : '#94a3b8';

  return (
    <div
      className="bg-a11y-surface rounded-lg p-3 border border-a11y-primary/20"
      style={{ borderLeft: '4px solid #7b68ee', marginTop: 8 }}
    >
      <div
        className="text-xs font-bold uppercase mb-2"
        style={{ color: '#bb86fc', letterSpacing: '1.2px' }}
      >
        Voice Quality Tier
      </div>

      <label style={{ display: 'block', fontSize: 13, color: '#e2e8f0', marginBottom: 4 }}>
        Strategy
      </label>
      <select
        value={motor.voiceQualityTier}
        onChange={(e) =>
          onChange({
            voiceQualityTier: e.target.value as MotorProfile['voiceQualityTier'],
          })
        }
        style={{
          width: '100%',
          padding: '6px 8px',
          borderRadius: 8,
          border: '1px solid rgba(123, 104, 238, 0.35)',
          background: '#1a1a2e',
          color: '#e2e8f0',
          fontSize: 13,
        }}
      >
        <option value="auto">Auto — native first, ONNX on gap</option>
        <option value="native">Native only (Web Speech)</option>
        <option value="onnx">ONNX only (IndicWhisper)</option>
        <option value="cloud-allowed">Allow cloud fallback</option>
      </select>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 10,
          fontSize: 12,
          color: '#94a3b8',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: tierBadgeColor,
            display: 'inline-block',
          }}
        />
        <span>IndicWhisper: {statusLabel}</span>
      </div>

      {tierState !== 'loaded' && (
        <button
          onClick={download}
          disabled={tierState === 'loading'}
          className="w-full mt-2 text-sm py-2 rounded transition-colors"
          style={{
            background: 'linear-gradient(135deg, #7b68ee, #bb86fc)',
            color: '#fff',
            border: 'none',
            fontWeight: 600,
            cursor: tierState === 'loading' ? 'wait' : 'pointer',
            opacity: tierState === 'loading' ? 0.6 : 1,
          }}
        >
          {tierState === 'loading' ? `Downloading ${progress}%` : 'Download IndicWhisper'}
        </button>
      )}
      {/*
        Session 17 security note: the registry currently has sha256:null
        for IndicWhisper — any MITM on the HTTP CDN could swap a malicious
        ONNX. Disable downloads until the real hash is pinned (landed via
        compute-hashes.sh after upload). This gate clears once the registry
        ships a real hash in a follow-up commit.
      */}
      <p
        style={{
          color: '#f59e0b',
          fontSize: 11,
          lineHeight: 1.5,
          marginTop: 6,
        }}
      >
        Integrity-pending: the model's SHA-256 is null until the first
        upload + hash run. Avoid downloading on this build.
      </p>

      {error && (
        <p style={{ color: '#ef4444', fontSize: 11, marginTop: 6 }}>{error}</p>
      )}

      <p
        style={{
          color: '#94a3b8',
          fontSize: 11,
          lineHeight: 1.5,
          marginTop: 6,
        }}
      >
        ~80 MB one-time download. Enables STT for all 22 Indian languages on-device.
        Decoder loop ships in Session 18 — current build exercises download + tier
        selection UX only.
      </p>
    </div>
  );
}

// --- Session 16: ZK attestation storage types for popup ---
interface ObservatoryRingCache {
  version: number;
  pubKeys: string[];
  ringHash: string;
  fetchedAt: number;
}
interface ObservatoryLastAttestation {
  date: string;
  valid: boolean;
  reason?: string;
}

function abbrevKey(hex: string): string {
  if (hex.length < 8) return hex;
  return `${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function SettingsTab({
  profile,
  onSave,
  onExport,
  onImport,
  onCheckUpdate,
  checkingUpdate,
  updateInfo,
  isLocked,
}: {
  profile: AccessibilityProfile;
  onSave: (p: AccessibilityProfile) => void;
  onExport: () => void;
  onImport: () => void;
  onCheckUpdate: () => void;
  checkingUpdate: boolean;
  updateInfo: UpdateInfo | null;
  isLocked: (key: string) => boolean;
}) {
  const [lastPublish, setLastPublish] = useState<number | null>(null);
  const [daysContributed, setDaysContributed] = useState<number>(0);

  // --- Session 16: ZK attestation state ---
  const [devicePubkey, setDevicePubkey] = useState<string>('');
  const [ringCache, setRingCache] = useState<ObservatoryRingCache | null>(null);
  const [lastAttestation, setLastAttestation] = useState<ObservatoryLastAttestation | null>(null);
  const [rotatingKey, setRotatingKey] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);

  const loadObservatoryState = () => {
    chrome.storage.local
      .get([
        'observatory_last_publish',
        'observatory_days_contributed',
        'observatory_device_pubkey',
        'observatory_ring_cache',
        'observatory_last_attestation',
      ])
      .then((res) => {
        setLastPublish((res.observatory_last_publish as number) ?? null);
        setDaysContributed((res.observatory_days_contributed as number) ?? 0);
        setDevicePubkey((res.observatory_device_pubkey as string) ?? '');
        const rc = res.observatory_ring_cache;
        setRingCache(rc && typeof rc === 'object' ? (rc as ObservatoryRingCache) : null);
        const la = res.observatory_last_attestation;
        setLastAttestation(la && typeof la === 'object' ? (la as ObservatoryLastAttestation) : null);
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadObservatoryState();
    // Poll every 10 s for live attestation status
    const iv = setInterval(loadObservatoryState, 10_000);
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.shareAnonymousMetrics]);

  const formatLastPublish = (ts: number | null): string => {
    if (!ts) return 'Never';
    const hoursAgo = Math.floor((Date.now() - ts) / 3_600_000);
    if (hoursAgo < 1) return 'Under an hour ago';
    if (hoursAgo < 48) return `${hoursAgo} h ago`;
    return `${Math.floor(hoursAgo / 24)} d ago`;
  };

  // Derive enrollment status: profile flag + pubkey present + pubkey in ring
  const isEnrolled =
    profile.observatoryEnrolled === true &&
    devicePubkey.length === 64 &&
    (ringCache?.pubKeys ?? []).includes(devicePubkey);

  const handleRotateKey = async () => {
    setShowRotateConfirm(false);
    setRotatingKey(true);
    try {
      await chrome.runtime.sendMessage({ type: 'OBSERVATORY_ROTATE_KEY' });
      loadObservatoryState();
    } catch {
      // ignore
    } finally {
      setRotatingKey(false);
    }
  };

  const handleCopyVerifierUrl = () => {
    const today = todayISO();
    const url = `http://72.61.227.64:8300/observatory/verifier?date=${today}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    }).catch(() => {});
  };

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

      {/* Anonymous Metrics (Opt-in) — Compliance Observatory */}
      <div
        className="bg-a11y-surface rounded-lg p-3 border border-a11y-primary/20"
        style={{ borderLeft: '4px solid #7b68ee' }}
      >
        <div className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: '#bb86fc', letterSpacing: '1.2px' }}>
          Anonymous Metrics (Opt-in)
        </div>
        <Toggle
          label="Share anonymous accessibility metrics"
          value={profile.shareAnonymousMetrics}
          onChange={(v) =>
            onSave({ ...profile, shareAnonymousMetrics: v, updatedAt: Date.now() })
          }
        />
        <p className="text-xs text-a11y-muted mt-2" style={{ lineHeight: 1.5 }}>
          Sharing uses differential privacy (Laplace noise, ε = 1.0). Your identity,
          content, and browsing history are never collected.
        </p>
        {profile.shareAnonymousMetrics && (
          <>
            <div className="mt-3 space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-a11y-muted">Last publish</span>
                <span className="text-a11y-text font-mono">{formatLastPublish(lastPublish)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-a11y-muted">Days contributed</span>
                <span className="text-a11y-text font-mono">{daysContributed}</span>
              </div>
            </div>

            {/* --- Session 16: ZK Attestation detail panel --- */}
            <div
              className="mt-3 rounded-lg p-3 space-y-2"
              style={{
                background: '#0a0a1a',
                border: '1px solid rgba(123,104,238,0.18)',
              }}
            >
              {/* Enrollment status */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-a11y-muted">Status</span>
                <span className="flex items-center gap-1.5 text-xs font-semibold">
                  <span
                    className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: isEnrolled ? '#10b981' : '#94a3b8' }}
                    aria-hidden="true"
                  />
                  <span style={{ color: isEnrolled ? '#10b981' : '#94a3b8' }}>
                    {isEnrolled ? 'Enrolled' : 'Not enrolled'}
                  </span>
                </span>
              </div>

              {/* Device key (abbreviated) */}
              {devicePubkey && (
                <div className="space-y-0.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-a11y-muted">Device key</span>
                    <span
                      className="text-xs font-mono"
                      style={{ color: '#bb86fc' }}
                      title={devicePubkey}
                    >
                      {abbrevKey(devicePubkey)}
                    </span>
                  </div>
                  <p className="text-xs" style={{ color: '#94a3b8', lineHeight: 1.4 }}>
                    Your ring membership fingerprint — share with an auditor to verify your attestation was included.
                  </p>
                </div>
              )}

              {/* Ring size */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-a11y-muted">Ring size</span>
                <span className="text-xs font-mono" style={{ color: '#e2e8f0' }}>
                  {ringCache ? ringCache.pubKeys.length : '—'}
                </span>
              </div>

              {/* Last attestation */}
              {lastAttestation && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-a11y-muted">Last attestation</span>
                  <span className="flex items-center gap-1 text-xs">
                    <span style={{ color: '#e2e8f0' }}>{lastAttestation.date}</span>
                    {lastAttestation.valid ? (
                      <svg
                        width="14" height="14" viewBox="0 0 24 24"
                        fill="none" stroke="#10b981" strokeWidth="2.5"
                        strokeLinecap="round" strokeLinejoin="round"
                        aria-label="Valid"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <span
                        title={lastAttestation.reason ?? 'Invalid attestation'}
                        style={{ cursor: 'help' }}
                      >
                        <svg
                          width="14" height="14" viewBox="0 0 24 24"
                          fill="none" stroke="#ef4444" strokeWidth="2.5"
                          strokeLinecap="round" strokeLinejoin="round"
                          aria-label={`Invalid: ${lastAttestation.reason ?? 'unknown reason'}`}
                        >
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </span>
                    )}
                  </span>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2 pt-1">
                {/* Rotate device key */}
                {!showRotateConfirm ? (
                  <button
                    onClick={() => setShowRotateConfirm(true)}
                    disabled={rotatingKey}
                    className="flex items-center gap-1 text-xs px-2 py-1.5 rounded transition-colors disabled:opacity-50"
                    style={{
                      background: 'rgba(123,104,238,0.12)',
                      color: '#bb86fc',
                      border: '1px solid rgba(123,104,238,0.3)',
                      cursor: rotatingKey ? 'not-allowed' : 'pointer',
                    }}
                    aria-label="Rotate device key"
                  >
                    <svg
                      width="14" height="14" viewBox="0 0 24 24"
                      fill="none" stroke="currentColor" strokeWidth="2.5"
                      strokeLinecap="round" strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                    {rotatingKey ? 'Rotating…' : 'Rotate key'}
                  </button>
                ) : (
                  <div className="flex items-center gap-2 text-xs" style={{ color: '#e2e8f0' }}>
                    <span style={{ color: '#f59e0b' }}>Rotating invalidates today's attestation. Continue?</span>
                    <button
                      onClick={() => void handleRotateKey()}
                      className="px-2 py-1 rounded text-xs"
                      style={{ background: '#ef4444', color: '#fff', border: 'none', cursor: 'pointer' }}
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setShowRotateConfirm(false)}
                      className="px-2 py-1 rounded text-xs"
                      style={{ background: 'rgba(255,255,255,0.08)', color: '#94a3b8', border: 'none', cursor: 'pointer' }}
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {/* Copy verification URL */}
                <button
                  onClick={handleCopyVerifierUrl}
                  className="flex items-center gap-1 text-xs px-2 py-1.5 rounded transition-colors"
                  style={{
                    background: 'rgba(123,104,238,0.12)',
                    color: copiedUrl ? '#10b981' : '#bb86fc',
                    border: `1px solid ${copiedUrl ? 'rgba(16,185,129,0.4)' : 'rgba(123,104,238,0.3)'}`,
                    cursor: 'pointer',
                  }}
                  aria-label="Copy verification URL"
                >
                  {copiedUrl ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                  {copiedUrl ? 'Copied!' : 'Copy verify URL'}
                </button>
              </div>
            </div>
          </>
        )}
        <a
          href="http://72.61.227.64:8300/observatory/"
          target="_blank"
          rel="noopener noreferrer"
          className="block text-center mt-3 text-xs"
          style={{
            padding: '8px 12px',
            borderRadius: '8px',
            background: 'rgba(123, 104, 238, 0.15)',
            color: '#bb86fc',
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          View Organization Dashboard →
        </a>
      </div>

      {/* --- Session 11: Multi-Modal Fusion --- */}
      <FusionSection profile={profile} onSave={onSave} isLocked={isLocked} />

      {/* --- Session 12: On-Device ONNX Models --- */}
      <OnnxModelsSection profile={profile} onSave={onSave} />

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
          <optgroup label="English">
            <option value="en">English</option>
          </optgroup>
          <optgroup label="Indian Languages">
            <option value="hi">Hindi (हिन्दी)</option>
            <option value="bn">Bengali (বাংলা)</option>
            <option value="ur">Urdu (اردو)</option>
            <option value="pa">Punjabi (ਪੰਜਾਬੀ)</option>
            <option value="mr">Marathi (मराठी)</option>
            <option value="te">Telugu (తెలుగు)</option>
            <option value="ta">Tamil (தமிழ்)</option>
            <option value="gu">Gujarati (ગુજરાતી)</option>
            <option value="kn">Kannada (ಕನ್ನಡ)</option>
            <option value="ml">Malayalam (മലയാളം)</option>
            {/* 12 new languages (Priority 2) — text mode except as */}
            <option value="mai">Maithili (मैथिली) · text mode</option>
            <option value="sd">Sindhi (سنڌي) · text mode</option>
            <option value="ne">Nepali (नेपाली) · text mode</option>
            <option value="as">Assamese (অসমীয়া)</option>
            <option value="sat">Santali (ᱥᱟᱱᱛᱟᱲᱤ) · text mode</option>
            <option value="ks">Kashmiri (کٲشُر) · text mode</option>
            <option value="doi">Dogri (डोगरी) · text mode</option>
            <option value="kok">Konkani (कोंकणी) · text mode</option>
            <option value="mni">Manipuri (মৈতৈলোন্) · text mode</option>
            <option value="brx">Bodo (बड़ो) · text mode</option>
            <option value="sa">Sanskrit (संस्कृत) · text mode</option>
          </optgroup>
          <optgroup label="Global Languages">
            <option value="zh">Chinese (中文)</option>
            <option value="es">Spanish (Español)</option>
            <option value="pt">Portuguese (Português)</option>
            <option value="ru">Russian (Русский)</option>
            <option value="fr">French (Français)</option>
            <option value="ar">Arabic (العربية)</option>
            <option value="id">Indonesian (Bahasa Indonesia)</option>
            <option value="de">German (Deutsch)</option>
            <option value="ja">Japanese (日本語)</option>
            <option value="tr">Turkish (Türkçe)</option>
            <option value="vi">Vietnamese (Tiếng Việt)</option>
            <option value="ko">Korean (한국어)</option>
            <option value="tl">Filipino</option>
            <option value="fa">Persian (فارسی)</option>
            <option value="it">Italian (Italiano)</option>
            <option value="th">Thai (ภาษาไทย)</option>
            <option value="pl">Polish (Polski)</option>
          </optgroup>
        </select>
      </div>
      <Toggle
        label="Auto-detect page language"
        value={profile.autoDetectLanguage}
        onChange={(v) => onSave({ ...profile, autoDetectLanguage: v, updatedAt: Date.now() })}
      />
      <Toggle
        label="Enable transliteration (Alt+T)"
        value={profile.transliterationEnabled}
        onChange={(v) => onSave({ ...profile, transliterationEnabled: v, updatedAt: Date.now() })}
      />
      {profile.transliterationEnabled && (
        <div className="space-y-1">
          <label className="text-xs text-a11y-muted">Transliteration Script</label>
          <select
            className="w-full bg-a11y-surface text-a11y-text border border-a11y-primary/30 rounded px-2 py-1.5 text-sm"
            value={profile.transliterationScript}
            onChange={(e) =>
              onSave({
                ...profile,
                transliterationScript: e.target.value as AccessibilityProfile['transliterationScript'],
                updatedAt: Date.now(),
              })
            }
          >
            <option value="devanagari">Devanagari (Hindi / Marathi)</option>
            <option value="tamil">Tamil</option>
            <option value="telugu">Telugu</option>
            <option value="kannada">Kannada</option>
          </select>
        </div>
      )}
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

// --- Session 11: Multi-Modal Fusion ---

interface FusionStatsResponse {
  running: boolean;
  stats?: {
    totalIngested: number;
    eventsPerSec: number;
    activeChannels: number;
    dominantChannel: string | null;
    degradedChannels: string[];
    lastIntent: { intent: string; confidence: number } | null;
  };
  environmentConditions?: { lighting: string; noise: string; network: string; timeOfDay: string } | null;
  activeRules?: string[];
}

function FusionSection({
  profile,
  onSave,
  isLocked,
}: {
  profile: AccessibilityProfile;
  onSave: (p: AccessibilityProfile) => void;
  isLocked: (key: string) => boolean;
}) {
  const [stats, setStats] = useState<FusionStatsResponse | null>(null);

  useEffect(() => {
    if (!profile.fusionEnabled) {
      setStats(null);
      return;
    }
    let cancelled = false;
    const poll = () => {
      chrome.runtime
        .sendMessage({ type: 'FUSION_GET_STATS' })
        .then((r: unknown) => {
          if (!cancelled) setStats(r as FusionStatsResponse);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [profile.fusionEnabled]);

  const update = (patch: Partial<AccessibilityProfile>) =>
    onSave({ ...profile, ...patch, updatedAt: Date.now() });

  return (
    <div
      className="bg-a11y-surface rounded-lg p-3 border border-a11y-primary/20"
      style={{ borderLeft: '4px solid #7b68ee' }}
    >
      <div
        className="text-xs font-bold uppercase tracking-wider mb-2"
        style={{ color: '#bb86fc', letterSpacing: '1.2px' }}
      >
        Multi-Modal Fusion (Layer 5)
      </div>
      <p className="text-xs text-a11y-muted mb-3" style={{ lineHeight: 1.5 }}>
        Unifies keyboard · mouse · gaze · voice · environment into one event
        stream. Detects intent (reading, hesitation, abandoning…) and boosts
        the most reliable channel when another is noisy.
      </p>
      <Toggle
        label="Enable fusion"
        value={profile.fusionEnabled}
        onChange={(v) => update({ fusionEnabled: v })}
        locked={isLocked('fusionEnabled')}
      />
      {profile.fusionEnabled && (
        <>
          <div className="mt-3">
            <label className="text-xs text-a11y-muted">
              Window size: {(profile.fusionWindowMs / 1000).toFixed(1)}s
            </label>
            <input
              type="range"
              min={1000}
              max={10000}
              step={500}
              value={profile.fusionWindowMs}
              onChange={(e) => update({ fusionWindowMs: parseInt(e.target.value, 10) })}
              className="w-full"
            />
          </div>
          <Toggle
            label="Cross-modal compensation"
            value={profile.fusionCompensationEnabled}
            onChange={(v) => update({ fusionCompensationEnabled: v })}
          />
          <Slider
            label="Intent confidence threshold"
            value={profile.fusionIntentMinConfidence}
            min={0.3}
            max={0.9}
            step={0.05}
            onChange={(v) => update({ fusionIntentMinConfidence: v })}
          />

          {/* Live stats */}
          {stats?.running && stats.stats && (
            <div className="mt-3 space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-a11y-muted">Active channels</span>
                <span className="text-a11y-text font-mono">{stats.stats.activeChannels}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-a11y-muted">Dominant</span>
                <span className="text-a11y-text font-mono">
                  {stats.stats.dominantChannel ?? '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-a11y-muted">Degraded</span>
                <span className="text-a11y-text font-mono">
                  {stats.stats.degradedChannels.length > 0
                    ? stats.stats.degradedChannels.join(', ')
                    : 'none'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-a11y-muted">Events/sec</span>
                <span className="text-a11y-text font-mono">{stats.stats.eventsPerSec}</span>
              </div>
              {stats.stats.lastIntent && (
                <div className="flex justify-between">
                  <span className="text-a11y-muted">Last intent</span>
                  <span className="text-a11y-text font-mono">
                    {stats.stats.lastIntent.intent} · {(stats.stats.lastIntent.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              )}
            </div>
          )}
          {stats && !stats.running && (
            <div className="mt-3 text-xs text-a11y-muted">
              Fusion not running on this tab. Reload the page to activate.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- Session 12: On-Device ONNX Models ---

type OnnxTierId = 0 | 1 | 2;

interface OnnxTierSnapshot {
  state: 'idle' | 'loading' | 'loaded' | 'failed';
  progress: number;
  error: string | null;
  label: string;
  sizeBytes: number;
}

interface OnnxStatusResponse {
  tiers: Record<OnnxTierId, OnnxTierSnapshot>;
  runtime: {
    modelsLoaded: string[];
    cacheBytes: number;
    inferenceCount: Record<string, number>;
    avgLatencyMs: Record<string, number>;
    fallbackCount: number;
  };
  forceFallback: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function OnnxModelsSection({
  profile,
  onSave,
}: {
  profile: AccessibilityProfile;
  onSave: (p: AccessibilityProfile) => void;
}) {
  const [status, setStatus] = useState<OnnxStatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      chrome.runtime
        .sendMessage({ type: 'ONNX_GET_STATUS' })
        .then((r: unknown) => {
          if (!cancelled) setStatus(r as OnnxStatusResponse);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const update = (patch: Partial<AccessibilityProfile>) =>
    onSave({ ...profile, ...patch, updatedAt: Date.now() });

  const loadTier = (tier: OnnxTierId) =>
    chrome.runtime.sendMessage({ type: 'ONNX_LOAD_TIER', payload: { tier } }).catch(() => {});

  const unloadTier = (tier: OnnxTierId) =>
    chrome.runtime.sendMessage({ type: 'ONNX_UNLOAD_TIER', payload: { tier } }).catch(() => {});

  const clearCache = () =>
    chrome.runtime.sendMessage({ type: 'ONNX_CLEAR_CACHE' }).catch(() => {});

  const tierRow = (tier: OnnxTierId, enabledKey: 'struggleClassifier' | 'embeddings' | 'summarizer') => {
    const snap = status?.tiers[tier];
    const enabled = profile.onnxModelsEnabled[enabledKey];
    const stateLabel =
      snap?.state === 'loaded' ? 'loaded'
      : snap?.state === 'loading' ? `${snap.progress}%`
      : snap?.state === 'failed' ? 'failed'
      : 'not loaded';
    return (
      <div key={tier} className="mt-3 pt-3 border-t border-a11y-primary/20">
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-a11y-text truncate">
              Tier {tier} · {snap?.label ?? `Tier ${tier}`}
            </div>
            <div className="text-xs text-a11y-muted">
              {formatBytes(snap?.sizeBytes ?? 0)} · {stateLabel}
            </div>
          </div>
          <Toggle
            label=""
            value={enabled}
            onChange={(v) =>
              update({
                onnxModelsEnabled: {
                  ...profile.onnxModelsEnabled,
                  [enabledKey]: v,
                },
              })
            }
          />
        </div>
        {snap?.state === 'loading' && (
          <div
            className="mt-2 h-1.5 rounded-full overflow-hidden"
            style={{ background: 'rgba(123, 104, 238, 0.18)' }}
          >
            <div
              className="h-full"
              style={{
                width: `${snap.progress}%`,
                background: 'linear-gradient(135deg, #7b68ee, #bb86fc)',
                transition: 'width 0.2s',
              }}
            />
          </div>
        )}
        {snap?.state === 'failed' && snap.error && (
          <div className="mt-1 text-xs" style={{ color: '#ef4444' }}>
            {snap.error.length > 80 ? snap.error.slice(0, 77) + '…' : snap.error}
          </div>
        )}
        {enabled && snap?.state !== 'loaded' && snap?.state !== 'loading' && (
          <button
            onClick={() => loadTier(tier)}
            className="mt-2 w-full text-xs py-1.5 rounded transition-colors"
            style={{
              background: 'rgba(123, 104, 238, 0.15)',
              color: '#bb86fc',
              fontWeight: 600,
            }}
          >
            Download
          </button>
        )}
        {snap?.state === 'loaded' && (
          <button
            onClick={() => unloadTier(tier)}
            className="mt-2 w-full text-xs py-1.5 rounded transition-colors text-a11y-muted border border-a11y-primary/30"
          >
            Unload
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      className="bg-a11y-surface rounded-lg p-3 border border-a11y-primary/20"
      style={{ borderLeft: '4px solid #7b68ee' }}
    >
      <div
        className="text-xs font-bold uppercase tracking-wider mb-2"
        style={{ color: '#bb86fc', letterSpacing: '1.2px' }}
      >
        On-Device AI Models
      </div>
      <p className="text-xs text-a11y-muted mb-3" style={{ lineHeight: 1.5 }}>
        Three on-device ONNX models. Tier 0 is always on; 1 and 2 are opt-in
        downloads. Heuristic fallback runs automatically when a model is
        unavailable or disabled.
      </p>

      {tierRow(0, 'struggleClassifier')}
      {tierRow(1, 'embeddings')}
      {tierRow(2, 'summarizer')}

      <div className="mt-4 pt-3 border-t border-a11y-primary/20">
        <Toggle
          label="Allow downloads on metered network"
          value={profile.onnxDownloadOnMeteredNetwork}
          onChange={(v) => update({ onnxDownloadOnMeteredNetwork: v })}
        />
      </div>

      {status && (
        <div className="mt-3 space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-a11y-muted">Cache size</span>
            <span className="text-a11y-text font-mono">
              {formatBytes(status.runtime.cacheBytes)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-a11y-muted">Fallbacks</span>
            <span className="text-a11y-text font-mono">
              {status.runtime.fallbackCount}
            </span>
          </div>
          {status.runtime.modelsLoaded.length > 0 && (
            <div className="flex justify-between">
              <span className="text-a11y-muted">Loaded</span>
              <span className="text-a11y-text font-mono">
                {status.runtime.modelsLoaded.length}
              </span>
            </div>
          )}
        </div>
      )}

      <button
        onClick={clearCache}
        className="mt-3 w-full text-xs py-1.5 rounded border border-a11y-primary/30 text-a11y-muted hover:text-a11y-text transition-colors"
      >
        Clear Cache
      </button>
    </div>
  );
}
