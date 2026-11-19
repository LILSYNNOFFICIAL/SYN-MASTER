import React, { useEffect, useRef, useState } from 'react';
import {
  clampNumber,
  computeDragValue,
  computeKeyStepValue,
  formatParameterValue,
  valueToNormalized,
  type ParameterScale,
} from './parameterMath';
import { NumericParameterDisplay } from './NumericParameterDisplay';
import type { ControlAccent } from './RotaryKnob';

export interface VerticalFaderProps {
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
  heightPx?: number;
  accent?: ControlAccent;
  disabled?: boolean;
  readOnly?: boolean;
  precision?: number;
  formatValue?: (value: number) => string;
  showAdjustButtons?: boolean;
  onChange: (nextValue: number) => void;
  testId?: string;
}

export const VerticalFader: React.FC<VerticalFaderProps> = ({
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
  heightPx = 112,
  accent = 'cyan',
  disabled = false,
  readOnly = false,
  precision,
  formatValue,
  showAdjustButtons = false,
  onChange,
  testId,
}) => {
  const resolvedDefault = clampNumber(
    defaultValue !== undefined ? defaultValue : bipolar ? (min + max) / 2 : min,
    min,
    max,
  );
  const safeValue = clampNumber(value, min, max, resolvedDefault);
  const [dragging, setDragging] = useState(false);
  const [previewValue, setPreviewValue] = useState(safeValue);

  const originRef = useRef<{ startY: number; startNorm: number } | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const effectiveVal = dragging ? previewValue : safeValue;
  const norm = valueToNormalized(effectiveVal, min, max, scale);
  const defaultNorm = valueToNormalized(resolvedDefault, min, max, scale);
  const isInteractive = !disabled && !readOnly;
  const effectiveSigned = signed ?? (bipolar || (min < 0 && max > 0));
  const formatted = formatParameterValue(effectiveVal, {
    unit,
    step,
    precision,
    signed: effectiveSigned,
    formatValue,
  });

  useEffect(() => {
    if (!dragging) return;
    const onMove = (ev: PointerEvent) => {
      if (!originRef.current) return;
      const res = computeDragValue({
        startNormalized: originRef.current.startNorm,
        deltaPx: originRef.current.startY - ev.clientY,
        sensitivityPx: Math.max(72, heightPx - 20),
        fine: ev.shiftKey,
        min,
        max,
        scale,
        step,
        precision,
      });
      setPreviewValue(res.value);
      onChangeRef.current(res.value);
    };
    const onUp = () => {
      originRef.current = null;
      setDragging(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, heightPx, max, min, precision, scale, step]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isInteractive) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    e.stopPropagation();
    trackRef.current?.focus({ preventScroll: true });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    // Allow clicking directly on the fader slot to jump smoothly, then drag relative from there
    const rect = e.currentTarget.getBoundingClientRect();
    const clickNorm = clampNumber(1 - (e.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
    const jumpedVal = computeDragValue({
      startNormalized: clickNorm,
      deltaPx: 0,
      min,
      max,
      scale,
      step,
      precision,
    });
    originRef.current = { startY: e.clientY, startNorm: jumpedVal.normalized };
    setPreviewValue(jumpedVal.value);
    setDragging(true);
    onChange(jumpedVal.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isInteractive) return;
    if (e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      onChange(resolvedDefault);
      return;
    }
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
    }
  };

  const accentHex = accent === 'gold' ? '#F2CA52' : '#38BDF8';
  const bottomPct = norm * 100;
  const fillBottom = bipolar ? Math.min(norm, defaultNorm) * 100 : 0;
  const fillHeight = bipolar ? Math.abs(norm - defaultNorm) * 100 : bottomPct;

  return (
    <div
      data-testid={testId ?? `vertical-fader-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      className={`flex flex-col items-center gap-1.5 select-none ${disabled ? 'opacity-45' : ''}`}
    >
      <span className="text-[10px] font-semibold tracking-wide text-[#B4BCC8] truncate max-w-full">
        {label}
      </span>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-orientation="vertical"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(effectiveVal.toFixed(4))}
        aria-valuetext={formatted}
        aria-disabled={disabled || undefined}
        aria-readonly={readOnly || undefined}
        onPointerDown={handlePointerDown}
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isInteractive) onChange(resolvedDefault);
        }}
        onKeyDown={handleKeyDown}
        className={`relative w-11 flex items-center justify-center touch-none rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-[#38BDF8] ${
          isInteractive ? 'cursor-ns-resize' : 'cursor-default'
        }`}
        style={{ height: heightPx }}
      >
        {/* Calibration Scale Ticks */}
        <div className="absolute inset-y-2 left-1 flex flex-col justify-between pointer-events-none">
          {[0, 1, 2, 3, 4].map((t) => (
            <span
              key={t}
              className={`block h-px ${t === 0 || t === 2 || t === 4 ? 'w-2 bg-[#64748B]' : 'w-1.5 bg-[#334155]'}`}
            />
          ))}
        </div>

        {/* Recessed Fader Slot */}
        <div className="relative w-1.5 h-[calc(100%-14px)] rounded-full bg-[#07090D] border border-[#242936] overflow-hidden pointer-events-none">
          <div
            className="absolute left-0 right-0 transition-[height,bottom] duration-75"
            style={{
              bottom: `${fillBottom}%`,
              height: `${fillHeight}%`,
              backgroundColor: accentHex,
              opacity: 0.78,
            }}
          />
        </div>

        {/* Sculpted Brushed Silver / Graphite Fader Cap */}
        <div
          className="absolute left-1/2 -translate-x-1/2 w-7 h-4 rounded-[2px] border border-[#475569] shadow-md flex items-center justify-center pointer-events-none"
          style={{
            bottom: `calc(${Math.max(4, Math.min(96, bottomPct))}% - 8px)`,
            background: 'linear-gradient(180deg, #333A4A 0%, #1B202A 50%, #0E1117 100%)',
          }}
        >
          <span
            className="w-5 h-[2px] rounded-full"
            style={{ backgroundColor: accentHex }}
          />
        </div>
      </div>

      <NumericParameterDisplay
        label={label}
        value={effectiveVal}
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
        showStepButtons={showAdjustButtons}
        compact
        onChange={onChange}
      />
    </div>
  );
};
