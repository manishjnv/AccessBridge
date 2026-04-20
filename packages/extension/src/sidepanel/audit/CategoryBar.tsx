import React from 'react';

interface CategoryBarProps {
  principle: string;
  score: number;
}

function colorFor(score: number): string {
  if (score >= 80) return '#10b981';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

export function CategoryBar({ principle, score }: CategoryBarProps) {
  const color = colorFor(score);
  return (
    <div className="ab-category-bar">
      <div className="ab-category-bar-head">
        <span className="ab-category-bar-label">{principle}</span>
        <span className="ab-category-bar-value" style={{ color }}>
          {Math.round(score)}
        </span>
      </div>
      <div
        className="ab-category-bar-track"
        role="progressbar"
        aria-valuenow={Math.round(score)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${principle} score`}
      >
        <div
          className="ab-category-bar-fill"
          style={{ width: `${Math.min(Math.max(score, 0), 100)}%`, background: color }}
        />
      </div>
    </div>
  );
}
