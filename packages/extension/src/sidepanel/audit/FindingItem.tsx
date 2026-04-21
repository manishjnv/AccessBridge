import React from 'react';
import type { AuditFinding } from '@accessbridge/core/audit';

interface FindingItemProps {
  finding: AuditFinding;
  onHighlight?: (selector: string) => void;
}

export function FindingItem({ finding, onHighlight }: FindingItemProps) {
  const canHighlight = Boolean(finding.elementSelector) && finding.nodeIndex !== null;

  return (
    <article
      className="ab-finding"
      data-sev={finding.severity}
      aria-label={`${finding.severity} severity finding: ${finding.rule}`}
    >
      <div className="ab-finding-head">
        <span className="ab-finding-sev">{finding.severity}</span>
        <span className="ab-finding-criterion">WCAG {finding.wcagCriterion} · {finding.level}</span>
        <span className="ab-finding-rule" title={finding.rule}>{finding.rule}</span>
        {finding.source && (
          <span
            className="ab-finding-source"
            data-source={finding.source}
            title={
              finding.source === 'both'
                ? 'Custom rule + axe-core both flagged this element'
                : finding.source === 'axe'
                  ? 'Detected by axe-core'
                  : 'Detected by AccessBridge custom rule'
            }
          >
            {finding.source}
          </span>
        )}
      </div>
      <p className="ab-finding-body">{finding.message}</p>
      {finding.htmlSnippet && (
        <code className="ab-finding-snippet">{finding.htmlSnippet}</code>
      )}
      <p className="ab-finding-suggestion">{finding.suggestion}</p>
      {canHighlight && onHighlight && (
        <div className="ab-finding-actions">
          <button
            type="button"
            className="ab-finding-highlight-btn"
            onClick={() => onHighlight(finding.elementSelector)}
          >
            Highlight on page
          </button>
        </div>
      )}
    </article>
  );
}
