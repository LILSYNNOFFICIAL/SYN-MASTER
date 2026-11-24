import React, { useId, useRef } from 'react';
import {
  clampNumber,
  computeDragValue,
  computeKeyStepValue,
  describeArcPath,
  formatParameterValue,
  KNOB_END_ANGLE_DEG,
  KNOB_START_ANGLE_DEG,
  normalizedToAngleDeg,
  polarToCartesian,
  valueToNormalized,
} from '../controls/parameterMath';

/**
 * Console arc knob (reference-mockup style): gold ring, glowing blue/gold value arc and
 * a large numeric readout in the centre. Same interaction contract as RotaryKnob:
 * vertical drag (Shift = fine), arrow/Page/Home/End keys, double-click = default.
 * Exposed to assistive technology as role="slider".
 */
export interface ArcKnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  unit?: string;
  precision?: number;
  signed?: boolean;
  bipolar?: boolean;
  accent?: 'blue' | 'gold' | 'magenta';
  size?: number;
  caption?: string;
  rangeLabels?: [string, string];
  disabled?: boolean;
  onChange: (next: number) => void;
}

const ACCENT: Record<NonNullable<ArcKnobProps['accent']>, string> = {
  blue: 'var(--syn-blue)',
  gold: 'var(--syn-gold)',
  magenta: 'var(--syn-magenta)',
};

export const ArcKnob: React.FC<ArcKnobProps> = ({
  label,
  value,
  min,
  max,
  step = 0.1,
  defaultValue,
  unit = '',
  precision = 1,
  signed = false,
  bipolar = false,
  accent = 'blue',
  size = 116,
  caption,
  rangeLabels,
  disabled = false,
  onChange,
}) => {
  const id = useId();
  const dragRef = useRef<{ startY: number; startNorm: number } | null>(null);
  const v = clampNumber(value, min, max, min);
  const norm = valueToNormalized(v, min, max);
  const c = size / 2;
  const r = size / 2 - 9;
  const angle = normalizedToAngleDeg(norm);
  const zeroNorm = bipolar ? valueToNormalized(clampNumber(0, min, max, min), min, max) : 0;
  const zeroAngle = normalizedToAngleDeg(zeroNorm);
  const from = Math.min(zeroAngle, angle);
  const to = Math.max(zeroAngle, angle);
  const track = describeArcPath(c, c, r, KNOB_START_ANGLE_DEG, KNOB_END_ANGLE_DEG);
  const arc = to - from > 0.5 ? describeArcPath(c, c, r, from, to) : null;
  const tip = polarToCartesian(c, c, r, angle);
  const text = formatParameterValue(v, { precision, signed });
  const commit = (next: number) => {
    if (!disabled && Number.isFinite(next) && next !== v) onChange(next);
  };

  return (
    <div className={`syn-arcknob${disabled ? ' is-disabled' : ''}`} style={{ ['--knob-accent' as string]: ACCENT[accent] }}>
      <div className="syn-arcknob-label" id={`${id}-label`}>{label}</div>
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={`${id}-label`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(v.toFixed(precision))}
        aria-valuetext={`${text} ${unit}`.trim()}
        aria-disabled={disabled || undefined}
        className="syn-arcknob-dial"
        style={{ ['--knob' as string]: `${size}px` }}
        onPointerDown={(e) => {
          if (disabled) return;
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          dragRef.current = { startY: e.clientY, startNorm: norm };
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          const { value: next } = computeDragValue({
            startNormalized: d.startNorm,
            deltaPx: d.startY - e.clientY,
            fine: e.shiftKey,
            min,
            max,
            step,
            precision,
          });
          commit(next);
        }}
        onPointerUp={() => (dragRef.current = null)}
        onPointerCancel={() => (dragRef.current = null)}
        onDoubleClick={() => defaultValue !== undefined && commit(defaultValue)}
        onKeyDown={(e) => {
          const next = computeKeyStepValue({ currentValue: v, key: e.key, shiftKey: e.shiftKey, min, max, step, precision, defaultValue });
          if (next !== null) {
            e.preventDefault();
            commit(next);
          }
        }}
      >
        <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <circle cx={c} cy={c} r={r + 6} className="syn-arcknob-ring" />
          <circle cx={c} cy={c} r={r - 9} className="syn-arcknob-cap" />
          <path d={track} className="syn-arcknob-track" />
          {arc && <path d={arc} className="syn-arcknob-arc" />}
          <circle cx={tip.x} cy={tip.y} r={3.2} className="syn-arcknob-tip" />
        </svg>
        <div className="syn-arcknob-readout">
          <span className="syn-arcknob-value">{text}</span>
          {unit && <span className="syn-arcknob-unit">{unit}</span>}
        </div>
      </div>
      {rangeLabels && (
        <div className="syn-arcknob-range" aria-hidden="true">
          <span>{rangeLabels[0]}</span>
          <span>{rangeLabels[1]}</span>
        </div>
      )}
      {caption && <div className="syn-arcknob-caption">{caption}</div>}
    </div>
  );
};
