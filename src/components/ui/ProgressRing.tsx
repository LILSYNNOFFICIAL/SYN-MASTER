import React, { useEffect, useRef, useState } from 'react';
import { clampPercent, nextMonotonicPercent, type ProgressRingState } from './progressMath';

export type { ProgressRingState } from './progressMath';

export interface ProgressRingProps {
  /** 0..100; clamped. While running the ring never moves backwards. */
  percent: number;
  /** Outer diameter in px. */
  size?: number;
  /** Optional small stage text under the number. */
  label?: string;
  state?: ProgressRingState;
  /** Accessible name for the progressbar. */
  ariaLabel?: string;
  /** Hold the last real value with a subtle pulse (stage gives no granular progress). */
  working?: boolean;
  className?: string;
  /** Hide the centred number/label (when a parent draws its own content inside). */
  hideText?: boolean;
  children?: React.ReactNode;
}

/**
 * Reusable progress ring: gold base ring, electric-blue fill, percentage centred.
 * Monotonic while running; resets when it goes back to idle. Motion is disabled
 * under prefers-reduced-motion (see .syn-progress-ring rules in index.css).
 */
export const ProgressRing: React.FC<ProgressRingProps> = ({
  percent,
  size = 120,
  label,
  state = 'running',
  ariaLabel = 'Progress',
  working = false,
  className = '',
  hideText = false,
  children,
}) => {
  const [shown, setShown] = useState(() => clampPercent(percent));
  const prevState = useRef(state);
  useEffect(() => {
    const reset = state === 'idle' || (prevState.current !== 'running' && state === 'running');
    prevState.current = state;
    setShown((prev) => (state === 'running' || reset ? nextMonotonicPercent(prev, percent, reset) : prev));
  }, [percent, state]);

  const value = Math.round(shown);
  const stroke = Math.max(4, Math.round(size * 0.075));
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - shown / 100);
  const fillColor = state === 'error' ? 'var(--syn-bad, #F0475A)' : state === 'stopped' ? 'var(--syn-gold-lo, #8A6A2A)' : 'var(--syn-blue-electric, #38BDF8)';

  return (
    <div
      className={`syn-progress-ring is-${state}${working && state === 'running' ? ' is-working' : ''} ${className}`.trim()}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={label ? `${value}% · ${label}` : `${value}%`}
      data-state={state}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--syn-gold, #D4A84A)" strokeWidth={stroke} opacity={0.9} />
        <circle
          className="syn-progress-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={fillColor}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {children}
      {!hideText && (
        <span className="syn-progress-ring-text" aria-hidden="true">
          <strong>{state === 'error' ? '!' : `${value}%`}</strong>
          {label && <small>{label}</small>}
        </span>
      )}
    </div>
  );
};

export default ProgressRing;
