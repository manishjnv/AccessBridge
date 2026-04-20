import React, { useCallback, useMemo, useState } from 'react';
import type {
  AuditFinding,
  AuditInput,
  AuditReport,
  AuditSeverity,
  WCAGPrinciple,
} from '@accessbridge/core/audit';
import { AuditEngine } from '@accessbridge/core/audit';
import { ScoreRing } from './ScoreRing.js';
import { WCAGBadge } from './WCAGBadge.js';
import { CategoryBar } from './CategoryBar.js';
import { FindingItem } from './FindingItem.js';
import { downloadAuditPDF } from './pdf-generator.js';

const SEVERITY_ORDER: AuditSeverity[] = ['critical', 'serious', 'moderate', 'minor', 'info'];
const PRINCIPLES: WCAGPrinciple[] = ['perceivable', 'operable', 'understandable', 'robust'];

const engine = new AuditEngine();

type ScanState =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; report: AuditReport };

export function AuditPanel() {
  const [state, setState] = useState<ScanState>({ kind: 'idle' });
  const [activeSeverities, setActiveSeverities] = useState<Set<AuditSeverity>>(
    new Set(SEVERITY_ORDER),
  );

  const runScan = useCallback(async () => {
    setState({ kind: 'scanning' });
    try {
      const response = await chrome.runtime.sendMessage({ type: 'AUDIT_SCAN_REQUEST' });
      if (!response) {
        setState({ kind: 'error', message: 'No response from background script.' });
        return;
      }
      if (typeof response === 'object' && 'error' in response) {
        setState({ kind: 'error', message: String((response as { error: string }).error) });
        return;
      }
      const input = (response as { input?: AuditInput }).input;
      if (!input) {
        setState({ kind: 'error', message: 'Audit collector returned no data.' });
        return;
      }
      const report = engine.runAudit(input);
      setState({ kind: 'done', report });
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

  const filteredFindings = useMemo(() => {
    if (state.kind !== 'done') return [] as AuditFinding[];
    return state.report.findings.filter((f) => activeSeverities.has(f.severity));
  }, [state, activeSeverities]);

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
            Scan the current page against 20 heuristic WCAG checks — get a score, category
            breakdown, and exportable PDF report for compliance review.
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
        <div className="ab-audit-loading">Scanning page accessibility…</div>
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

  const { report } = state;

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
          </div>
        </div>
      </div>

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

      {/* Findings grouped by severity */}
      {filteredFindings.length === 0 ? (
        <div className="ab-audit-empty">
          <div className="ab-audit-empty-desc">
            No findings match the selected severities.
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
