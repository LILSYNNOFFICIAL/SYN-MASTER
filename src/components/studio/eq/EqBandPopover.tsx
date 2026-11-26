import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, Power, X } from 'lucide-react';

interface PopoverProps {
  /** Node position in the plot, 0..1 from the left / top. */
  anchorX: number;
  anchorY: number;
  color: string;
  title: string;
  enabled: boolean;
  solo: boolean;
  onToggleEnabled: () => void;
  onToggleSolo: () => void;
  onDelete: () => void;
  onClose: () => void;
  typeMenu: React.ReactNode;
  /** Right-hand section beside the type row (dynamic EQ threshold meter). */
  side?: React.ReactNode;
  /** Expanded (advanced) settings, behind the ▸ button. */
  advanced?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Ozone-style per-band popover: power / S (solo, listen) / X (delete) rail, Type menu,
 * numeric fields, optional side section and an expandable advanced panel. Positioned next
 * to its node and kept inside the plot; on narrow screens it docks under the graph.
 */
export const EqBandPopover: React.FC<PopoverProps> = ({
  anchorX, anchorY, color, title, enabled, solo, onToggleEnabled, onToggleSolo, onDelete, onClose, typeMenu, side, advanced, children,
}) => {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('[role="menu"]')) {
        e.stopPropagation();
        onClose();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Beside the node (30 px y-axis gutter), and vertically clamped inside the plot once measured.
  const right = anchorX > 0.5;
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host || getComputedStyle(el).position !== 'absolute') {
      setTop(null);
      return;
    }
    const plotH = host.clientHeight - 18;
    const popH = el.offsetHeight;
    const nodeY = anchorY * plotH;
    const want = anchorY < 0.45 ? nodeY - 24 : nodeY - popH + 24;
    setTop(Math.max(0, Math.min(want, plotH - popH)));
  }, [anchorY, expanded, children]);
  const style: React.CSSProperties & Record<string, string> = {
    ['--band-color']: color,
    ...(right
      ? { right: `calc((100% - 30px) * ${(1 - anchorX).toFixed(4)} + 16px)` }
      : { left: `calc(30px + (100% - 30px) * ${anchorX.toFixed(4)} + 16px)` }),
    top: top === null ? '0px' : `${top}px`,
  };
  return (
    <div ref={ref} className="syn-eqx-pop" style={style} role="dialog" aria-label={title} data-expanded={expanded ? 'true' : 'false'}>
      <div className="syn-eqx-pop-rail">
        <button type="button" className={`syn-eqx-rail-btn is-power${enabled ? ' is-on' : ''}`} aria-pressed={enabled} aria-label={enabled ? `Disable ${title}` : `Enable ${title}`} onClick={onToggleEnabled}>
          <Power className="w-3.5 h-3.5" />
        </button>
        <button type="button" className={`syn-eqx-rail-btn is-solo${solo ? ' is-on' : ''}`} aria-pressed={solo} aria-label={solo ? `Stop listening to ${title}` : `Listen to ${title} (solo)`} title="Solo / listen (preview only, never exported)" onClick={onToggleSolo}>
          S
        </button>
        <button type="button" className="syn-eqx-rail-btn is-del" aria-label={`Delete ${title}`} onClick={onDelete}>
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="syn-eqx-pop-body">
        <div className="syn-eqx-pop-top">
          {typeMenu}
          <button type="button" className="syn-eqx-pop-close" aria-label="Close band settings" onClick={onClose}>×</button>
        </div>
        <div className="syn-eqx-pop-fields">{children}</div>
        {expanded && advanced && <div className="syn-eqx-pop-adv">{advanced}</div>}
      </div>
      {side && <div className="syn-eqx-pop-side">{side}</div>}
      {advanced && (
        <button type="button" className="syn-eqx-pop-more" aria-expanded={expanded} aria-label={expanded ? 'Fewer settings' : 'More settings'} onClick={() => setExpanded((v) => !v)}>
          <ChevronRight className="w-4 h-4" />
        </button>
      )}
    </div>
  );
};

interface NumFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  /** Logarithmic drag (frequency, Q, ratio). */
  log?: boolean;
  decimals?: number;
  disabled?: boolean;
  hint?: string;
  onChange: (v: number, phase: 'move' | 'end') => void;
}

/** Numeric entry with drag-to-change on the label (up = more, Shift = fine). */
export const NumField: React.FC<NumFieldProps> = ({ label, value, min, max, step, unit, log, decimals = 1, disabled, hint, onChange }) => {
  const [text, setText] = useState<string | null>(null);
  const drag = useRef<{ y: number; v: number; last: number } | null>(null);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const commitText = () => {
    if (text === null) return;
    const raw = text.trim().toLowerCase();
    let v = parseFloat(raw);
    if (/k\s*(hz)?$/.test(raw)) v *= 1000;
    setText(null);
    if (Number.isFinite(v)) onChange(Number(clamp(v).toFixed(decimals)), 'end');
  };
  return (
    <label className={`syn-eqx-num${disabled ? ' is-disabled' : ''}`}>
      <span
        className="syn-eqx-num-label"
        onPointerDown={(e) => {
          if (disabled) return;
          e.preventDefault();
          (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
          drag.current = { y: e.clientY, v: value, last: value };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dy = (d.y - e.clientY) * (e.shiftKey ? 0.2 : 1);
          const v = log ? d.v * Math.pow(max / min, dy / 400) : d.v + (dy / 200) * (max - min);
          d.last = Number(clamp(Math.round(v / step) * step).toFixed(decimals));
          onChange(d.last, 'move');
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d) onChange(d.last, 'end');
        }}
        title={hint ?? 'Drag up/down or type a value'}
      >
        {label}
      </span>
      <input
        type="text"
        inputMode="decimal"
        disabled={disabled}
        value={text ?? `${value.toFixed(decimals)}`}
        aria-label={`${label}${unit ? ` (${unit})` : ''}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitText();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const dir = e.key === 'ArrowUp' ? 1 : -1;
            const next = log ? value * Math.pow(e.shiftKey ? 1.01 : 1.06, dir) : value + dir * step * (e.shiftKey ? 1 : 5);
            onChange(Number(clamp(next).toFixed(decimals)), 'end');
          }
        }}
      />
      {unit && <span className="syn-eqx-num-unit">{unit}</span>}
    </label>
  );
};

export const SelField: React.FC<{ label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void; disabled?: boolean }> = ({ label, value, options, onChange, disabled }) => (
  <label className="syn-eqx-num syn-eqx-sel">
    <span className="syn-eqx-num-label">{label}</span>
    <select value={value} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </label>
);
