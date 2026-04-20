import React from 'react';

interface ScoreRingProps {
  score: number;
  size?: number;
  stroke?: number;
  label?: string;
}

function colorFor(score: number): string {
  if (score >= 80) return '#10b981';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

export function ScoreRing({ score, size = 120, stroke = 10, label }: ScoreRingProps) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ;
  const offset = circ - (Math.min(Math.max(score, 0), 100) / 100) * circ;
  const color = colorFor(score);

  return (
    <div className="ab-score-ring-wrap">
      <svg
        className="ab-score-ring-svg"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`Accessibility score ${score} out of 100`}
      >
        <circle
          className="ab-score-ring-track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
        />
        <circle
          className="ab-score-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          stroke={color}
          strokeDasharray={dash}
          strokeDashoffset={offset}
          style={{ filter: `drop-shadow(0 0 6px ${color}55)` }}
        />
        <g transform={`rotate(90 ${size / 2} ${size / 2})`}>
          <text
            className="ab-score-ring-value"
            x={size / 2}
            y={size / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fill={color}
          >
            {Math.round(score)}
          </text>
          <text
            className="ab-score-ring-denom"
            x={size / 2}
            y={size / 2 + 14}
            textAnchor="middle"
            dominantBaseline="central"
          >
            /100
          </text>
        </g>
      </svg>
      {label && <div className="ab-score-ring-label">{label}</div>}
    </div>
  );
}
