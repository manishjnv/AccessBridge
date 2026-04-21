import React from 'react';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  unit?: string;
  /** When true, renders the slider disabled and ignores change events. */
  locked?: boolean;
  /** Tooltip text shown when locked. Defaults to "Managed by your organization". */
  lockedReason?: string;
}

export function Slider({ label, value, min, max, step, onChange, unit, locked, lockedReason }: SliderProps) {
  const isDisabled = locked;
  const titleAttr = locked ? (lockedReason ?? 'Managed by your organization') : undefined;

  return (
    <div
      className="space-y-1"
      style={isDisabled ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
      title={titleAttr}
    >
      <div className="flex justify-between items-center">
        <label className="text-xs text-a11y-muted">{label}</label>
        <span className="text-xs font-mono text-a11y-text">
          {value.toFixed(step < 1 ? 1 : 0)}
          {unit && <span className="text-a11y-muted ml-0.5">{unit}</span>}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={isDisabled}
        onChange={isDisabled ? undefined : (e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 bg-a11y-primary/40 rounded-full appearance-none cursor-pointer
                   [&::-webkit-slider-thumb]:appearance-none
                   [&::-webkit-slider-thumb]:w-3.5
                   [&::-webkit-slider-thumb]:h-3.5
                   [&::-webkit-slider-thumb]:rounded-full
                   [&::-webkit-slider-thumb]:bg-a11y-accent
                   [&::-webkit-slider-thumb]:shadow-sm
                   [&::-webkit-slider-thumb]:cursor-pointer"
        style={isDisabled ? { cursor: 'not-allowed' } : undefined}
      />
    </div>
  );
}
