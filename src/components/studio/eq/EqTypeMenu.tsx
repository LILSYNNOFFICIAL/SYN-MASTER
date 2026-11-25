import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { CurveIcon } from './CurveIcon';
import { Portal } from '../../../ui/Portal';

export interface TypeMenuOption {
  value: string;
  label: string;
  icon: string;
  children?: TypeMenuOption[];
}

interface Props {
  /** Shown on the closed button (current type). */
  label: string;
  icon: string;
  options: TypeMenuOption[];
  /** `parent` is the family when a subtype was chosen from a submenu. */
  onSelect: (value: string, parent?: string) => void;
  ariaLabel: string;
  /** Currently active family / subtype values, highlighted in the menus. */
  activeParent?: string;
  activeValue?: string;
}

/**
 * Ozone-style Type dropdown with cascading subtype menus and curve icons.
 * Mouse: hover a family to open its submenu. Keyboard: Up/Down move, Right/Enter open a
 * submenu, Left closes it, Enter selects, Esc closes. Narrow screens show the submenu inline.
 */
export const EqTypeMenu: React.FC<Props> = ({ label, icon, options, onSelect, ariaLabel, activeParent, activeValue }) => {
  const uid = useId().replace(/:/g, '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [sub, setSub] = useState<number | null>(null);
  const [subActive, setSubActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [pos, setPos] = useState<{ top: number; left: number; flip: boolean; narrow: boolean } | null>(null);
  const hoverTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) close(false);
    };
    // The menu is portalled (fixed) so no panel stacking context can clip it; keep it on the button.
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      const narrow = vw <= 640;
      const menuW = 200;
      const left = Math.max(4, Math.min(r.left, vw - menuW - 4));
      setPos({ top: r.bottom + 2, left, flip: !narrow && left + menuW + 190 > vw, narrow });
    };
    place();
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    };
  }, [open]);

  useEffect(() => {
    if (open && pos) menuRef.current?.focus({ preventScroll: true });
  }, [open, pos !== null]);

  const close = (refocus = true) => {
    setOpen(false);
    setSub(null);
    if (refocus) btnRef.current?.focus();
  };

  const choose = (i: number, j?: number) => {
    const o = options[i];
    if (j !== undefined && o.children) onSelect(o.children[j].value, o.value);
    else if (!o.children) onSelect(o.value);
    else {
      setSub(i);
      setSubActive(0);
      return;
    }
    close();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const inSub = sub !== null;
    const list = inSub ? options[sub!].children! : options;
    const idx = inSub ? subActive : active;
    const set = inSub ? setSubActive : setActive;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        set((idx + 1) % list.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        set((idx - 1 + list.length) % list.length);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (!inSub && options[active].children) {
          setSub(active);
          setSubActive(0);
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (inSub) setSub(null);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (inSub) choose(sub!, subActive);
        else choose(active);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (inSub) setSub(null);
        else close();
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  return (
    <div className="syn-eqx-type" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className="syn-eqx-type-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${uid}-menu`}
        aria-label={`${ariaLabel}: ${label}`}
        onClick={() => {
          setOpen((v) => !v);
          setSub(null);
          setActive(Math.max(0, options.findIndex((o) => o.value === activeParent || o.value === activeValue)));
        }}
      >
        <CurveIcon kind={icon} />
        <span>{label}</span>
        <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
      {open && pos && (
        <Portal>
        <div
          ref={menuRef}
          id={`${uid}-menu`}
          role="menu"
          tabIndex={-1}
          aria-label={ariaLabel}
          style={{ position: 'fixed', top: pos.top, left: pos.left, maxHeight: `calc(100vh - ${Math.round(pos.top) + 8}px)` }}
          className={`syn-eqx-menu${pos.flip ? ' is-flip' : ''}${pos.narrow ? ' is-narrow' : ''}`}
          onKeyDown={onKey}
          aria-activedescendant={sub !== null ? `${uid}-s${sub}-${subActive}` : `${uid}-o${active}`}
        >
          {options.map((o, i) => (
            <div key={o.value} className="syn-eqx-menu-row">
              <div
                id={`${uid}-o${i}`}
                role="menuitem"
                aria-haspopup={o.children ? 'menu' : undefined}
                aria-expanded={o.children ? sub === i : undefined}
                className={`syn-eqx-menu-item${active === i && sub === null ? ' is-active' : ''}${sub === i ? ' is-open' : ''}${activeParent === o.value || (!o.children && activeValue === o.value) ? ' is-current' : ''}`}
                onPointerEnter={(e) => {
                  setActive(i);
                  if (e.pointerType !== 'mouse') return;
                  // Hover intent: a short delay lets the pointer travel diagonally into an open submenu.
                  if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
                  hoverTimer.current = window.setTimeout(() => setSub(o.children ? i : null), sub === null ? 0 : 160);
                }}
                onClick={() => (o.children ? setSub(sub === i ? null : i) : choose(i))}
              >
                <CurveIcon kind={o.icon} />
                <span>{o.label}</span>
                {o.children && <ChevronRight className="w-3.5 h-3.5 syn-eqx-menu-caret" aria-hidden="true" />}
              </div>
              {o.children && sub === i && (
                <div role="menu" aria-label={`${o.label} types`} className="syn-eqx-submenu"
                  onPointerEnter={() => { if (hoverTimer.current) window.clearTimeout(hoverTimer.current); }}>
                  {o.children.map((c, j) => (
                    <div
                      key={c.value}
                      id={`${uid}-s${i}-${j}`}
                      role="menuitemradio"
                      aria-checked={activeParent === o.value && activeValue === c.value}
                      className={`syn-eqx-menu-item${subActive === j ? ' is-active' : ''}${activeParent === o.value && activeValue === c.value ? ' is-current' : ''}`}
                      onPointerEnter={() => setSubActive(j)}
                      onClick={() => choose(i, j)}
                    >
                      <CurveIcon kind={c.icon} />
                      <span>{c.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        </Portal>
      )}
    </div>
  );
};
