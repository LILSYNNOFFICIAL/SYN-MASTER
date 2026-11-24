import React, { useId, useRef } from 'react';
import { clampNumber, computeKeyStepValue, formatParameterValue, quantizeToStep, valueToNormalized } from '../controls/parameterMath';

/**
 * Console vertical fader with a glowing cap. role="slider", keyboard operable
 * (arrows / Page / Home / End), pointer drag on the whole track, double-click = default.
 * With `readOnly` it renders a measured level bar instead (no slider role, no handlers).
 */
export interface GlowFaderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  unit?: string;
  precision?: number;
  signed?: boolean;
  accent?: 'blue' | 'gold' | 'magenta';
  heightPx?: number;
  readOnly?: boolean;
  valueText?: string;
  onChange?: (next: number) => void;
}

const ACCENT = { blue: 'var(--syn-blue)', gold: 'var(--syn-gold)', magenta: 'var(--syn-magenta)' } as const;

export const GlowFader: React.FC<GlowFaderProps> = ({
  label,
  value,
  min,
  max,
  step = 0.1,
  defaultValue,
  unit = '',
  precision = 1,
  signed = false,
  accent = 'gold',
  heightPx = 96,
  readOnly = false,
  valueText,
  onChange,
}) => {
  const id = useId();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const v = clampNumber(value, min, max, min);
  const norm = valueToNormalized(v, min, max);
  const text = valueText ?? `${formatParameterValue(v, { precision, signed })}${unit ? ` ${unit}` : ''}`;
  const commit = (next: number) => {
    if (!readOnly && onChange && Number.isFinite(next) && next !== v) onChange(next);
  };
  const fromPointer = (clientY: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const n = clampNumber(1 - (clientY - r.top) / Math.max(1, r.height), 0, 1);
    commit(quantizeToStep(min + n * (max - min), min, max, step, precision));
  };

  return (
    <div className={`syn-fader${readOnly ? ' is-readonly' : ''}`} style={{ ['--fader-accent' as string]: ACCENT[accent] }}>
      <div
        ref={trackRef}
        className="syn-fader-track"
        style={{ height: heightPx }}
        role={readOnly ? 'meter' : 'slider'}
        tabIndex={readOnly ? undefined : 0}
        aria-labelledby={`${id}-label`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(v.toFixed(precision))}
        aria-valuetext={text}
        onPointerDown={readOnly ? undefined : (e) => {
          dragging.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          fromPointer(e.clientY);
        }}
        onPointerMove={readOnly ? undefined : (e) => dragging.current && fromPointer(e.clientY)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onDoubleClick={readOnly || defaultValue === undefined ? undefined : () => commit(defaultValue)}
        onKeyDown={readOnly ? undefined : (e) => {
          const next = computeKeyStepValue({ currentValue: v, key: e.key, shiftKey: e.shiftKey, min, max, step, precision, defaultValue });
          if (next !== null) {
            e.preventDefault();
            commit(next);
          }
        }}
      >
        <span className="syn-fader-fill" style={{ height: `${norm * 100}%` }} />
        {!readOnly && <span className="syn-fader-cap" style={{ bottom: `calc(${norm * 100}% - 7px)` }} />}
      </div>
      <div className="syn-fader-label" id={`${id}-label`}>{label}</div>
      <div className="syn-fader-value">{text}</div>
    </div>
  );
};
