import React, { useEffect, useId, useRef, useState } from 'react';
import {
  KNOB_END_ANGLE_DEG,
  KNOB_START_ANGLE_DEG,
  clampNumber,
  computeDragValue,
  computeKeyStepValue,
  describeArcPath,
  formatParameterValue,
  normalizedToAngleDeg,
  polarToCartesian,
  quantizeToStep,
  valueToNormalized,
  type ParameterScale,
} from './parameterMath';
import { NumericParameterDisplay } from './NumericParameterDisplay';

export type KnobSize = 'xs' | 'sm' | 'md' | 'lg';
export type ControlAccent = 'cyan' | 'gold';

export interface RotaryKnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  unit?: string;
  scale?: ParameterScale;
  bipolar?: boolean;
  signed?: boolean;
  size?: KnobSize;
  accent?: ControlAccent;
  disabled?: boolean;
  readOnly?: boolean;
  precision?: number;
  formatValue?: (value: number) => string;
  displayValueOverride?: string;
  showAdjustButtons?: boolean;
  showDefaultResetButton?: boolean;
  sensitivityPx?: number;
  ariaLabel?: string;
  testId?: string;
  onChange: (nextValue: number) => void;
  onCommit?: (committedValue: number) => void;
}

const SIZE_METRICS: Record<
  KnobSize,
  { box: number; outerR: number; arcR: number; capR: number; tickInner: number; tickOuter: number }
> = {
  xs: { box: 44, outerR: 19, arcR: 17.5, capR: 13.5, tickInner: 19.2, tickOuter: 21 },
  sm: { box: 52, outerR: 22.5, arcR: 21, capR: 16, tickInner: 22.8, tickOuter: 24.8 },
  md: { box: 62, outerR: 27, arcR: 25, capR: 19.5, tickInner: 27.2, tickOuter: 29.6 },
  lg: { box: 74, outerR: 32.5, arcR: 30, capR: 23.5, tickInner: 32.5, tickOuter: 35.2 },
};

const TICK_FRACTIONS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

export const RotaryKnob: React.FC<RotaryKnobProps> = ({
  label,
  value,
  min,
  max,
  step = 0.1,
  defaultValue,
  unit = '',
  scale = 'linear',
  bipolar = false,
  signed,
  size = 'sm',
  accent = 'gold',
  disabled = false,
  readOnly = false,
  precision,
  formatValue,
  displayValueOverride,
  showAdjustButtons = false,
  showDefaultResetButton = false,
  sensitivityPx = 145,
  ariaLabel,
  testId,
  onChange,
  onCommit,
}) => {
  const uid = useId().replace(/:/g, '');
  const resolvedDefault = clampNumber(
    defaultValue !== undefined ? defaultValue : bipolar ? (min + max) / 2 : min,
    min,
    max,
  );
  const safeValue = clampNumber(value, min, max, resolvedDefault);

  // Maintain live preview while dragging so even async-throttled parents (like VST3 RPC) stay ultra-responsive
  const [dragState, setDragState] = useState<{
    active: boolean;
    fine: boolean;
    previewValue: number;
  }>({ active: false, fine: false, previewValue: safeValue });

  const [editTriggerCount, setEditTriggerCount] = useState(0);

  const dragOriginRef = useRef<{
    startY: number;
    startX: number;
    startNormalized: number;
    latestValue: number;
  } | null>(null);

  const sliderRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  const onCommitRef = useRef(onCommit);
  onChangeRef.current = onChange;
  onCommitRef.current = onCommit;

  const effectiveValue = dragState.active ? dragState.previewValue : safeValue;
  const normalized = valueToNormalized(effectiveValue, min, max, scale);
  const angleDeg = normalizedToAngleDeg(normalized);
  const defaultNormalized = valueToNormalized(resolvedDefault, min, max, scale);
  const bipolarAnchorDeg = normalizedToAngleDeg(bipolar ? defaultNormalized : 0);

  const metrics = SIZE_METRICS[size];
  const center = metrics.box / 2;

  const isInteractive = !disabled && !readOnly;
  const effectiveSigned = signed ?? (bipolar || (min < 0 && max > 0));
  const formattedText =
    displayValueOverride && !dragState.active
      ? displayValueOverride
      : formatParameterValue(effectiveValue, {
          unit,
          step,
          precision,
          signed: effectiveSigned,
          formatValue,
        });

  const accentStroke = accent === 'gold' ? '#F5B82E' : '#38BDF8';
  const accentTip = accent === 'gold' ? '#FFF3CC' : '#7DD3FC';
  const accentGlow =
    accent === 'gold' ? 'rgba(245, 184, 46, 0.38)' : 'rgba(56, 189, 248, 0.38)';

  useEffect(() => {
    if (!dragState.active) return;

    const handleMove = (ev: PointerEvent) => {
      const origin = dragOriginRef.current;
      if (!origin) return;
      const dy = origin.startY - ev.clientY;
      const dx = (ev.clientX - origin.startX) * 0.35;
      const res = computeDragValue({
        startNormalized: origin.startNormalized,
        deltaPx: dy + dx,
        sensitivityPx,
        fine: ev.shiftKey,
        min,
        max,
        scale,
        step,
        precision,
      });
      origin.latestValue = res.value;
      setDragState({ active: true, fine: ev.shiftKey, previewValue: res.value });
      onChangeRef.current(res.value);
    };

    const handleUp = () => {
      const origin = dragOriginRef.current;
      dragOriginRef.current = null;
      setDragState((prev) => ({ ...prev, active: false, fine: false }));
      if (origin && onCommitRef.current) {
        onCommitRef.current(origin.latestValue);
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [dragState.active, max, min, precision, scale, sensitivityPx, step]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isInteractive) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    e.stopPropagation();
    sliderRef.current?.focus({ preventScroll: true });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore if synthetic environment lacks pointerId registration
    }
    const startNorm = valueToNormalized(safeValue, min, max, scale);
    dragOriginRef.current = {
      startY: e.clientY,
      startX: e.clientX,
      startNormalized: startNorm,
      latestValue: safeValue,
    };
    setDragState({ active: true, fine: e.shiftKey, previewValue: safeValue });
  };

  const handleReset = () => {
    if (!isInteractive) return;
    const resetVal = step > 0 ? quantizeToStep(resolvedDefault, min, max, step, precision) : resolvedDefault;
    onChangeRef.current(resetVal);
    onCommitRef.current?.(resetVal);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === 'Enter' && isInteractive) {
      e.preventDefault();
      e.stopPropagation();
      setEditTriggerCount((c) => c + 1);
      return;
    }
    if (e.key === ' ' && isInteractive) {
      e.preventDefault();
      e.stopPropagation();
      handleReset();
      return;
    }
    if (readOnly) return;

    const next = computeKeyStepValue({
      currentValue: safeValue,
      key: e.key,
      shiftKey: e.shiftKey,
      min,
      max,
      scale,
      step,
      precision,
      defaultValue: resolvedDefault,
    });
    if (next !== null) {
      e.preventDefault();
      e.stopPropagation();
      onChange(next);
      onCommit?.(next);
    }
  };

  const trackArcPath = describeArcPath(center, center, metrics.arcR, KNOB_START_ANGLE_DEG, KNOB_END_ANGLE_DEG);
  const activeArcPath =
    Math.abs(angleDeg - bipolarAnchorDeg) >= 0.4
      ? describeArcPath(center, center, metrics.arcR, bipolarAnchorDeg, angleDeg)
      : '';

  const pointerInner = polarToCartesian(center, center, metrics.capR * 0.28, angleDeg);
  const pointerOuter = polarToCartesian(center, center, metrics.capR * 0.86, angleDeg);

  return (
    <div
      data-testid={testId ?? `rotary-knob-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      data-adjusting={dragState.active ? 'true' : 'false'}
      data-readonly={readOnly ? 'true' : 'false'}
      data-disabled={disabled ? 'true' : 'false'}
      className={`relative flex flex-col items-center gap-1 select-none min-w-0 ${
        disabled ? 'opacity-45' : ''
      }`}
    >
      {/* Top Parameter Label */}
      <div className="flex items-center justify-center gap-1 w-full min-w-0">
        <span
          className="text-[10px] font-semibold tracking-wide text-[#B4BCC8] truncate text-center leading-tight"
          title={label}
        >
          {label}
        </span>
        {readOnly && (
          <span className="text-[9px] font-mono-tabular text-[#64748B] shrink-0" title="Read-only parameter">
            RO
          </span>
        )}
      </div>

      {/* Live Drag Floating Readout Pill */}
      {dragState.active && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute -top-6 z-30 px-1.5 py-0.5 rounded-sm bg-[#090B10] border border-[#38BDF8]/70 shadow-lg text-[10px] font-mono-tabular font-semibold text-[#E0F2FE] whitespace-nowrap"
        >
          {formattedText}
          {dragState.fine ? ' · FINE' : ''}
        </div>
      )}

      {/* Rotary Dial Interactive Slider */}
      <div
        ref={sliderRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel ?? label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(effectiveValue.toFixed(4))}
        aria-valuetext={formattedText}
        aria-disabled={disabled || undefined}
        aria-readonly={readOnly || undefined}
        onPointerDown={handlePointerDown}
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          handleReset();
        }}
        onKeyDown={handleKeyDown}
        title={
          disabled
            ? `${label}: Unavailable`
            : readOnly
              ? `${label}: ${formattedText} (Read-only)`
              : `${label}: ${formattedText} · Drag vertically (Shift=Fine, Double-click=Reset)`
        }
        className={`relative flex items-center justify-center touch-none rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[#38BDF8] focus-visible:ring-offset-1 focus-visible:ring-offset-[#0D0F14] transition-shadow ${
          isInteractive ? 'cursor-ns-resize' : 'cursor-default'
        }`}
        style={{
          width: metrics.box,
          height: metrics.box,
          minWidth: 44,
          minHeight: 44,
        }}
      >
        <svg
          width={metrics.box}
          height={metrics.box}
          viewBox={`0 0 ${metrics.box} ${metrics.box}`}
          className="overflow-visible pointer-events-none"
          aria-hidden="true"
        >
          <defs>
            {/* Dark graphite recessed housing gradient */}
            <radialGradient id={`well-${uid}`} cx="50%" cy="45%" r="55%">
              <stop offset="0%" stopColor="#05070B" />
              <stop offset="82%" stopColor="#0C0F16" />
              <stop offset="100%" stopColor="#1B202C" />
            </radialGradient>

            {/* Machined dark-graphite / gunmetal dial cap gradient */}
            <radialGradient id={`cap-${uid}`} cx="36%" cy="28%" r="72%">
              <stop offset="0%" stopColor="#2F3646" />
              <stop offset="48%" stopColor="#191D26" />
              <stop offset="88%" stopColor="#0F1218" />
              <stop offset="100%" stopColor="#080A0E" />
            </radialGradient>

            {/* Brushed metallic silver rim gradient */}
            <linearGradient id={`rim-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#CBD5E1" stopOpacity="0.65" />
              <stop offset="45%" stopColor="#64748B" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#1E293B" stopOpacity="0.85" />
            </linearGradient>
          </defs>

          {/* Calibrated Etched Scale Ticks */}
          {TICK_FRACTIONS.map((frac) => {
            const tickAngle = normalizedToAngleDeg(frac);
            const p1 = polarToCartesian(center, center, metrics.tickInner, tickAngle);
            const p2 = polarToCartesian(center, center, metrics.tickOuter, tickAngle);
            const isMajor = frac === 0 || frac === 0.5 || frac === 1;
            return (
              <line
                key={frac}
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                stroke={isMajor ? '#94A3B8' : '#3E4656'}
                strokeWidth={isMajor ? 1.35 : 0.9}
                strokeLinecap="round"
              />
            );
          })}

          {/* Track Background Arc */}
          <path
            d={trackArcPath}
            fill="none"
            stroke="#1E2430"
            strokeWidth={2.5}
            strokeLinecap="round"
          />

          {/* Illuminated Electric-Blue / Cyan Position Arc */}
          {activeArcPath && (
            <path
              d={activeArcPath}
              fill="none"
              stroke={disabled ? '#475569' : accentStroke}
              strokeWidth={2.75}
              strokeLinecap="round"
              style={{
                filter:
                  dragState.active && !disabled
                    ? `drop-shadow(0 0 3px ${accentGlow})`
                    : undefined,
              }}
            />
          )}

          {/* Outer Recessed Hardware Bezel Well */}
          <circle
            cx={center}
            cy={center}
            r={metrics.capR + 1.8}
            fill={`url(#well-${uid})`}
            stroke="#242936"
            strokeWidth={0.9}
          />

          {/* Metallic Silver Specular Chamfer & Dark Graphite Knob Cap */}
          <circle
            cx={center}
            cy={center}
            r={metrics.capR}
            fill={`url(#cap-${uid})`}
            stroke={`url(#rim-${uid})`}
            strokeWidth={1.15}
          />

          {/* Inner Brushed Lathe Groove */}
          <circle
            cx={center}
            cy={center}
            r={metrics.capR * 0.72}
            fill="none"
            stroke="rgba(203, 213, 225, 0.08)"
            strokeWidth={0.75}
          />

          {/* Illuminated Position Indicator Pointer */}
          <line
            x1={pointerInner.x}
            y1={pointerInner.y}
            x2={pointerOuter.x}
            y2={pointerOuter.y}
            stroke={disabled ? '#64748B' : accentTip}
            strokeWidth={size === 'xs' ? 1.8 : 2.1}
            strokeLinecap="round"
          />
          <circle
            cx={pointerOuter.x}
            cy={pointerOuter.y}
            r={size === 'xs' ? 1.15 : 1.4}
            fill={disabled ? '#64748B' : accentStroke}
          />
        </svg>
      </div>

      {/* Bottom Interactive Value Readout + Inline Numeric Entry */}
      <div className="flex items-center justify-center gap-1 max-w-full">
        <NumericInputBridge
          triggerCount={editTriggerCount}
          label={label}
          value={effectiveValue}
          min={min}
          max={max}
          step={step}
          defaultValue={resolvedDefault}
          unit={unit}
          scale={scale}
          precision={precision}
          signed={effectiveSigned}
          disabled={disabled}
          readOnly={readOnly}
          formatValue={formatValue}
          displayTextOverride={displayValueOverride}
          showStepButtons={showAdjustButtons}
          onChange={(v) => {
            onChange(v);
            onCommit?.(v);
          }}
        />
        {showDefaultResetButton && isInteractive && Math.abs(effectiveValue - resolvedDefault) > 1e-4 && (
          <button
            type="button"
            aria-label={`Reset ${label} to default`}
            title="Reset to default"
            onClick={handleReset}
            className="w-3.5 h-3.5 rounded-full bg-[#1B202C] border border-[#333B4D] text-[8px] text-[#94A3B8] hover:text-[#38BDF8] hover:border-[#38BDF8] flex items-center justify-center shrink-0"
          >
            ·
          </button>
        )}
      </div>
    </div>
  );
};

interface BridgeProps {
  triggerCount: number;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  unit: string;
  scale: ParameterScale;
  precision?: number;
  signed: boolean;
  disabled: boolean;
  readOnly: boolean;
  formatValue?: (value: number) => string;
  displayTextOverride?: string;
  showStepButtons: boolean;
  onChange: (nextValue: number) => void;
}

const NumericInputBridge: React.FC<BridgeProps> = ({ triggerCount, ...rest }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const prevTrigger = useRef(0);

  useEffect(() => {
    if (triggerCount > prevTrigger.current) {
      prevTrigger.current = triggerCount;
      const btn = containerRef.current?.querySelector('button[aria-label*="click to edit"]') as HTMLButtonElement | null;
      btn?.click();
    }
  }, [triggerCount]);

  return (
    <div ref={containerRef} className="inline-flex">
      <NumericParameterDisplay {...rest} compact />
    </div>
  );
};
