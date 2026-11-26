import React, { useEffect, useId, useMemo, useRef } from 'react';
import type { AudioAnalysis } from '../../../types/mastering';
import { qEdgeRatio, qFromEdgeRatio } from '../../../dsp/eqDesign';
import { telemetryStore } from '../../../engine/telemetryStore';
import { fadeGain, type FadeSettings } from '../../../dsp/fades';
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
  onFadesChange?: (next: FadeSettings) => void;
  ariaLabel: string;
  /** Popover rendered over the plot. */
  children?: React.ReactNode;
  className?: string;
}

const GRID_F = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

/** Convert a pointer's horizontal position into the shared linear track-time coordinate. */
export function timelineSecondsFromPointer(clientX: number, left: number, width: number, durationSec: number): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0 || !Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.max(0, Math.min(durationSec, ((clientX - left) / width) * durationSec));
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
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<null | { id: string; kind: 'node' | 'qlo' | 'qhi'; fine: boolean; sx: number; sy: number; node: EqGraphNode; last: { freq?: number; yDb?: number; q?: number } }>(null);
  const seekDragRef = useRef(false);
  const fadeDragRef = useRef<null | 'in' | 'out'>(null);
  const lastSeekAtRef = useRef(0);
  const lastPointerXRef = useRef(0);

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
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
      const sec = timelineSecondsFromPointer(e.clientX, rect.left, rect.width, durationSec);
      const maxLen = durationSec * 0.5;
      if (fadeDragRef.current === 'in') onFadesChange({ ...fades, inSec: Number(Math.min(maxLen, sec).toFixed(2)) });
      else onFadesChange({ ...fades, outSec: Number(Math.min(maxLen, durationSec - sec).toFixed(2)) });
      return;
    }
    if (seekDragRef.current && onSeek && durationSec > 0 && svgRef.current) {
      const now = performance.now();
      if (now - lastSeekAtRef.current >= 60) {
        lastSeekAtRef.current = now;
        const rect = svgRef.current.getBoundingClientRect();
        onSeek(timelineSecondsFromPointer(e.clientX, rect.left, rect.width, durationSec));
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
      const sec = timelineSecondsFromPointer(lastPointerXRef.current, rect.left, rect.width, durationSec);
      const maxLen = durationSec * 0.5;
      if (fadeDragRef.current === 'in') onFadesChange({ ...fades, inSec: Number(Math.min(maxLen, sec).toFixed(2)) });
      else onFadesChange({ ...fades, outSec: Number(Math.min(maxLen, durationSec - sec).toFixed(2)) });
      fadeDragRef.current = null;
      return;
    }
    if (seekDragRef.current) {
      seekDragRef.current = false;
      if (onSeek && durationSec > 0 && svgRef.current) {
        const rect = svgRef.current.getBoundingClientRect();
        onSeek(timelineSecondsFromPointer(lastPointerXRef.current, rect.left, rect.width, durationSec));
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
    if (!onAdd) return;
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

  const blanketPath = useMemo(() => {
    if (!waveformPeaks || waveformPeaks.length < 2) return null;
    const N = Math.min(480, waveformPeaks.length);
    const step = waveformPeaks.length / N;
    const mid = H / 2;
    const amp = H * 0.44;
    const env: number[] = [];
    for (let i = 0; i < N; i++) {
      let m = 0;
      const a = Math.floor(i * step);
      const b = Math.max(a + 1, Math.floor((i + 1) * step));
      for (let k = a; k < b && k < waveformPeaks.length; k++) if (waveformPeaks[k] > m) m = waveformPeaks[k];
      env.push(Math.min(1, m));
    }
    let d = `M0,${mid}`;
    for (let i = 0; i < N; i++) d += ` L${((i / (N - 1)) * W).toFixed(1)},${(mid - env[i] * amp).toFixed(1)}`;
    for (let i = N - 1; i >= 0; i--) d += ` L${((i / (N - 1)) * W).toFixed(1)},${(mid + env[i] * amp).toFixed(1)}`;
    return d + ' Z';
  }, [waveformPeaks]);
  const fadeOverlay = useMemo(() => {
    if (!fades || durationSec <= 0) return null;
    const inX = Math.max(0, Math.min(W, (fades.inSec / durationSec) * W));
    const outX = Math.max(0, Math.min(W, W - (fades.outSec / durationSec) * W));
    const inPath = fades.inSec > 0
      ? Array.from({ length: 41 }, (_, i) => {
          const t = i / 40;
          return `${i ? 'L' : 'M'}${(t * inX).toFixed(1)},${(H - fadeGain(t, fades.inCurve) * H).toFixed(1)}`;
        }).join(' ')
      : '';
    const outPath = fades.outSec > 0
      ? Array.from({ length: 41 }, (_, i) => {
          const t = i / 40;
          return `${i ? 'L' : 'M'}${(W - t * (W - outX)).toFixed(1)},${(H - fadeGain(t, fades.outCurve) * H).toFixed(1)}`;
        }).join(' ')
      : '';
    return { inX, outX, inPath, outPath };
  }, [fades, durationSec]);
  const headRef = useRef<SVGLineElement | null>(null);
  useEffect(() => {
    if (!blanketPath || !durationSec) return;
    const update = (sec: number) => {
      const el = headRef.current;
      if (!el) return;
      const x = (Math.max(0, Math.min(1, sec / durationSec)) * W).toFixed(1);
      el.setAttribute('x1', x);
      el.setAttribute('x2', x);
    };
    update(telemetryStore.getSnapshot().currentTimeSec);
    return telemetryStore.subscribe((s) => update(s.currentTimeSec));
  }, [blanketPath, durationSec]);

  const mainPath = curvePath(curves.freqs, curves.main);
  const zeroY = gToY(0);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className={`syn-eqx-plot ${className}`}>
      <div className="syn-eqx-canvas">
      <span className="syn-ceq-axis-y" aria-hidden="true">GAIN (dB)</span>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="syn-ceq-svg syn-eqx-svg"
        onPointerMove={(e) => { lastPointerXRef.current = e.clientX; onMove(e); }}
        onPointerUp={(e) => { lastPointerXRef.current = e.clientX; endDrag(); }}
        onPointerCancel={() => { fadeDragRef.current = null; seekDragRef.current = false; endDrag(); }}
        onDoubleClick={onDouble}
        onPointerDown={(e) => {
          const target = e.target as Element | null;
          if (target?.closest?.('[data-band-id], [data-q-handle]')) return;
          if (fades && onFadesChange && durationSec > 0 && svgRef.current) {
            const p = toLocal(e);
            const inX = (fades.inSec / durationSec) * W;
            const outX = W - (fades.outSec / durationSec) * W;
            if (p.y <= 20 && Math.abs(p.x - inX) <= 15) fadeDragRef.current = 'in';
            else if (p.y >= 20 && p.y <= 40 && Math.abs(p.x - outX) <= 15) fadeDragRef.current = 'out';
            if (fadeDragRef.current) {
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
            onSeek(timelineSecondsFromPointer(e.clientX, rect.left, rect.width, durationSec));
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
        aria-label={`${ariaLabel} Drag the cyan top handles to set fade-in and fade-out on this waveform.`}
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
            {durationSec > 0 && <line ref={headRef} x1={0} x2={0} y1={0} y2={H} className="syn-ceq-playhead" />}
          </g>
        )}
        {fadeOverlay && (
          <g data-fade-overlay="true" className="syn-eqx-fade-overlay" pointerEvents="none">
            {fadeOverlay.inPath && <path d={fadeOverlay.inPath} fill="none" stroke="#E040FB" strokeWidth={2.5} strokeLinecap="round" filter={`url(#${uid}-glow)`} />}
            {fadeOverlay.outPath && <path d={fadeOverlay.outPath} fill="none" stroke="#E040FB" strokeWidth={2.5} strokeLinecap="round" filter={`url(#${uid}-glow)`} />}
            <circle data-fade-handle="in" cx={Math.max(10, fadeOverlay.inX)} cy={12} r={7} fill="#3FE0FF" stroke="#07111C" strokeWidth={2} pointerEvents="all" />
            <circle data-fade-handle="out" cx={Math.min(W - 10, fadeOverlay.outX)} cy={28} r={7} fill="#3FE0FF" stroke="#07111C" strokeWidth={2} pointerEvents="all" />
          </g>
        )}
        {postPath && <path d={postPath} className="syn-eqx-spec-post" pointerEvents="none" />}
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
