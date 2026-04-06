import React from 'react';

interface ToggleProps {
  label?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  size?: 'sm' | 'md';
}

export function Toggle({ label, value, onChange, size = 'md' }: ToggleProps) {
  const trackSize = size === 'sm' ? 'w-8 h-4' : 'w-10 h-5';
  const thumbSize = size === 'sm' ? 'w-3 h-3' : 'w-4 h-4';
  const thumbTranslate = size === 'sm' ? 'translate-x-4' : 'translate-x-5';

  return (
    <label className="flex items-center justify-between cursor-pointer group">
      {label && (
        <span className="text-sm text-a11y-text group-hover:text-white transition-colors">
          {label}
        </span>
      )}
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`
          relative inline-flex items-center shrink-0 rounded-full transition-colors
          ${trackSize}
          ${value ? 'bg-a11y-accent' : 'bg-a11y-primary/50'}
        `}
      >
        <span
          className={`
            inline-block rounded-full bg-white shadow transform transition-transform
            ${thumbSize}
            ${value ? thumbTranslate : 'translate-x-0.5'}
          `}
        />
      </button>
    </label>
  );
}
