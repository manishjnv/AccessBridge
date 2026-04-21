/**
 * VisionLabPanel — Session 23
 * Curation UI for the Vision Lab: scan the page, review AI-generated labels
 * (before / after), accept / reject / edit, and export curations.
 *
 * Communicates with the background service worker via chrome.runtime.sendMessage.
 * Background handlers (VISION_LAB_SCAN, VISION_CURATION_SAVE, VISION_CURATION_LIST,
 * VISION_CURATION_EXPORT) are wired separately by Opus.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './VisionLabPanel.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UnlabeledElement {
  nodeHint: string;
  role?: string;
  tagName?: string;
  xpath?: string;
}

export interface ScanResult {
  id: string;
  element: UnlabeledElement;
  /** Base-64 data URL of the element screenshot. */
  thumbnail: string;
  before: { currentLabel: string | null };
  after: {
    tier: 1 | 2 | 3;
    label: string;
    confidence: number;
    source: string;
  };
}

export interface Curation {
  id: string;
  status: 'accepted' | 'rejected' | 'edited';
  editedLabel?: string;
}

type CurationStatus = 'accepted' | 'rejected' | 'edited';

interface VisionLabPanelProps {
  onScan?: () => void;
  onAccept?: (label: string) => void;
  onReject?: (label: string) => void;
  onEdit?: (label: string, newText: string) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendMsg<T>(type: string, payload?: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage({ type, ...(payload ?? {}) }) as Promise<T>;
}

function tierLabel(tier: 1 | 2 | 3): string {
  return tier === 1 ? 'T1' : tier === 2 ? 'T2' : 'T3';
}

function tierTitle(tier: 1 | 2 | 3): string {
  return tier === 1 ? 'Heuristic' : tier === 2 ? 'API' : 'On-device VLM';
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TierBadge({ tier }: { tier: 1 | 2 | 3 }) {
  const cls = tier === 1 ? styles.tierT1 : tier === 2 ? styles.tierT2 : styles.tierT3;
  return (
    <span className={`${styles.tierBadge} ${cls}`} title={tierTitle(tier)}>
      {tierLabel(tier)}
    </span>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  const color = pct >= 70 ? 'var(--ab-success, #10b981)' : pct >= 40 ? 'var(--ab-warning, #f59e0b)' : 'var(--ab-danger, #ef4444)';
  return (
    <div className={styles.confBarTrack} aria-label={`Confidence ${pct}%`}>
      <div className={styles.confBarFill} style={{ width: pct + '%', background: color }} />
    </div>
  );
}

interface ResultCardProps {
  result: ScanResult;
  curation: CurationStatus | null;
  onAccept: () => void;
  onReject: () => void;
  onEdit: (newText: string) => void;
}

function ResultCard({ result, curation, onAccept, onReject, onEdit }: ResultCardProps) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(result.after.label);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleEditStart = useCallback(() => {
    setEditVal(result.after.label);
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [result.after.label]);

  const handleEditCommit = useCallback(() => {
    if (editVal.trim()) {
      onEdit(editVal.trim());
    }
    setEditing(false);
  }, [editVal, onEdit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleEditCommit();
      if (e.key === 'Escape') setEditing(false);
    },
    [handleEditCommit],
  );

  const borderColor =
    curation === 'accepted' ? 'var(--ab-success, #10b981)' :
    curation === 'rejected' ? 'var(--ab-danger, #ef4444)' :
    curation === 'edited'   ? 'var(--ab-warning, #f59e0b)' :
    'var(--ab-primary, #7b68ee)';

  return (
    <article className={styles.resultCard} style={{ borderLeftColor: borderColor }}>
      <div className={styles.cardTop}>
        {/* Thumbnail */}
        <div className={styles.thumbWrap}>
          {result.thumbnail ? (
            <img
              src={result.thumbnail}
              alt={`Thumbnail for ${result.element.nodeHint}`}
              className={styles.thumb}
              width={80}
              height={80}
            />
          ) : (
            <div className={styles.thumbPlaceholder} aria-hidden="true">
              <span>?</span>
            </div>
          )}
        </div>

        {/* Before / After */}
        <div className={styles.labels}>
          <div className={styles.labelRow}>
            <span className={styles.labelTag}>Before</span>
            <span className={styles.labelBefore}>
              {result.before.currentLabel ?? <em className={styles.noLabel}>unlabeled</em>}
            </span>
          </div>
          <div className={styles.labelRow}>
            <span className={styles.labelTag}>After</span>
            {editing ? (
              <input
                ref={inputRef}
                className={styles.editInput}
                value={editVal}
                onChange={(e) => setEditVal(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleEditCommit}
                aria-label="Edit label"
              />
            ) : (
              <span className={styles.labelAfter}>{result.after.label}</span>
            )}
          </div>
          <div className={styles.metaRow}>
            <TierBadge tier={result.after.tier} />
            <span className={styles.sourceChip}>{result.after.source}</span>
            <ConfidenceBar value={result.after.confidence} />
            <span className={styles.confPct}>{Math.round(result.after.confidence * 100)}%</span>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.actionBtn} ${styles.acceptBtn} ${curation === 'accepted' ? styles.actionActive : ''}`}
          onClick={onAccept}
          aria-label="Accept label"
        >
          Accept
        </button>
        <button
          type="button"
          className={`${styles.actionBtn} ${styles.rejectBtn} ${curation === 'rejected' ? styles.actionActive : ''}`}
          onClick={onReject}
          aria-label="Reject label"
        >
          Reject
        </button>
        <button
          type="button"
          className={`${styles.actionBtn} ${styles.editBtn} ${curation === 'edited' ? styles.actionActive : ''}`}
          onClick={handleEditStart}
          aria-label="Edit label"
        >
          Edit
        </button>
        {curation && (
          <span className={styles.statusPill} style={{ borderColor }}>
            {curation}
          </span>
        )}
      </div>
    </article>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function VisionLabPanel({
  onScan,
  onAccept,
  onReject,
  onEdit,
}: VisionLabPanelProps): JSX.Element {
  const [results, setResults] = useState<ScanResult[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0); // 0–100
  const [progressLabel, setProgressLabel] = useState('');
  const [curations, setCurations] = useState<Record<string, CurationStatus>>({});
  const [error, setError] = useState<string | null>(null);

  // Restore curations from background on mount
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime) return;
    sendMsg<{ curations?: Curation[] }>('VISION_CURATION_LIST')
      .then((resp) => {
        if (resp?.curations) {
          const map: Record<string, CurationStatus> = {};
          resp.curations.forEach((c) => { map[c.id] = c.status; });
          setCurations(map);
        }
      })
      .catch(() => {});
  }, []);

  const handleScan = useCallback(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime) return;
    setScanning(true);
    setProgress(0);
    setProgressLabel('Starting scan…');
    setError(null);
    onScan?.();

    // Simulate per-element progress via a polling interval until response arrives
    let count = 0;
    const ticker = setInterval(() => {
      count += 3;
      if (count < 90) {
        setProgress(count);
        setProgressLabel(`Scanning… ${count}%`);
      }
    }, 120);

    sendMsg<{ ok: boolean; results?: ScanResult[]; error?: string }>('VISION_LAB_SCAN', {})
      .then((resp) => {
        clearInterval(ticker);
        setProgress(100);
        setProgressLabel('Done');
        if (resp?.ok && resp.results) {
          setResults(resp.results);
        } else {
          setError(resp?.error ?? 'Scan returned no results.');
        }
      })
      .catch((e: unknown) => {
        clearInterval(ticker);
        setError(String(e));
      })
      .finally(() => {
        setScanning(false);
        setTimeout(() => setProgress(0), 800);
      });
  }, [onScan]);

  const saveCuration = useCallback(
    (id: string, status: CurationStatus, editedLabel?: string) => {
      if (typeof chrome === 'undefined' || !chrome.runtime) return;
      setCurations((prev) => ({ ...prev, [id]: status }));
      sendMsg('VISION_CURATION_SAVE', {
        id,
        status,
        ...(editedLabel !== undefined ? { editedLabel } : {}),
      }).catch(() => {});
    },
    [],
  );

  const handleAccept = useCallback(
    (result: ScanResult) => {
      saveCuration(result.id, 'accepted');
      onAccept?.(result.after.label);
    },
    [saveCuration, onAccept],
  );

  const handleReject = useCallback(
    (result: ScanResult) => {
      saveCuration(result.id, 'rejected');
      onReject?.(result.after.label);
    },
    [saveCuration, onReject],
  );

  const handleEdit = useCallback(
    (result: ScanResult, newText: string) => {
      saveCuration(result.id, 'edited', newText);
      onEdit?.(result.after.label, newText);
    },
    [saveCuration, onEdit],
  );

  const handleExport = useCallback(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime) return;
    sendMsg('VISION_CURATION_EXPORT', {}).catch(() => {});
  }, []);

  const acceptedCount = Object.values(curations).filter((s) => s === 'accepted').length;
  const rejectedCount = Object.values(curations).filter((s) => s === 'rejected').length;
  const editedCount   = Object.values(curations).filter((s) => s === 'edited').length;

  return (
    <div className={styles.root}>
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <div className={styles.headerTitle}>
          <span className={styles.labBadge}>LAB</span>
          <h2 className={styles.title}>Vision Lab</h2>
          <span className={styles.featureBadge}>Feature #5-CUR</span>
        </div>
        <p className={styles.desc}>
          Scan the active page, review AI-generated element labels, curate, and export for training.
        </p>
      </div>

      {/* ── Scan button ─────────────────────────────────────────────────────── */}
      <button
        type="button"
        className={styles.scanBtn}
        onClick={handleScan}
        disabled={scanning}
        aria-busy={scanning}
      >
        {scanning ? 'Scanning…' : 'Scan page'}
      </button>

      {/* ── Progress bar ────────────────────────────────────────────────────── */}
      {scanning && progress > 0 && (
        <div className={styles.progressWrap} role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: progress + '%' }} />
          </div>
          <span className={styles.progressLabel}>{progressLabel}</span>
        </div>
      )}

      {/* ── Error ───────────────────────────────────────────────────────────── */}
      {error && (
        <div className={styles.errorBanner} role="alert">
          {error}
        </div>
      )}

      {/* ── Stats row ───────────────────────────────────────────────────────── */}
      {results.length > 0 && (
        <div className={styles.statsRow}>
          <span className={styles.statChip}>{results.length} found</span>
          <span className={styles.statChip} style={{ color: 'var(--ab-success, #10b981)' }}>{acceptedCount} accepted</span>
          <span className={styles.statChip} style={{ color: 'var(--ab-danger, #ef4444)' }}>{rejectedCount} rejected</span>
          <span className={styles.statChip} style={{ color: 'var(--ab-warning, #f59e0b)' }}>{editedCount} edited</span>
        </div>
      )}

      {/* ── Results grid ────────────────────────────────────────────────────── */}
      {results.length > 0 ? (
        <>
          <div className={styles.grid}>
            {results.map((r) => (
              <ResultCard
                key={r.id}
                result={r}
                curation={curations[r.id] ?? null}
                onAccept={() => handleAccept(r)}
                onReject={() => handleReject(r)}
                onEdit={(newText) => handleEdit(r, newText)}
              />
            ))}
          </div>

          {/* Export button */}
          <button
            type="button"
            className={styles.exportBtn}
            onClick={handleExport}
            aria-label="Export curations as JSON"
          >
            Export curations
          </button>
        </>
      ) : (
        !scanning && (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon} aria-hidden="true">🔬</span>
            <p>Click "Scan page" to find unlabeled elements on the active tab and review AI-generated labels.</p>
          </div>
        )
      )}
    </div>
  );
}
