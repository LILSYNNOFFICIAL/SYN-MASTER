import React, { useRef } from 'react';
import { clampView, fullView, isFullView, minViewSpan, panBy, type TimeView } from './waveformView';

interface Props {
  view: TimeView;
  durationSec: number;
  onChange: (next: TimeView) => void;
}

type DragKind = 'move' | 'left' | 'right';

/**
 * FL Studio style horizontal zoom/scroll bar for the waveform timeline: drag the handle to
 * pan, drag its edges to zoom, click the track to jump, double-click to show the whole track.
 */
export const WaveformZoomBar: React.FC<Props> = ({ view, durationSec, onChange }) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<null | { kind: DragKind; x0: number; view: TimeView; width: number }>(null);
  if (!(durationSec > 0)) return null;
  const span = view.end - view.start;
  const left = (view.start / durationSec) * 100;
  const width = (span / durationSec) * 100;
  const zoom = durationSec / Math.max(1e-9, span);

  const begin = (kind: DragKind) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    dragRef.current = { kind, x0: e.clientX, view, width: rect.width };
    trackRef.current?.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dSec = ((e.clientX - d.x0) / d.width) * durationSec;
    const minSpan = minViewSpan(durationSec);
    if (d.kind === 'move') onChange(panBy(d.view, dSec, durationSec));
    else if (d.kind === 'left') onChange(clampView({ start: Math.min(d.view.end - minSpan, Math.max(0, d.view.start + dSec)), end: d.view.end }, durationSec));
    else onChange(clampView({ start: d.view.start, end: Math.max(d.view.start + minSpan, Math.min(durationSec, d.view.end + dSec)) }, durationSec));
  };

  const end = () => { dragRef.current = null; };

  const onTrackDown = (e: React.PointerEvent) => {
    if (e.target !== trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const sec = ((e.clientX - rect.left) / rect.width) * durationSec;
    onChange(clampView({ start: sec - span / 2, end: sec + span / 2 }, durationSec));
  };

  const onKey = (e: React.KeyboardEvent) => {
    const stepSec = span * (e.shiftKey ? 0.5 : 0.1);
    let next: TimeView | null = null;
    if (e.key === 'ArrowLeft') next = panBy(view, -stepSec, durationSec);
    else if (e.key === 'ArrowRight') next = panBy(view, stepSec, durationSec);
    else if (e.key === '+' || e.key === '=') {
      const c = (view.start + view.end) / 2;
      const s = Math.max(minViewSpan(durationSec), span / 1.5);
      next = clampView({ start: c - s / 2, end: c + s / 2 }, durationSec);
    } else if (e.key === '-') {
      const c = (view.start + view.end) / 2;
      const s = Math.min(durationSec, span * 1.5);
      next = clampView({ start: c - s / 2, end: c + s / 2 }, durationSec);
    } else if (e.key === '0' || e.key === 'Home' || e.key === 'Escape') next = fullView(durationSec);
    if (next) {
      e.preventDefault();
      onChange(next);
    }
  };

  return (
    <div className="syn-wfzoom" data-zoomed={isFullView(view, durationSec) ? 'false' : 'true'}>
      <div
        ref={trackRef}
        className="syn-wfzoom-track"
        role="scrollbar"
        aria-orientation="horizontal"
        aria-label="Waveform zoom and scroll. Drag to scroll, drag the edges to zoom, double-click to show the whole track. Ctrl + mouse wheel or pinch zooms the waveform."
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(durationSec - span > 0 ? (view.start / (durationSec - span)) * 100 : 0)}
        aria-valuetext={`${zoom.toFixed(1)}x zoom, showing ${view.start.toFixed(1)} to ${view.end.toFixed(1)} seconds`}
        tabIndex={0}
        onKeyDown={onKey}
        onPointerDown={onTrackDown}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => onChange(fullView(durationSec))}
      >
        <div className="syn-wfzoom-handle" style={{ left: `${left}%`, width: `${width}%` }} onPointerDown={begin('move')}>
          <span className="syn-wfzoom-grip is-left" onPointerDown={begin('left')} aria-hidden="true" />
          <span className="syn-wfzoom-grip is-right" onPointerDown={begin('right')} aria-hidden="true" />
        </div>
      </div>
      <span className="syn-wfzoom-readout" aria-hidden="true">{zoom < 9.95 ? zoom.toFixed(1) : Math.round(zoom)}×</span>
    </div>
  );
};
