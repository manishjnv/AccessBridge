import React from 'react';
import {
  DEFAULT_GESTURE_BINDINGS,
  getActionById,
  type GestureBinding,
  type GestureType,
} from '@accessbridge/core/gestures';

const GESTURE_LABELS: Record<GestureType, { label: string; icon: string }> = {
  'swipe-left': { label: 'Swipe Left', icon: 'M18 12H6 M10 8l-4 4 4 4' },
  'swipe-right': { label: 'Swipe Right', icon: 'M6 12h12 M14 8l4 4-4 4' },
  'swipe-up': { label: 'Swipe Up', icon: 'M12 18V6 M8 10l4-4 4 4' },
  'swipe-down': { label: 'Swipe Down', icon: 'M12 6v12 M8 14l4 4 4-4' },
  'circle-cw': { label: 'Circle ↻', icon: 'M12 4a8 8 0 1 0 7.5 5.3 M19.5 4v5.5h-5.5' },
  'circle-ccw': { label: 'Circle ↺', icon: 'M12 4a8 8 0 1 1 -7.5 5.3 M4.5 4v5.5h5.5' },
  'zigzag': { label: 'Zigzag', icon: 'M4 12l4-4 4 4 4-4 4 4' },
  'two-finger-tap': { label: '2-finger Tap', icon: 'M8 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4 M16 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4' },
  'three-finger-tap': { label: '3-finger Tap', icon: 'M6 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4 M12 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4 M18 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4' },
  'double-tap': { label: 'Double Tap', icon: 'M12 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4 M12 14a2 2 0 1 1 0 4 2 2 0 0 1 0-4' },
  'triple-tap': { label: 'Triple Tap', icon: 'M12 6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3 M12 11a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3 M12 16a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3' },
  'long-press': { label: 'Long Press', icon: 'M12 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4 M12 4v2 M12 18v2 M4 12h2 M18 12h2' },
  'pinch-in': { label: 'Pinch In', icon: 'M6 6l5 5 M18 6l-5 5 M6 18l5-5 M18 18l-5-5' },
  'pinch-out': { label: 'Pinch Out', icon: 'M4 4l4 4 M20 4l-4 4 M4 20l4-4 M20 20l-4-4' },
  'two-finger-swipe-left': { label: '2-finger ←', icon: 'M18 9H6 M10 5l-4 4 4 4 M18 15H6 M10 11l-4 4 4 4' },
  'two-finger-swipe-right': { label: '2-finger →', icon: 'M6 9h12 M14 5l4 4-4 4 M6 15h12 M14 11l4 4-4 4' },
};

interface Props {
  onClose: () => void;
  bindings?: GestureBinding[];
}

export function GestureLibrary({ onClose, bindings = DEFAULT_GESTURE_BINDINGS }: Props) {
  const rows = bindings.filter((b) => b.enabled);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Gesture library"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10, 10, 26, 0.85)',
        backdropFilter: 'blur(8px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '24px 12px',
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#1a1a2e',
          border: '1px solid rgba(123, 104, 238, 0.4)',
          borderRadius: 16,
          padding: 20,
          maxWidth: 420,
          width: '100%',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
          color: '#e2e8f0',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div
            style={{
              fontSize: 16,
              fontWeight: 700,
              background: 'linear-gradient(135deg, #7b68ee, #bb86fc)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            Gesture Library
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(123, 104, 238, 0.18)',
              color: '#94a3b8',
              borderRadius: 8,
              padding: '4px 10px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>

        <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12, lineHeight: 1.5 }}>
          Touch, trackpad (two-finger), or mouse (Shift+drag) — recognized gestures
          dispatch the actions below. Press <kbd style={kbdStyle}>?</kbd> on any page to
          summon this list there too.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>
          {rows.map((b) => {
            const meta = GESTURE_LABELS[b.gesture];
            const action = getActionById(b.actionId);
            return (
              <div
                key={b.gesture}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(123, 104, 238, 0.12)',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              >
                <svg
                  width={28}
                  height={28}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#bb86fc"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                  aria-hidden="true"
                >
                  <path d={meta.icon} />
                </svg>
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <div style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                    {meta.label}
                  </div>
                  <div style={{ color: '#e2e8f0', fontWeight: 600 }}>{action?.name ?? b.actionId}</div>
                  {action?.description && (
                    <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 2 }}>{action.description}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const kbdStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '0 6px',
  border: '1px solid rgba(123, 104, 238, 0.4)',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.05)',
  fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
  fontSize: 10,
  color: '#bb86fc',
};
