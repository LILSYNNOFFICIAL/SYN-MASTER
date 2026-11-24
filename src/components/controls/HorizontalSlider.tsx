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

export interface HorizontalSliderProps {
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
  accent?: ControlAccent;
  disabled?: boolean;
  readOnly?: boolean;
  precision?: number;
  formatValue?: (value: number) => string;
  showAdjustButtons?: boolean;
  compact?: boolean;
  hideHeaderLabel?: boolean;
  onChange: (nextValue: number) => void;
  testId?: string;
}

export const HorizontalSlider: React.FC<HorizontalSliderProps> = ({
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
  accent = 'gold',
  disabled = false,
  readOnly = false,
  precision,
  formatValue,
  showAdjustButtons = false,
  compact = false,
  hideHeaderLabel = false,
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
  const originRef = useRef<{ startX: number; startNorm: number; width: number } | null>(null);
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
        deltaPx: ev.clientX - originRef.current.startX,
        sensitivityPx: Math.max(100, originRef.current.width),
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
  }, [dragging, max, min, precision, scale, step]);

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

    const rect = e.currentTarget.getBoundingClientRect();
    const clickNorm = clampNumber((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const jumped = computeDragValue({
      startNormalized: clickNorm,
      deltaPx: 0,
      min,
      max,
      scale,
      step,
      precision,
    });
    originRef.current = { startX: e.clientX, startNorm: jumped.normalized, width: rect.width };
    setPreviewValue(jumped.value);
    setDragging(true);
    onChange(jumped.value);
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

  const accentHex = accent === 'gold' ? '#F5B82E' : '#38BDF8';
  const fillLeft = bipolar ? Math.min(norm, defaultNorm) * 100 : 0;
  const fillWidth = bipolar ? Math.abs(norm - defaultNorm) * 100 : norm * 100;

  return (
    <div
      data-testid={testId ?? `horizontal-slider-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      className={`flex flex-col ${compact ? 'gap-0.5' : 'gap-1'} min-w-0 ${disabled ? 'opacity-45' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        {!hideHeaderLabel && (
          <span className="text-[11px] font-medium text-[#9CA3AF] truncate">{label}</span>
        )}
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

      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-orientation="horizontal"
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
        className={`relative h-6 flex items-center touch-none rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F5B82E] ${
          isInteractive ? 'cursor-ew-resize' : 'cursor-default'
        }`}
      >
        {/* Recessed Track */}
        <div className="relative w-full h-1.5 rounded-full bg-[#07090D] border border-[#242936] overflow-hidden pointer-events-none">
          <div
            className="absolute top-0 bottom-0"
            style={{
              left: `${fillLeft}%`,
              width: `${fillWidth}%`,
              backgroundColor: accentHex,
              opacity: 0.85,
            }}
          />
        </div>

        {/* Center notch for bipolar sliders */}
        {bipolar && (
          <span className="absolute left-1/2 -translate-x-1/2 w-px h-3 bg-[#475569] pointer-events-none" />
        )}

        {/* Metallic Thumb */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-4 rounded-[2px] border border-[#64748B] shadow flex items-center justify-center pointer-events-none"
          style={{
            left: `${Math.max(4, Math.min(96, norm * 100))}%`,
            background: 'linear-gradient(180deg, #333A4A 0%, #1B202A 55%, #0D1016 100%)',
          }}
        >
          <span className="w-[1.5px] h-2.5 rounded-full" style={{ backgroundColor: accentHex }} />
        </div>
      </div>
    </div>
  );
};
