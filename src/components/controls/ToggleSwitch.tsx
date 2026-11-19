import React from 'react';
import type { ControlAccent } from './RotaryKnob';

export interface ToggleSwitchProps {
  label: string;
  checked: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  accent?: ControlAccent;
  compact?: boolean;
  onLabel?: string;
  offLabel?: string;
  onChange: (checked: boolean) => void;
  testId?: string;
}

export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  label,
  checked,
  disabled = false,
  readOnly = false,
  accent = 'cyan',
  compact = false,
  onLabel = 'ON',
  offLabel = 'OFF',
  onChange,
  testId,
}) => {
  const isInteractive = !disabled && !readOnly;
  const activeBg = accent === 'gold' ? 'bg-[#D4AF37]/25 border-[#F2CA52]/70' : 'bg-[#0EA5E9]/20 border-[#38BDF8]/70';
  const activeLed = accent === 'gold' ? 'bg-[#F2CA52]' : 'bg-[#38BDF8]';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      data-testid={testId ?? `toggle-switch-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      onClick={(e) => {
        e.stopPropagation();
        if (isInteractive) onChange(!checked);
      }}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.stopPropagation();
        }
      }}
      className={`inline-flex items-center justify-between gap-2 rounded border transition-colors min-h-[32px] ${
        compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs'
      } ${
        checked
          ? 'bg-[#121620] border-[#334155] text-[#F7F8FA]'
          : 'bg-[#0B0D12] border-[#222632] text-[#94A3B8]'
      } ${disabled ? 'opacity-45 cursor-not-allowed' : readOnly ? 'cursor-default' : 'cursor-pointer hover:border-[#475569]'} focus:outline-none focus-visible:ring-2 focus-visible:ring-[#38BDF8]`}
    >
      <span className="truncate font-medium">{label}</span>

      <span className="inline-flex items-center gap-1.5 shrink-0">
        <span className="text-[9px] font-mono-tabular uppercase tracking-wider text-[#94A3B8]">
          {checked ? onLabel : offLabel}
        </span>
        <span
          aria-hidden="true"
          className={`relative w-8 h-4 rounded-full border transition-colors flex items-center px-0.5 ${
            checked ? activeBg : 'bg-[#07090D] border-[#2C3140]'
          }`}
        >
          <span
            className={`w-2.5 h-2.5 rounded-full transition-transform duration-150 ${
              checked
                ? `translate-x-4 ${activeLed} shadow-[0_0_6px_rgba(56,189,248,0.5)]`
                : 'translate-x-0 bg-[#64748B]'
            }`}
          />
        </span>
      </span>
    </button>
  );
};
