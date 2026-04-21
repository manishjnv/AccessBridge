import React, { useCallback, useEffect, useState } from 'react';
import type { RecoveredLabel } from '@accessbridge/core';

interface VisionStats {
  hits: number;
  entries: number;
  sizeBytes: number;
}

export default function VisionPanel(): JSX.Element {
  const [results, setResults] = useState<RecoveredLabel[]>([]);
  const [stats, setStats] = useState<VisionStats>({ hits: 0, entries: 0, sizeBytes: 0 });
  const [scanning, setScanning] = useState(false);

  const scanNow = useCallback(() => {
    setScanning(true);
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.id) { setScanning(false); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'VISION_SCAN_NOW' })
        .then((resp: { count?: number; results?: RecoveredLabel[] } | undefined) => {
          setResults(resp?.results ?? []);
        })
        .catch(() => { /* ignore */ })
        .finally(() => setScanning(false));
    });
  }, []);

  const clearCache = useCallback(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.id) return;
      chrome.tabs.sendMessage(tab.id, { type: 'VISION_CLEAR_CACHE' }).catch(() => {});
      setResults([]);
      setStats({ hits: 0, entries: 0, sizeBytes: 0 });
    });
  }, []);

  const getStats = useCallback(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.id) return;
      chrome.tabs.sendMessage(tab.id, { type: 'VISION_GET_STATS' })
        .then((s: VisionStats | undefined) => {
          if (s) setStats(s);
        })
        .catch(() => {});
    });
  }, []);

  useEffect(() => { getStats(); }, [getStats]);

  const exportCsv = useCallback(() => {
    const header = 'NodeHint,Role,Label,Description,Confidence,Tier,Source\n';
    const esc = (v: string): string =>
      v.includes(',') || v.includes('"') ? '"' + v.replace(/"/g, '""') + '"' : v;
    const rows = results.map((r) => [
      esc(r.element.nodeHint),
      esc(r.inferredRole),
      esc(r.inferredLabel),
      esc(r.inferredDescription),
      r.confidence.toFixed(2),
      String(r.tier),
      r.source,
    ].join(','));
    const csv = header + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'accessbridge-recovered-labels.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, [results]);

  const avgConfidence = results.length === 0
    ? 0
    : results.reduce((s, r) => s + r.confidence, 0) / results.length;

  return (
    <div className="space-y-3">
      <div className="bg-a11y-surface rounded-lg p-3 border border-a11y-primary/20">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-a11y-accent">Vision Recovery</h2>
          <span className="text-[10px] uppercase tracking-wider text-a11y-muted">Feature #5</span>
        </div>
        <p className="text-xs text-a11y-muted mb-3">
          Auto-labels unlabeled UI elements via heuristic inference (Tier&nbsp;1, on-device) or opt-in AI vision (Tier&nbsp;2).
        </p>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-lg font-bold text-a11y-text">{results.length}</div>
            <div className="text-[10px] text-a11y-muted">Recovered</div>
          </div>
          <div>
            <div className="text-lg font-bold text-a11y-text">{Math.round(avgConfidence * 100)}%</div>
            <div className="text-[10px] text-a11y-muted">Avg&nbsp;Confidence</div>
          </div>
          <div>
            <div className="text-lg font-bold text-a11y-text">{Math.round(stats.sizeBytes / 1024)}&nbsp;KB</div>
            <div className="text-[10px] text-a11y-muted">Cache</div>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className="flex-1 bg-gradient-to-br from-a11y-primary to-a11y-accent text-white rounded-lg px-3 py-2 text-xs font-semibold"
          onClick={scanNow}
          disabled={scanning}
        >
          {scanning ? 'Scanning…' : 'Scan Current Page'}
        </button>
        <button
          type="button"
          className="bg-a11y-surface border border-a11y-primary/30 text-a11y-text rounded-lg px-3 py-2 text-xs"
          onClick={clearCache}
        >
          Clear Cache
        </button>
      </div>

      {results.length > 0 && (
        <>
          <button
            type="button"
            className="w-full bg-a11y-surface border border-a11y-primary/30 text-a11y-text rounded-lg px-3 py-2 text-xs"
            onClick={exportCsv}
          >
            Export CSV
          </button>
          <div className="space-y-2">
            {results.map((r, i) => (
              <div
                key={i}
                className="bg-a11y-surface rounded-lg p-2 border-l-4 border-a11y-primary/60"
              >
                <div className="text-[10px] text-a11y-muted">
                  {r.element.nodeHint} · Tier&nbsp;{r.tier}{r.source === 'cached' ? ' (cached)' : ''}
                </div>
                <div className="text-sm font-semibold text-a11y-text mt-1">{r.inferredLabel}</div>
                {r.inferredDescription.length > 0 && (
                  <div className="text-[11px] text-a11y-muted">{r.inferredDescription}</div>
                )}
                <div className="h-[3px] bg-black/20 rounded-full mt-2 overflow-hidden">
                  <div
                    className="h-full bg-green-400"
                    style={{ width: Math.round(r.confidence * 100) + '%' }}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {results.length === 0 && !scanning && (
        <p className="text-xs text-a11y-muted text-center py-4">
          Click&nbsp;"Scan Current Page" to find unlabeled elements on the active tab.
        </p>
      )}
    </div>
  );
}
