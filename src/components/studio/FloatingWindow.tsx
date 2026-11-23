import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, X, Maximize2 } from 'lucide-react';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  id: string;
  title: React.ReactNode;
  open: boolean;
  onClose: () => void;
  initial?: Partial<Rect>;
  minW?: number;
  minH?: number;
  children: React.ReactNode;
  headerExtra?: React.ReactNode;
}

function clampRect(r: Rect, minW: number, minH: number): Rect {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const w = Math.max(minW, Math.min(vw - 8, r.w));
  const h = Math.max(minH, Math.min(vh - 8, r.h));
  return { w, h, x: Math.max(4 - w + 120, Math.min(vw - 120, r.x)), y: Math.max(4, Math.min(vh - 40, r.y)) };
}

/**
 * Floating, draggable (by its title bar) and resizable (bottom-right grip and right/bottom
 * edges) window. Position and size persist per window id in localStorage.
 */
export const FloatingWindow: React.FC<Props> = ({ id, title, open, onClose, initial, minW = 320, minH = 240, children, headerExtra }) => {
  const storageKey = `syn2.window.${id}`;
  const [rect, setRect] = useState<Rect>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Rect | null;
      if (saved && typeof saved.x === 'number') return clampRect(saved, minW, minH);
    } catch {
      /* ignore */
    }
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    return clampRect({ x: initial?.x ?? vw - 560, y: initial?.y ?? 90, w: initial?.w ?? 520, h: initial?.h ?? 640 }, minW, minH);
  });
  const [minimized, setMinimized] = useState(false);
  const dragRef = useRef<null | { mode: 'move' | 'resize' | 'resize-x' | 'resize-y'; sx: number; sy: number; start: Rect }>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(rect));
    } catch {
      /* ignore */
    }
  }, [rect, storageKey]);

  useEffect(() => {
    const onResize = () => setRect((r) => clampRect(r, minW, minH));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [minW, minH]);

  const begin = (mode: 'move' | 'resize' | 'resize-x' | 'resize-y') => (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button,select,input') && mode === 'move') return;
    e.preventDefault();
    dragRef.current = { mode, sx: e.clientX, sy: e.clientY, start: rect };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const move = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      const s = d.start;
      if (d.mode === 'move') setRect(clampRect({ ...s, x: s.x + dx, y: s.y + dy }, minW, minH));
      else if (d.mode === 'resize') setRect(clampRect({ ...s, w: s.w + dx, h: s.h + dy }, minW, minH));
      else if (d.mode === 'resize-x') setRect(clampRect({ ...s, w: s.w + dx }, minW, minH));
      else setRect(clampRect({ ...s, h: s.h + dy }, minW, minH));
    },
    [minW, minH],
  );
  const end = () => {
    dragRef.current = null;
  };

  if (!open) return null;
  return (
    <div
      className="syn2-float"
      role="dialog"
      aria-label={typeof title === 'string' ? title : id}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: minimized ? 'auto' : rect.h }}
    >
      <div className="syn2-float-head" onPointerDown={begin('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <div className="syn2-float-grip" aria-hidden="true">⋮⋮</div>
        <div className="syn2-float-title">{title}</div>
        <div className="syn2-float-extra">{headerExtra}</div>
        <button type="button" aria-label={minimized ? 'Restore window' : 'Minimize window'} onClick={() => setMinimized((m) => !m)}>
          {minimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
        </button>
        <button type="button" aria-label="Close window" onClick={onClose}>
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {!minimized && (
        <>
          <div className="syn2-float-body">{children}</div>
          <div className="syn2-float-edge-r" onPointerDown={begin('resize-x')} onPointerMove={move} onPointerUp={end} aria-hidden="true" />
          <div className="syn2-float-edge-b" onPointerDown={begin('resize-y')} onPointerMove={move} onPointerUp={end} aria-hidden="true" />
          <div className="syn2-float-resize" onPointerDown={begin('resize')} onPointerMove={move} onPointerUp={end} aria-label="Resize window" />
        </>
      )}
    </div>
  );
};
