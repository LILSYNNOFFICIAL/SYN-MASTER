import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AudioAnalysis } from '../../../types/mastering';
import { qEdgeRatio, qFromEdgeRatio } from '../../../dsp/eqDesign';
import { telemetryStore } from '../../../engine/telemetryStore';
import type { FadeSettings } from '../../../dsp/fades';
import { blanketPathFromEnvelope, clampView, envelopeFromGlobalPeaks, fadeGainAt, fadeGeometry, fullView, isFullView, panBy, secToX, wheelPixels, wheelZoomFactor, xToSec, zoomAround, type TimeView } from './waveformView';
import { getWaveformSource } from './waveformSource';
// Split out of the main chunk (bundle budget): the zoom bar and the waveform styles load on demand.
const WaveformZoomBar = React.lazy(() => import('./WaveformZoomBar').then((m) => ({ default: m.WaveformZoomBar })));
// Neon frequency fill, loudness tint and fade labels also load on demand.
const Layer = React.lazy(() => import('./waveformLayers'));
import { F_MAX, F_MIN, G_MAX, H, W, clampF, clampG, curvePath, fToX, fmtF, gToY, xToF, yToG } from './graphMath';

export interface EqGraphNode {
  id: string;
  freq: number;
  /** Where the node is drawn (dB). */
  yDb: number;
  q: number;
  enabled: boolean;
  color: string;
  /** Short label inside the node (band number). */
  label: string;
  /** Accessible description. */
  description: string;
  /** What vertical dragging edits. */
  yMode: 'gain' | 'q' | 'none';
  /** Draw Q handles at the bandwidth edges when selected. */
  showQ: boolean;
  /** Soloed (listen) band. */
  solo?: boolean;
}

export interface EqGraphCurves {
  freqs: number[];
  main: number[];
  /** Extra channel curves (side / left / right), drawn dashed. */
  extras?: Array<{ key: string; label: string; values: number[]; color: string }>;
  /** Per-band contribution, filled faintly (selected band brighter). */
  perBand?: Array<number[] | null>;
  /** Live (dynamic) curve, drawn over the static one. */
  live?: number[] | null;
  /** Extra spectra in gain units on their own frequency grid (Match EQ source / reference). */
  spectra?: Array<{ key: string; freqs: readonly number[]; values: number[]; color: string; fill?: boolean }>;
}

export type AnalyzerMode = 'off' | 'pre' | 'post' | 'both';

interface Props {
  nodes: EqGraphNode[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** `phase` 'move' = live drag preview, 'end' = commit (one undo step per gesture). */
  onNodeChange: (id: string, patch: { freq?: number; yDb?: number; q?: number }, phase: 'move' | 'end') => void;
  onAdd?: (freq: number, gainDb: number) => void;
  onDelete?: (id: string) => void;
  onResetGain?: (id: string) => void;
  onToggleSolo?: (id: string) => void;
  curves: EqGraphCurves;
  preSpectrum?: AudioAnalysis | null;
  postSpectrum?: AudioAnalysis | null;
  analyzer?: AnalyzerMode;
  /** Optional glowing waveform blanket (console). */
  waveformPeaks?: number[] | null;
  durationSec?: number;
  /** Seek the shared track timeline by clicking or dragging the waveform layer. */
  onSeek?: (sec: number) => void;
  /** Fade curves and handles layered directly over the existing waveform blanket. */
  fades?: FadeSettings;
  onFadesChange?: React.Dispatch<React.SetStateAction<FadeSettings>>;
  ariaLabel: string;
  /** Popover rendered over the plot. */
  children?: React.ReactNode;
  className?: string;
}

const GRID_F = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

/** Convert a pointer's horizontal position into the shared linear track-time coordinate. */
export function timelineSecondsFromPointer(clientX: number, left: number, width: number, durationSec: number, view?: TimeView): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0 || !Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const start = view ? view.start : 0;
  const span = view ? view.end - view.start : durationSec;
  return Math.max(0, Math.min(durationSec, start + ((clientX - left) / width) * span));
}

function spectrumPath(a: AudioAnalysis | null | undefined, closed: boolean): string | null {
  if (!a || !a.spectrumBinsFreq?.length) return null;
  const fs = a.spectrumBinsFreq;
  const ds = a.spectrumBinsDb;
  let max = -Infinity;
  for (const d of ds) if (d > max) max = d;
  let path = closed ? `M0,${H}` : '';
  let first = true;
  for (let i = 0; i < fs.length; i++) {
    if (fs[i] < F_MIN || fs[i] > F_MAX) continue;
    const y = H - Math.max(0, Math.min(1, (ds[i] - (max - 72)) / 72)) * (H - 8);
    path += `${first && !closed ? 'M' : ' L'}${fToX(fs[i]).toFixed(1)},${y.toFixed(1)}`;
    first = false;
  }
  return closed ? `${path} L${W},${H} Z` : path;
}

/**
 * Shared EQ graph (parametric and dynamic): log-frequency grid, pre/post analyser,
 * per-band fills, curve(s), draggable nodes with Q handles, double-click to add,
 * mouse-wheel Q, and keyboard nudges (arrows = freq/gain, +/- = Q, S = solo,
 * Delete = remove, Esc = deselect; Shift = fine).
 */
export const EqGraph: React.FC<Props> = ({
  nodes,
  selectedId,
  onSelect,
  onNodeChange,
  onAdd,
  onDelete,
  onResetGain,
  onToggleSolo,
  curves,
  preSpectrum,
  postSpectrum,
  analyzer = 'post',
  waveformPeaks,
  durationSec = 0,
  onSeek,
  fades,
  onFadesChange,
  ariaLabel,
  children,
  className = '',
}) => {
  const uid = useId().replace(/:/g, '');
  useEffect(() => { void import('./waveformStyles').then((m) => m.ensureWaveformStyles()); }, []);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<null | { id: string; kind: 'node' | 'qlo' | 'qhi'; fine: boolean; sx: number; sy: number; node: EqGraphNode; last: { freq?: number; yDb?: number; q?: number } }>(null);
  const seekDragRef = useRef(false);
  const fadeDragRef = useRef<null | 'in' | 'out'>(null);
  // Fade handle under the pointer or being dragged: shows its length on the curve.
  const [fadeHot, setFadeHot] = useState<null | 'in' | 'out'>(null);
  const [fadeDragSide, setFadeDragSide] = useState<null | 'in' | 'out'>(null);
  const lastSeekAtRef = useRef(0);
  const lastPointerXRef = useRef(0);
  // Visible waveform time window (zoom). The EQ curve stays frequency-based.
  const [viewState, setViewState] = useState<TimeView>(() => fullView(durationSec));
  const view = useMemo(() => {
    const v = viewState.end > viewState.start ? viewState : fullView(durationSec);
    return clampView(v, durationSec);
  }, [viewState, durationSec]);
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => { setViewState(fullView(durationSec)); }, [durationSec]);
  const hasTimeline = Boolean(waveformPeaks && waveformPeaks.length >= 2 && durationSec > 0);
  const timelineRef = useRef({ hasTimeline, durationSec });
  timelineRef.current = { hasTimeline, durationSec };
  // Two-finger pinch on touch screens zooms the waveform timeline.
  const touchPointsRef = useRef(new Map<number, number>());
  const pinchRef = useRef<null | { dist: number; mid: number; view: TimeView; anchor: number }>(null);
  const tl = (clientX: number, rect: DOMRect) => timelineSecondsFromPointer(clientX, rect.left, rect.width, durationSec, viewRef.current);

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const startFadeDrag = (side: 'in' | 'out') => (e: React.PointerEvent<SVGCircleElement>) => {
    e.preventDefault();
    e.stopPropagation();
    fadeDragRef.current = side;
    lastPointerXRef.current = e.clientX;
    svgRef.current?.setAttribute('data-fade-drag-side', side);
    svgRef.current?.setAttribute('data-fade-last-seconds', 'not-moved');
    setFadeDragSide(side);
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };

  const startDrag = (n: EqGraphNode, kind: 'node' | 'qlo' | 'qhi') => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect(n.id);
    dragRef.current = { id: n.id, kind, fine: e.shiftKey, sx: e.clientX, sy: e.clientY, node: n, last: {} };
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    if (fadeDragRef.current && fades && onFadesChange && durationSec > 0 && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const sec = tl(e.clientX, rect);
      svgRef.current.setAttribute('data-fade-last-seconds', sec.toFixed(3));
      const maxLen = durationSec * 0.5;
      const side = fadeDragRef.current;
      onFadesChange((current) => side === 'in'
        ? { ...current, inSec: Number(Math.min(maxLen, sec).toFixed(2)) }
        : { ...current, outSec: Number(Math.min(maxLen, durationSec - sec).toFixed(2)) });
      return;
    }
    if (seekDragRef.current && onSeek && durationSec > 0 && svgRef.current) {
      const now = performance.now();
      if (now - lastSeekAtRef.current >= 60) {
        lastSeekAtRef.current = now;
        const rect = svgRef.current.getBoundingClientRect();
        onSeek(tl(e.clientX, rect));
      }
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    const p = toLocal(e);
    const n = d.node;
    let patch: { freq?: number; yDb?: number; q?: number };
    if (d.kind !== 'node') {
      const f = xToF(p.x);
      const ratio = d.kind === 'qlo' ? n.freq / f : f / n.freq;
      patch = { q: Number(Math.max(0.1, Math.min(18, qFromEdgeRatio(Math.max(1.01, ratio)))).toFixed(2)) };
    } else if (d.fine) {
      const r = svgRef.current!.getBoundingClientRect();
      const dx = ((e.clientX - d.sx) / r.width) * W * 0.15;
      const dy = ((e.clientY - d.sy) / r.height) * H * 0.15;
      patch = { freq: Math.round(clampF(xToF(fToX(n.freq) + dx))) };
      if (n.yMode !== 'none') patch.yDb = Number(clampG(n.yDb - (dy / (H / 2 - 10)) * G_MAX).toFixed(1));
    } else {
      patch = { freq: Math.round(clampF(xToF(p.x))) };
      if (n.yMode !== 'none') patch.yDb = Number(clampG(yToG(p.y)).toFixed(1));
    }
    d.last = patch;
    onNodeChange(d.id, patch, 'move');
  };

  const endDrag = () => {
    if (fadeDragRef.current && fades && onFadesChange && durationSec > 0 && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const sec = tl(lastPointerXRef.current, rect);
      const maxLen = durationSec * 0.5;
      const side = fadeDragRef.current;
      onFadesChange((current) => side === 'in'
        ? { ...current, inSec: Number(Math.min(maxLen, sec).toFixed(2)) }
        : { ...current, outSec: Number(Math.min(maxLen, durationSec - sec).toFixed(2)) });
      fadeDragRef.current = null;
      setFadeDragSide(null);
      return;
    }
    if (seekDragRef.current) {
      seekDragRef.current = false;
      if (onSeek && durationSec > 0 && svgRef.current) {
        const rect = svgRef.current.getBoundingClientRect();
        onSeek(tl(lastPointerXRef.current, rect));
      }
      return;
    }
    const d = dragRef.current;
    dragRef.current = null;
    if (d && Object.keys(d.last).length) onNodeChange(d.id, d.last, 'end');
  };

  // Mouse wheel over a node = Q (native non-passive listener so the page does not scroll).
  const wheelRef = useRef({ nodes, onNodeChange });
  wheelRef.current = { nodes, onNodeChange };
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      const id = (e.target as Element | null)?.closest?.('[data-band-id]')?.getAttribute('data-band-id');
      const tlNow = timelineRef.current;
      // FL Studio style: Ctrl/Cmd + wheel (and trackpad pinch, which arrives as ctrl+wheel)
      // zooms the waveform timeline around the cursor; horizontal or Shift + wheel pans.
      if (tlNow.hasTimeline && (e.ctrlKey || e.metaKey || ((e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) && !id))) {
        const rect = svg.getBoundingClientRect();
        if (rect.width <= 0) return;
        e.preventDefault();
        e.stopPropagation();
        const v = viewRef.current;
        if (e.ctrlKey || e.metaKey) {
          const anchor = xToSec(e.clientX - rect.left, v, rect.width);
          setViewState(zoomAround(v, anchor, wheelZoomFactor(wheelPixels(e.deltaY, e.deltaMode, rect.height)), tlNow.durationSec));
        } else {
          const px = wheelPixels(Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY, e.deltaMode, rect.width);
          setViewState(panBy(v, (px / rect.width) * (v.end - v.start), tlNow.durationSec));
        }
        return;
      }
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      const n = wheelRef.current.nodes.find((x) => x.id === id);
      if (!n) return;
      const q = Math.max(0.1, Math.min(18, n.q * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      wheelRef.current.onNodeChange(id, { q: Number(q.toFixed(2)) }, 'end');
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const onDouble = (e: React.MouseEvent) => {
    if (!onAdd || (e.target as Element | null)?.closest?.('[data-fade-handle]')) return;
    const p = toLocal(e);
    onAdd(Math.round(clampF(xToF(p.x))), Number(clampG(yToG(p.y)).toFixed(1)));
  };

  const onNodeKey = (n: EqGraphNode) => (e: React.KeyboardEvent) => {
    const fine = e.shiftKey;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const ratio = fine ? 1.01 : 1.06;
      onNodeChange(n.id, { freq: Math.round(clampF(e.key === 'ArrowRight' ? n.freq * ratio : n.freq / ratio)) }, 'end');
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && n.yMode !== 'none') {
      e.preventDefault();
      const step = (fine ? 0.1 : 0.5) * (e.key === 'ArrowUp' ? 1 : -1);
      onNodeChange(n.id, { yDb: Number(clampG(n.yDb + step).toFixed(1)) }, 'end');
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault();
      const q = n.q * (e.key === '-' ? 1 / 1.12 : 1.12);
      onNodeChange(n.id, { q: Number(Math.max(0.1, Math.min(18, q)).toFixed(2)) }, 'end');
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && onDelete) {
      e.preventDefault();
      onDelete(n.id);
    } else if ((e.key === 's' || e.key === 'S') && onToggleSolo) {
      e.preventDefault();
      onToggleSolo(n.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onSelect(null);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(n.id);
    }
  };

  const prePath = useMemo(() => (analyzer === 'pre' || analyzer === 'both' ? spectrumPath(preSpectrum, analyzer === 'pre') : null), [analyzer, preSpectrum]);
  const postPath = useMemo(() => (analyzer === 'post' || analyzer === 'both' ? spectrumPath(postSpectrum ?? preSpectrum, true) : null), [analyzer, postSpectrum, preSpectrum]);
  // Upper envelope outline of the analyser blanket, drawn as a translucent neon line.
  const neonLine = useMemo(() => (analyzer === 'off' ? null : spectrumPath(analyzer === 'pre' ? preSpectrum : postSpectrum ?? preSpectrum, false)), [analyzer, postSpectrum, preSpectrum]);

  const waveSource = getWaveformSource(waveformPeaks);
  // Peaks measured before the fades (dry / bypassed view) get the fade gain applied here so
  // the drawn waveform always shows what the render does.
  const scaleByFades = Boolean(waveSource && !waveSource.includesFades && fades);
  // Zoomed in: recompute the envelope for the visible window from the audio itself
  // (cached max-abs pyramid, built in slices), so detail increases like FL Studio.
  const [hiEnv, setHiEnv] = useState<null | { peaks: unknown; start: number; end: number; env: number[] }>(null);
  useEffect(() => {
    if (!waveSource || !hasTimeline || isFullView(view, durationSec)) return;
    let cancelled = false;
    const target = { ...view };
    const timer = window.setTimeout(() => {
      void import('./waveformDetail').then(async (d) => {
        const blocks = await d.ensurePeakBlocks(waveSource.channels);
        if (cancelled) return;
        const env = d.envelopeFromSamples(waveSource.channels, waveSource.sampleRate, target, 480, blocks);
        setHiEnv({ peaks: waveformPeaks, start: target.start, end: target.end, env });
      });
    }, 40);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [waveSource, waveformPeaks, hasTimeline, view, durationSec]);
  const blanket = useMemo(() => {
    if (!waveformPeaks || waveformPeaks.length < 2 || !(durationSec > 0)) {
      if (!waveformPeaks || waveformPeaks.length < 2) return null;
      const e0 = envelopeFromGlobalPeaks(waveformPeaks, 1, { start: 0, end: 1 }, Math.min(480, waveformPeaks.length));
      return { d: blanketPathFromEnvelope(e0, W, H), env: e0 };
    }
    const bins = Math.min(480, Math.max(2, waveformPeaks.length));
    const fresh = hiEnv && hiEnv.peaks === waveformPeaks && Math.abs(hiEnv.start - view.start) < 1e-9 && Math.abs(hiEnv.end - view.end) < 1e-9;
    const env = fresh && !isFullView(view, durationSec) ? hiEnv.env.slice() : envelopeFromGlobalPeaks(waveformPeaks, durationSec, view, bins);
    if (scaleByFades) {
      const span = view.end - view.start;
      for (let i = 0; i < env.length; i++) env[i] *= fadeGainAt(view.start + ((i + 0.5) / env.length) * span, durationSec, fades);
    }
    return { d: blanketPathFromEnvelope(env, W, H), env };
  }, [waveformPeaks, durationSec, view, scaleByFades, fades, hiEnv]);
  const blanketPath = blanket?.d ?? null;
  const fadeOverlay = useMemo(() => {
    if (!fades || durationSec <= 0) return null;
    const inX = secToX(fades.inSec, view, W);
    const outX = secToX(durationSec - fades.outSec, view, W);
    return {
      inX,
      outX,
      fin: fadeGeometry('in', fades, durationSec, view, W, H),
      fout: fadeGeometry('out', fades, durationSec, view, W, H),
    };
  }, [fades, durationSec, view]);
  const headRef = useRef<SVGLineElement | null>(null);
  useEffect(() => {
    if (!blanketPath || !durationSec) return;
    const update = (sec: number) => {
      const el = headRef.current;
      if (!el) return;
      const v = viewRef.current;
      const raw = secToX(Math.max(0, Math.min(durationSec, sec)), v, W);
      el.style.visibility = raw < -1 || raw > W + 1 ? 'hidden' : 'visible';
      const x = raw.toFixed(1);
      el.setAttribute('x1', x);
      el.setAttribute('x2', x);
    };
    update(telemetryStore.getSnapshot().currentTimeSec);
    return telemetryStore.subscribe((s) => update(s.currentTimeSec));
  }, [blanketPath, durationSec, view]);

  const mainPath = curvePath(curves.freqs, curves.main);
  const zeroY = gToY(0);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className={`syn-eqx-plot ${className}`}>
      {hasTimeline && (
        <React.Suspense fallback={<div className="syn-wfzoom" aria-hidden="true" style={{ height: 12 }} />}>
          <WaveformZoomBar view={view} durationSec={durationSec} onChange={(next) => setViewState(clampView(next, durationSec))} />
        </React.Suspense>
      )}
      <div className="syn-eqx-canvas">
      <span className="syn-ceq-axis-y" aria-hidden="true">GAIN (dB)</span>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="syn-ceq-svg syn-eqx-svg"
        onPointerMove={(e) => {
          if (e.pointerType === 'touch' && touchPointsRef.current.has(e.pointerId)) {
            touchPointsRef.current.set(e.pointerId, e.clientX);
            const pinch = pinchRef.current;
            if (pinch && touchPointsRef.current.size >= 2 && svgRef.current) {
              const [a, b] = Array.from(touchPointsRef.current.values());
              const rect = svgRef.current.getBoundingClientRect();
              const dist = Math.max(12, Math.abs(a - b));
              const zoomed = zoomAround(pinch.view, pinch.anchor, dist / pinch.dist, durationSec);
              // Keep the pinch anchor under the fingers' midpoint while they move.
              const midSec = xToSec((a + b) / 2 - rect.left, zoomed, rect.width);
              setViewState(panBy(zoomed, pinch.anchor - midSec, durationSec));
              return;
            }
          }
          lastPointerXRef.current = e.clientX;
          onMove(e);
        }}
        onPointerUp={(e) => {
          touchPointsRef.current.delete(e.pointerId);
          if (pinchRef.current) {
            if (touchPointsRef.current.size < 2) pinchRef.current = null;
            return;
          }
          lastPointerXRef.current = e.clientX;
          endDrag();
        }}
        onPointerCancel={(e) => {
          touchPointsRef.current.delete(e.pointerId);
          if (touchPointsRef.current.size < 2) pinchRef.current = null;
          if (fadeDragRef.current) {
            // A browser can cancel pointer capture during a drag. Preserve the last
            // pointer position and commit that fade before clearing the active side.
            lastPointerXRef.current = e.clientX;
            endDrag();
            return;
          }
          fadeDragRef.current = null;
          seekDragRef.current = false;
          setFadeDragSide(null);
          endDrag();
        }}
        onDoubleClick={onDouble}
        onPointerDown={(e) => {
          if (e.pointerType === 'touch') {
            touchPointsRef.current.set(e.pointerId, e.clientX);
            if (touchPointsRef.current.size === 2 && hasTimeline && svgRef.current) {
              // Second finger down: cancel the seek / fade drag and start a pinch zoom.
              fadeDragRef.current = null;
              setFadeDragSide(null);
              seekDragRef.current = false;
              dragRef.current = null;
              svgRef.current.setPointerCapture?.(e.pointerId);
              const [a, b] = Array.from(touchPointsRef.current.values());
              const rect = svgRef.current.getBoundingClientRect();
              const v = viewRef.current;
              pinchRef.current = { dist: Math.max(12, Math.abs(a - b)), mid: (a + b) / 2, view: v, anchor: xToSec((a + b) / 2 - rect.left, v, rect.width) };
              e.preventDefault();
              return;
            }
          }
          const target = e.target as Element | null;
          if (target?.closest?.('[data-band-id], [data-q-handle]')) return;
          if (fades && onFadesChange && durationSec > 0 && svgRef.current) {
            // Prefer the actual handle element over coordinate hit-testing. SVG viewBox
            // scaling and responsive sizing can otherwise make the visible handle's
            // screen-space center miss the narrow timeline hit region.
            const handleSide = target?.closest?.('[data-fade-handle]')?.getAttribute('data-fade-handle');
            if (handleSide === 'in' || handleSide === 'out') {
              fadeDragRef.current = handleSide;
            } else {
              const p = toLocal(e);
              const inX = Math.max(10, secToX(fades.inSec, viewRef.current, W));
              const outX = Math.min(W - 10, secToX(durationSec - fades.outSec, viewRef.current, W));
              if (p.y <= 20 && Math.abs(p.x - inX) <= 15) fadeDragRef.current = 'in';
              else if (p.y >= 20 && p.y <= 40 && Math.abs(p.x - outX) <= 15) fadeDragRef.current = 'out';
            }
            if (fadeDragRef.current) {
              setFadeDragSide(fadeDragRef.current);
              e.preventDefault();
              svgRef.current.setPointerCapture?.(e.pointerId);
              return;
            }
          }
          if (onSeek && durationSec > 0 && svgRef.current) {
            e.preventDefault();
            seekDragRef.current = true;
            lastSeekAtRef.current = 0;
            lastPointerXRef.current = e.clientX;
            svgRef.current.setPointerCapture?.(e.pointerId);
            const rect = svgRef.current.getBoundingClientRect();
            onSeek(tl(e.clientX, rect));
            return;
          }
          if (e.target === svgRef.current) onSelect(null);
        }}
        onKeyDown={(e) => {
          if (e.target !== svgRef.current || !onSeek || durationSec <= 0) return;
          const current = telemetryStore.getSnapshot().currentTimeSec;
          const step = e.shiftKey ? 1 : 5;
          const next = e.key === 'ArrowLeft' ? current - step : e.key === 'ArrowRight' ? current + step : e.key === 'Home' ? 0 : e.key === 'End' ? durationSec - 0.05 : null;
          if (next !== null) {
            e.preventDefault();
            onSeek(Math.max(0, Math.min(durationSec, next)));
          }
        }}
        tabIndex={0}
        role="group"
        aria-label={`${ariaLabel} Drag the cyan top handles to set fade-in and fade-out on this waveform. Ctrl + wheel or pinch zooms the waveform, Shift + wheel scrolls it.`}
      >
        <defs>
          <linearGradient id={`${uid}-curve`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#2EA8FF" />
            <stop offset="35%" stopColor="#3FE0FF" />
            <stop offset="65%" stopColor="#8B5CF6" />
            <stop offset="100%" stopColor="#E040FB" />
          </linearGradient>
          <linearGradient id={`${uid}-area`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#3FE0FF" stopOpacity={0.22} />
            <stop offset="100%" stopColor="#E040FB" stopOpacity={0} />
          </linearGradient>
          <linearGradient id={`${uid}-blanket`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#8B5CF6" stopOpacity={0.32} />
            <stop offset="50%" stopColor="#2EA8FF" stopOpacity={0.12} />
            <stop offset="100%" stopColor="#8B5CF6" stopOpacity={0.32} />
          </linearGradient>
          <linearGradient id={`${uid}-neon`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#3FE0FF" />
            <stop offset="38%" stopColor="#8B5CF6" />
            <stop offset="70%" stopColor="#E040FB" />
            <stop offset="100%" stopColor="#F5C451" />
          </linearGradient>
          <linearGradient id={`${uid}-neonfill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#8B5CF6" stopOpacity={0.2} />
            <stop offset="55%" stopColor="#3FE0FF" stopOpacity={0.06} />
            <stop offset="100%" stopColor="#3FE0FF" stopOpacity={0} />
          </linearGradient>
          <filter id={`${uid}-glow`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {GRID_F.map((f) => <line key={f} x1={fToX(f)} x2={fToX(f)} y1={0} y2={H} className="syn-ceq-grid" />)}
        {[-12, -6, 0, 6, 12].map((g) => (
          <line key={g} x1={0} x2={W} y1={gToY(g)} y2={gToY(g)} className={g === 0 ? 'syn-ceq-grid is-zero' : 'syn-ceq-grid'} />
        ))}
        {blanketPath && (
          <g className="syn-ceq-blanket" pointerEvents="none">
            <path d={blanketPath} className="syn-ceq-blanket-path" fill={`url(#${uid}-blanket)`} stroke="#2EA8FF" strokeOpacity={0.25} strokeWidth={0.8} />
            <React.Suspense fallback={null}>
              <Layer kind="tint" uid={uid} d={blanketPath} env={blanket!.env} view={durationSec > 0 ? view : { start: 0, end: 1 }} durationSec={durationSec} source={waveSource} fades={fades} scaleByFades={scaleByFades} />
            </React.Suspense>
            {durationSec > 0 && <line ref={headRef} x1={0} x2={0} y1={0} y2={H} className="syn-ceq-playhead" />}
          </g>
        )}
        {fadeOverlay && (
          <g data-fade-overlay="true" className="syn-eqx-fade-overlay">
            {([['in', fadeOverlay.fin], ['out', fadeOverlay.fout]] as const).map(([side, g]) => g && (
              <g key={side} data-fade-side={side} pointerEvents="none">
                <linearGradient id={`${uid}-fade-${side}`} x1={g.x0} x2={g.x1} y1={0} y2={0} gradientUnits="userSpaceOnUse">
                  {g.stops.map((st) => (
                    <stop key={st.offset} offset={st.offset} stopColor="#02030A" stopOpacity={(0.68 * st.attenuation).toFixed(3)} />
                  ))}
                </linearGradient>
                <rect className="syn-wf-fade-shade" x={Math.min(g.x0, g.x1)} y={0} width={Math.abs(g.x1 - g.x0)} height={H} fill={`url(#${uid}-fade-${side})`} />
                <path className="syn-wf-fade-region" d={g.shade} fill="none" />
                <path className="syn-wf-fade-glow" d={g.line} fill="none" />
                <path className="syn-wf-fade-line" d={g.line} fill="none" stroke="#E040FB" strokeWidth={2.2} data-fade-line={side} />
              </g>
            ))}
            {fadeOverlay.inX >= -8 && fadeOverlay.inX <= W + 8 && (
              <circle data-fade-handle="in" onPointerDown={startFadeDrag('in')} onPointerEnter={() => setFadeHot('in')} onPointerLeave={() => setFadeHot(null)} className="syn-wf-fade-handle" cx={Math.max(10, Math.min(W - 10, fadeOverlay.inX))} cy={12} r={7} fill="#3FE0FF" pointerEvents="all" />
            )}
            {fadeOverlay.outX >= -8 && fadeOverlay.outX <= W + 8 && (
              <circle data-fade-handle="out" onPointerDown={startFadeDrag('out')} onPointerEnter={() => setFadeHot('out')} onPointerLeave={() => setFadeHot(null)} className="syn-wf-fade-handle" cx={Math.min(W - 10, Math.max(10, fadeOverlay.outX))} cy={28} r={7} fill="#3FE0FF" pointerEvents="all" />
            )}
          </g>
        )}
        {postPath && <path d={postPath} className="syn-eqx-spec-post" pointerEvents="none" style={neonLine ? { fill: `url(#${uid}-neonfill)`, stroke: 'none' } : undefined} />}
        {postPath && neonLine && <React.Suspense fallback={null}><Layer kind="fill" uid={uid} d={postPath} /></React.Suspense>}
        {neonLine && (
          <g className="syn-wf-neon" pointerEvents="none" data-envelope="neon">
            <path d={neonLine} className="syn-wf-neon-bloom" fill="none" stroke={`url(#${uid}-neon)`} />
            <path d={neonLine} className="syn-wf-neon-line" fill="none" stroke={`url(#${uid}-neon)`} />
          </g>
        )}
        {curves.spectra?.map((sp) => {
          const d = curvePath(sp.freqs as number[], sp.values);
          return (
            <g key={sp.key} pointerEvents="none" data-spectrum={sp.key}>
              {sp.fill && <path d={`${d} L${W},${H} L0,${H} Z`} fill={sp.color} fillOpacity={0.1} stroke="none" />}
              <path d={d} fill="none" stroke={sp.color} strokeWidth={1.3} strokeOpacity={0.85} />
            </g>
          );
        })}
        {prePath && <path d={prePath} className={analyzer === 'pre' ? 'syn-eqx-spec-post' : 'syn-eqx-spec-pre'} pointerEvents="none" />}
        {curves.perBand?.map((pb, i) =>
          pb && nodes[i] ? (
            <path
              key={nodes[i].id}
              d={`${curvePath(curves.freqs, pb)} L${W},${zeroY} L0,${zeroY} Z`}
              fill={nodes[i].color}
              fillOpacity={nodes[i].id === selectedId ? 0.2 : 0.06}
              stroke="none"
              pointerEvents="none"
            />
          ) : null,
        )}
        <path d={`${mainPath} L${W},${zeroY} L0,${zeroY} Z`} fill={`url(#${uid}-area)`} pointerEvents="none" />
        {curves.extras?.map((x) => (
          <path key={x.key} d={curvePath(curves.freqs, x.values)} fill="none" stroke={x.color} strokeWidth={1.4} strokeDasharray="5 4" pointerEvents="none" className="syn-eqx-extra" data-curve={x.key} />
        ))}
        <path d={mainPath} fill="none" stroke={`url(#${uid}-curve)`} strokeWidth={2.4} filter={`url(#${uid}-glow)`} pointerEvents="none" data-curve="main" />
        {curves.live && (
          <path d={curvePath(curves.freqs, curves.live)} fill="none" className="syn-eqx-live" pointerEvents="none" data-curve="live" />
        )}
        {selected && selected.showQ && selected.enabled && (() => {
          const r = qEdgeRatio(selected.q);
          const y = gToY(selected.yDb);
          return (
            <g className="syn-eqx-qhandles">
              <line x1={fToX(selected.freq / r)} x2={fToX(selected.freq * r)} y1={y} y2={y} stroke={selected.color} strokeOpacity={0.5} strokeDasharray="2 3" pointerEvents="none" />
              {(['qlo', 'qhi'] as const).map((k) => {
                const x = fToX(k === 'qlo' ? selected.freq / r : selected.freq * r);
                return (
                  <rect key={k} x={x - 4} y={y - 4} width={8} height={8} transform={`rotate(45 ${x} ${y})`} fill="#05070D" stroke={selected.color} strokeWidth={1.6}
                    className="syn-eqx-qhandle" data-q-handle={k} onPointerDown={startDrag(selected, k)} aria-hidden="true" />
                );
              })}
            </g>
          );
        })()}
        {nodes.map((n) => {
          const x = fToX(n.freq);
          const y = gToY(Math.max(-G_MAX, Math.min(G_MAX, n.yDb)));
          const sel = n.id === selectedId;
          return (
            <g key={n.id} opacity={n.enabled ? 1 : 0.35} className={n.solo ? 'is-solo' : undefined}>
              <line x1={x} x2={x} y1={y} y2={H} stroke={n.color} strokeOpacity={0.25} strokeDasharray="2 3" pointerEvents="none" />
              <circle
                cx={x}
                cy={y}
                r={sel ? 9.5 : 7.5}
                fill="#05070D"
                stroke={n.color}
                strokeWidth={sel ? 3 : 2.4}
                className="syn-ceq-node syn-eqx-node"
                style={{ cursor: 'grab', color: n.color }}
                tabIndex={0}
                role="button"
                aria-label={n.description}
                aria-pressed={sel}
                aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + - S Delete Escape"
                data-band-id={n.id}
                onFocus={() => onSelect(n.id)}
                onKeyDown={onNodeKey(n)}
                onPointerDown={startDrag(n, 'node')}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onResetGain?.(n.id);
                }}
              />
              <text x={x} y={y + 3} fontSize={8} textAnchor="middle" fill={n.color} fontWeight={800} pointerEvents="none">{n.label}</text>
              {sel && (
                <text x={Math.min(W - 40, Math.max(4, x + 12))} y={Math.max(12, y - 12)} fontSize={9} fill="#E8F6FF" className="syn-eqx-readout" pointerEvents="none">
                  {fmtF(n.freq)} Hz
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {fades && (fadeDragSide ?? fadeHot) && (
        <React.Suspense fallback={null}>
          <Layer kind="label" side={(fadeDragSide ?? fadeHot)!} fades={fades} durationSec={durationSec} view={view} svg={svgRef.current} />
        </React.Suspense>
      )}
      <div className="syn-ceq-ylabels" aria-hidden="true">
        {[12, 6, 0, -6, -12].map((g) => (
          <span key={g} style={{ top: `${(gToY(g) / H) * 100}%` }}>{g > 0 ? `+${g}` : g}</span>
        ))}
      </div>
      <div className="syn-ceq-xlabels" aria-hidden="true">
        {GRID_F.map((f) => (
          <span key={f} className={f === 50 || f === 200 || f === 2000 ? 'is-minor' : undefined} style={{ left: `${(fToX(f) / W) * 100}%` }}>{f >= 1000 ? `${f / 1000}k` : f}</span>
        ))}
      </div>
      </div>
      {children}
    </div>
  );
};
