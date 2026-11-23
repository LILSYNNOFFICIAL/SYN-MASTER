import React, { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import {
  clampNumber,
  computeKeyStepValue,
  formatParameterValue,
  parseNumericEntry,
  type ParameterScale,
} from './parameterMath';

export interface NumericParameterDisplayProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  unit?: string;
  scale?: ParameterScale;
  precision?: number;
  signed?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  formatValue?: (value: number) => string;
  displayTextOverride?: string;
  showStepButtons?: boolean;
  compact?: boolean;
  onChange: (nextValue: number) => void;
  testId?: string;
}

export const NumericParameterDisplay: React.FC<NumericParameterDisplayProps> = ({
  label,
  value,
  min,
  max,
  step = 0.1,
  defaultValue,
  unit = '',
  scale = 'linear',
  precision,
  signed = false,
  disabled = false,
  readOnly = false,
  formatValue,
  displayTextOverride,
  showStepButtons = false,
  compact = false,
  onChange,
  testId,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const safeVal = clampNumber(value, min, max, defaultValue ?? min);
  const formatted =
    displayTextOverride && displayTextOverride.trim().length > 0
      ? displayTextOverride
      : formatParameterValue(safeVal, { unit, step, precision, signed, formatValue });

  const canEdit = !disabled && !readOnly;

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const isNormalizedOverride = Boolean(displayTextOverride) && min === 0 && max === 1;

  const startEdit = () => {
    if (!canEdit) return;
    const rawNum = isNormalizedOverride
      ? String(Number(safeVal.toFixed(3)))
      : unit.trim().toLowerCase() === 'hz' && Math.abs(safeVal) >= 1000
        ? String(Number(safeVal.toFixed(1)))
        : formatParameterValue(safeVal, { unit: '', step, precision, signed: false });
    setDraft(rawNum);
    setEditing(true);
  };

  const commitEdit = () => {
    if (!editing) return;
    const parsed = parseNumericEntry(draft, min, max, step, unit, precision, isNormalizedOverride);
    setEditing(false);
    if (parsed !== null && parsed !== safeVal) {
      onChange(parsed);
    }
  };

  const handleStep = (dir: -1 | 1, shiftKey = false) => {
    if (!canEdit) return;
    const next = computeKeyStepValue({
      currentValue: safeVal,
      key: dir > 0 ? 'ArrowUp' : 'ArrowDown',
      shiftKey,
      min,
      max,
      scale,
      step,
      precision,
      defaultValue,
    });
    if (next !== null && next !== safeVal) {
      onChange(next);
    }
  };

  return (
    <div
      data-testid={testId}
      className={`inline-flex items-center gap-0.5 max-w-full ${
        disabled ? 'opacity-45' : ''
      }`}
    >
      {showStepButtons && canEdit && (
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={(e) => handleStep(-1, e.shiftKey)}
          className="w-5 h-5 rounded-sm bg-[#141720] border border-[#2B303E] text-[#94A3B8] hover:text-[#38BDF8] hover:border-[#38BDF8]/60 flex items-center justify-center transition-colors shrink-0"
        >
          <Minus className="w-2.5 h-2.5" />
        </button>
      )}

      {editing ? (
        <input
          ref={inputRef}
          type="text"
          aria-label={`Enter ${label} value`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              commitEdit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setEditing(false);
            }
          }}
          className={`bg-[#07090D] border border-[#38BDF8] rounded-sm px-1.5 text-center font-mono-tabular text-[#F7F8FA] focus:outline-none ${
            compact ? 'w-14 py-0 text-[10px]' : 'w-16 py-0.5 text-[11px]'
          }`}
        />
      ) : (
        <button
          type="button"
          disabled={!canEdit}
          aria-label={`${label} readout ${formatted}${canEdit ? ', click to edit value' : ''}`}
          title={canEdit ? `${formatted} (click to enter value)` : formatted}
          onClick={startEdit}
          className={`rounded-sm font-mono-tabular tabular-nums transition-colors truncate ${
            compact ? 'px-1 py-0 text-[10px]' : 'px-1.5 py-0.5 text-[11px]'
          } ${
            canEdit
              ? 'bg-[#0C0E14] border border-[#252A36] text-[#E2E8F0] hover:border-[#38BDF8]/60 hover:text-[#38BDF8] cursor-text'
              : 'bg-[#0B0D12] border border-[#1E222D] text-[#94A3B8] cursor-default'
          }`}
        >
          {formatted}
        </button>
      )}

      {showStepButtons && canEdit && (
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={(e) => handleStep(1, e.shiftKey)}
          className="w-5 h-5 rounded-sm bg-[#141720] border border-[#2B303E] text-[#94A3B8] hover:text-[#38BDF8] hover:border-[#38BDF8]/60 flex items-center justify-center transition-colors shrink-0"
        >
          <Plus className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  );
};
