import React from 'react';
import type { WCAGLevel } from '@accessbridge/core/audit';

interface WCAGBadgeProps {
  level: WCAGLevel;
  percentage: number;
}

function tierClass(pct: number): 'good' | 'fair' | 'poor' {
  if (pct >= 80) return 'good';
  if (pct >= 50) return 'fair';
  return 'poor';
}

export function WCAGBadge({ level, percentage }: WCAGBadgeProps) {
  const label = percentage >= 80 ? 'Compliant' : percentage >= 50 ? 'Partial' : 'Non-compliant';
  return (
    <div
      className={`ab-wcag-badge ${tierClass(percentage)}`}
      role="group"
      aria-label={`WCAG 2.1 level ${level}: ${percentage} percent, ${label}`}
    >
      <div className="ab-wcag-badge-level">WCAG {level}</div>
      <div className="ab-wcag-badge-pct">{Math.round(percentage)}%</div>
      <div className="ab-wcag-badge-label">{label}</div>
    </div>
  );
}
