import React, { useCallback, useMemo, useState } from 'react';
import type {
  AuditFinding,
  AuditFindingSource,
  AuditInput,
  AuditReport,
  AuditSeverity,
  AxeResults,
  WCAGPrinciple,
} from '@accessbridge/core/audit';
import {
  AuditEngine,
  mapAxeViolationsToFindings,
  mergeAuditFindings,
  rebuildReportWithMergedFindings,
} from '@accessbridge/core/audit';
import { ScoreRing } from './ScoreRing.js';
import { WCAGBadge } from './WCAGBadge.js';
import { CategoryBar } from './CategoryBar.js';
import { FindingItem } from './FindingItem.js';
import { downloadAuditPDF } from './pdf-generator.js';

const SEVERITY_ORDER: AuditSeverity[] = ['critical', 'serious', 'moderate', 'minor', 'info'];
const PRINCIPLES: WCAGPrinciple[] = ['perceivable', 'operable', 'understandable', 'robust'];
const SOURCE_ORDER: AuditFindingSource[] = ['custom', 'axe', 'both'];

const engine = new AuditEngine();

type ScanState =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; report: AuditReport; axeError?: string };

export function AuditPanel() {
  const [state, setState] = useState<ScanState>({ kind: 'idle' });
  const [activeSeverities, setActiveSeverities] = useState<Set<AuditSeverity>>(
    new Set(SEVERITY_ORDER),
  );
  const [activeSources, setActiveSources] = useState<Set<AuditFindingSource>>(
    new Set(SOURCE_ORDER),
  );

  const runScan = useCallback(async () => {
    setState({ kind: 'scanning' });
    try {
      // 1. Custom engine: ask content script for serialized AuditInput, run in-panel.
      const scanResponse = await chrome.runtime.sendMessage({ type: 'AUDIT_SCAN_REQUEST' });
      if (!scanResponse) {
        setState({ kind: 'error', message: 'No response from background script.' });
        return;
      }
      if (typeof scanResponse === 'object' && 'error' in scanResponse) {
        setState({ kind: 'error', message: String((scanResponse as { error: string }).error) });
        return;
      }
      const input = (scanResponse as { input?: AuditInput }).input;
      if (!input) {
        setState({ kind: 'error', message: 'Audit collector returned no data.' });
        return;
      }
      const customReport = engine.runAudit(input);
      const customFindings = customReport.findings.map((f) => ({ ...f, source: 'custom' as const }));

      // 2. axe-core: run in parallel to the custom engine on the live DOM.
      //    If axe fails (CSP blocks injection, network hiccup on the web_accessible_resource,
      //    etc.) we still ship the custom report — axe is additive, never required.
      let axeFindings: AuditFinding[] = [];
      let axeError: string | undefined;
      try {
        const axeResponse = (await chrome.runtime.sendMessage({ type: 'AUDIT_RUN_AXE' })) as {
          results?: AxeResults;
          error?: string;
        } | null;
        if (axeResponse?.error) {
          axeError = axeResponse.error;
        } else if (axeResponse?.results) {
          axeFindings = mapAxeViolationsToFindings(axeResponse.results);
        } else {
          axeError = 'axe-core returned no data';
        }
      } catch (err) {
        axeError = `axe-core unreachable: ${String(err)}`;
      }

      // 3. Merge, rebuild the report with deduped scoring.
      const merge = mergeAuditFindings(customFindings, axeFindings);
      const report = rebuildReportWithMergedFindings(customReport, merge.merged, {
        custom: merge.custom,
        axe: merge.axe,
        both: merge.both,
      });

      setState({ kind: 'done', report, axeError });
    } catch (err) {
      setState({ kind: 'error', message: `Scan failed: ${String(err)}` });
    }
  }, []);

  const handleHighlight = useCallback((selector: string) => {
    chrome.runtime.sendMessage({ type: 'HIGHLIGHT_ELEMENT', payload: { selector } }).catch(() => {});
  }, []);

  const handleExportPDF = useCallback(() => {
    if (state.kind !== 'done') return;
    const version = chrome.runtime.getManifest().version;
    downloadAuditPDF(state.report, version);
  }, [state]);

  const toggleSeverity = useCallback((sev: AuditSeverity) => {
    setActiveSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev);
      else next.add(sev);
      return next;
    });
  }, []);

  const toggleSource = useCallback((src: AuditFindingSource) => {
    setActiveSources((prev) => {
      const next = new Set(prev);
      if (next.has(src)) next.delete(src);
      else next.add(src);
      return next;
    });
  }, []);

  const filteredFindings = useMemo(() => {
    if (state.kind !== 'done') return [] as AuditFinding[];
    return state.report.findings.filter((f) => {
      if (!activeSeverities.has(f.severity)) return false;
      // Legacy findings without `source` default to 'custom' for filter purposes.
      const src = f.source ?? 'custom';
      return activeSources.has(src);
    });
  }, [state, activeSeverities, activeSources]);

  const groupedBySeverity = useMemo(() => {
    const groups: Record<AuditSeverity, AuditFinding[]> = {
      critical: [],
      serious: [],
      moderate: [],
      minor: [],
      info: [],
    };
    for (const f of filteredFindings) {
      groups[f.severity].push(f);
    }
    return groups;
  }, [filteredFindings]);

  if (state.kind === 'idle') {
    return (
      <div className="ab-audit-panel">
        <div className="ab-audit-empty">
          <div className="ab-audit-empty-title">WCAG 2.1 Accessibility Audit</div>
          <p className="ab-audit-empty-desc">
            Scan the current page with AccessBridge's 20 heuristic WCAG checks plus the
            industry-standard axe-core engine. Get a merged score, category breakdown,
            and exportable PDF report.
          </p>
          <button type="button" className="ab-audit-primary-btn" onClick={runScan}>
            Run Audit
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === 'scanning') {
    return (
      <div className="ab-audit-panel">
        <div className="ab-audit-loading">Scanning page accessibility (custom + axe-core)…</div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="ab-audit-panel">
        <div className="ab-audit-error">{state.message}</div>
        <button type="button" className="ab-audit-primary-btn" onClick={runScan}>
          Retry
        </button>
      </div>
    );
  }

  const { report, axeError } = state;
  const sources = report.sources;

  return (
    <div className="ab-audit-panel">
      {/* Header — score + page meta */}
      <div className="ab-audit-header">
        <ScoreRing score={report.overallScore} size={96} stroke={9} label="Overall" />
        <div className="ab-audit-header-meta">
          <div className="ab-audit-header-url" title={report.url}>{report.url}</div>
          <div className="ab-audit-header-title" title={report.pageTitle}>
            {report.pageTitle || '(untitled page)'}
          </div>
          <div className="ab-audit-header-stats">
            <span className="ab-audit-header-stat">
              <strong>{report.findings.length}</strong> findings
            </span>
            <span className="ab-audit-header-stat">
              <strong>{report.totalElements}</strong> elements
            </span>
            {sources && (
              <span className="ab-audit-header-stat" title="custom + axe + overlap">
                <strong>{sources.custom}</strong>c · <strong>{sources.axe}</strong>a ·{' '}
                <strong>{sources.both}</strong>∩
              </span>
            )}
          </div>
        </div>
      </div>

      {axeError && (
        <div className="ab-audit-notice" role="status">
          axe-core skipped: {axeError}. Custom findings still applied.
        </div>
      )}

      {/* WCAG compliance badges */}
      <div className="ab-wcag-badges">
        <WCAGBadge level="A" percentage={report.wcagCompliance.A} />
        <WCAGBadge level="AA" percentage={report.wcagCompliance.AA} />
        <WCAGBadge level="AAA" percentage={report.wcagCompliance.AAA} />
      </div>

      {/* Category breakdown */}
      <div className="ab-category-section">
        <div className="ab-category-section-title">WCAG Principles</div>
        {PRINCIPLES.map((p) => (
          <CategoryBar key={p} principle={p} score={report.scoreByCategory[p] ?? 100} />
        ))}
      </div>

      {/* Action row — re-scan + export */}
      <div className="ab-audit-actions">
        <span className="ab-audit-duration">
          Scanned in {report.durationMs} ms
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="ab-audit-secondary-btn" onClick={runScan}>
            Re-scan
          </button>
          <button type="button" className="ab-audit-primary-btn" onClick={handleExportPDF}>
            Export PDF
          </button>
        </div>
      </div>

      {/* Severity filters */}
      <div className="ab-severity-filters" role="group" aria-label="Filter findings by severity">
        {SEVERITY_ORDER.map((sev) => {
          const count = report.summary[sev] ?? 0;
          const active = activeSeverities.has(sev);
          return (
            <button
              key={sev}
              type="button"
              className={`ab-severity-chip${active ? ' active' : ''}`}
              data-sev={sev}
              aria-pressed={active}
              onClick={() => toggleSeverity(sev)}
            >
              <span className="sev-dot" aria-hidden="true" />
              {sev} ({count})
            </button>
          );
        })}
      </div>

      {/* Source filters — only shown when axe produced a verdict */}
      {sources && (
        <div className="ab-source-filters" role="group" aria-label="Filter findings by source">
          {SOURCE_ORDER.map((src) => {
            const count = sources[src];
            const active = activeSources.has(src);
            return (
              <button
                key={src}
                type="button"
                className={`ab-source-chip${active ? ' active' : ''}`}
                data-source={src}
                aria-pressed={active}
                onClick={() => toggleSource(src)}
              >
                {src} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Findings grouped by severity */}
      {filteredFindings.length === 0 ? (
        <div className="ab-audit-empty">
          <div className="ab-audit-empty-desc">
            No findings match the selected filters.
          </div>
        </div>
      ) : (
        <div className="ab-findings-list">
          {SEVERITY_ORDER.map((sev) => {
            const group = groupedBySeverity[sev];
            if (group.length === 0) return null;
            return (
              <section key={sev} className="ab-sev-group" aria-label={`${sev} severity findings`}>
                <div className="ab-sev-group-title" data-sev={sev}>
                  {sev} — {group.length}
                </div>
                {group.map((f) => (
                  <FindingItem key={f.id} finding={f} onHighlight={handleHighlight} />
                ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
