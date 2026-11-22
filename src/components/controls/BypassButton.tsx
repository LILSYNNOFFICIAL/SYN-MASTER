import React from 'react';
import { Power } from 'lucide-react';
import type { ControlAccent } from './RotaryKnob';

export interface BypassButtonProps {
  active: boolean;
  label: string;
  compact?: boolean;
  showStateText?: boolean;
  accent?: ControlAccent;
  disabled?: boolean;
  onToggle: () => void;
  testId?: string;
}

export const BypassButton: React.FC<BypassButtonProps> = ({
  active,
  label,
  compact = false,
  showStateText = false,
  accent = 'cyan',
  disabled = false,
  onToggle,
  testId,
}) => {
  const activeStyle =
    accent === 'gold'
      ? 'bg-[#D4AF37]/15 border-[#F2CA52]/70 text-[#F2CA52]'
      : 'bg-[#0EA5E9]/15 border-[#38BDF8]/70 text-[#38BDF8]';

  const ledColor =
    accent === 'gold'
      ? active
        ? 'bg-[#F2CA52]'
        : 'bg-[#475569]'
      : active
        ? 'bg-[#38BDF8]'
        : 'bg-[#475569]';

  return (
    <button
      type="button"
      aria-pressed={!active}
      aria-label={label}
      disabled={disabled}
      data-testid={testId ?? `bypass-btn-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onToggle();
      }}
      className={`inline-flex items-center justify-center gap-1.5 rounded border transition-colors shrink-0 ${
        compact ? 'px-1.5 py-1 text-[10px] min-h-[26px]' : 'px-2.5 py-1 text-[11px] min-h-[30px]'
      } ${
        active
          ? activeStyle
          : 'bg-[#12141B] border-[#2A2F3D] text-[#64748B] hover:text-[#94A3B8] hover:border-[#3E4558]'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'} focus:outline-none focus-visible:ring-2 focus-visible:ring-[#38BDF8]`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${ledColor}`} aria-hidden="true" />
      <Power className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
      {showStateText && (
        <span className="font-mono-tabular font-semibold uppercase tracking-wide whitespace-nowrap">
          {active ? 'Active' : 'Bypass'}
        </span>
      )}
    </button>
  );
};
