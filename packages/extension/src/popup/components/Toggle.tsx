import React from 'react';

interface ToggleProps {
  label?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  size?: 'sm' | 'md';
  /** When true, renders the toggle disabled and ignores click events. */
  locked?: boolean;
  /** Tooltip text shown when locked. Defaults to "Managed by your organization". */
  lockedReason?: string;
}

export function Toggle({ label, value, onChange, size = 'md', locked, lockedReason }: ToggleProps) {
  const trackSize = size === 'sm' ? 'w-8 h-4' : 'w-10 h-5';
  const thumbSize = size === 'sm' ? 'w-3 h-3' : 'w-4 h-4';
  const thumbTranslate = size === 'sm' ? 'translate-x-4' : 'translate-x-5';
  const isDisabled = locked;
  const titleAttr = locked ? (lockedReason ?? 'Managed by your organization') : undefined;

  return (
    <label
      className="flex items-center justify-between cursor-pointer group"
      style={isDisabled ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
      title={titleAttr}
    >
      {label && (
        <span className="text-sm text-a11y-text group-hover:text-white transition-colors">
          {label}
        </span>
      )}
      <button
        role="switch"
        aria-checked={value}
        disabled={isDisabled}
        onClick={isDisabled ? undefined : () => onChange(!value)}
        className={`
          relative inline-flex items-center shrink-0 rounded-full transition-colors
          ${trackSize}
          ${value ? 'bg-a11y-accent' : 'bg-a11y-primary/50'}
        `}
        style={isDisabled ? { cursor: 'not-allowed' } : undefined}
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
