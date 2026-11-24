import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { AudioAnalysis, EQBand, EQBandShape, ParametricEQParams } from '../../types/mastering';
import { designEQBand } from '../../dsp/offlineDsp';
import { telemetryStore } from '../../engine/telemetryStore';
import { designHighShelf, designLowShelf, evaluateBiquadMagnitudeDb } from '../../dsp/biquad';

/**
 * FL Studio "Fruity Parametric EQ 2"-style editor:
 *  - live/pre-rendered spectrum behind a log-frequency grid
 *  - coloured, draggable band nodes (drag = freq/gain, mouse wheel = Q / bandwidth,
 *    Shift-drag = fine, double-click empty space = new band, double-click node = reset gain)
 *  - per-band shape (bell, shelves, HP, LP, notch), enable and delete in the band strip
 * The curve is computed from the same biquad designs the offline renderer uses.
 */
interface Props {
  params: ParametricEQParams;
  sampleRate: number;
  spectrum: AudioAnalysis | null;
  onChange: (next: ParametricEQParams) => void;
  /** 'console' = reference-mockup styling (gradient curve, waveform blanket, band table, keyboard-focusable nodes). */
  variant?: 'classic' | 'console';
  /** Console only: decoded waveform peaks (0..1) of the processed preview, drawn as a glowing blanket behind the curve. */
  waveformPeaks?: number[] | null;
  /** Console only: track length, used to place the live playhead on the blanket. */
  durationSec?: number;
}

const W = 640;
const H = 240;
const F_MIN = 20;
const F_MAX = 20000;
const G_MAX = 18;
const CONSOLE_COLORS = ['#2EA8FF', '#3FE0FF', '#8B5CF6', '#C04CFF', '#E040FB', '#5EC8FF', '#2EA8FF', '#8B5CF6'];
const SHAPE_SHORT: Record<EQBandShape, string> = { bell: 'Peak', lowshelf: 'Low shelf', highshelf: 'High shelf', highpass: 'High pass', lowpass: 'Low pass', notch: 'Notch' };
const COLORS = ['#F2CA52', '#FF8A5B', '#7BE0A0', '#6CC4FF', '#C792EA', '#FF6B9A', '#E8E36A', '#5EEAD4'];
const SHAPES: EQBandShape[] = ['bell', 'lowshelf', 'highshelf', 'highpass', 'lowpass', 'notch'];
const SHAPE_LABEL: Record<EQBandShape, string> = { bell: 'Peaking', lowshelf: 'Low shelf', highshelf: 'High shelf', highpass: 'High pass', lowpass: 'Low pass', notch: 'Notch' };

const fToX = (f: number) => (Math.log10(f / F_MIN) / Math.log10(F_MAX / F_MIN)) * W;
const xToF = (x: number) => F_MIN * Math.pow(F_MAX / F_MIN, Math.max(0, Math.min(1, x / W)));
const gToY = (g: number) => H / 2 - (g / G_MAX) * (H / 2 - 10);
const yToG = (y: number) => ((H / 2 - y) / (H / 2 - 10)) * G_MAX;
const usesGain = (s: EQBandShape) => s === 'bell' || s === 'lowshelf' || s === 'highshelf';

function fmtF(f: number) {
  return f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)}k` : f.toFixed(0);
}

export const ParametricEQ2: React.FC<Props> = ({ params, sampleRate, spectrum, onChange, variant = 'classic', waveformPeaks = null, durationSec = 0 }) => {
  const uid = useId().replace(/:/g, '');
  const isConsole = variant === 'console';
  const palette = isConsole ? CONSOLE_COLORS : COLORS;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [sel, setSel] = useState<string | null>(params.bands[0]?.id ?? null);
  const dragRef = useRef<null | { id: string; fine: boolean; sx: number; sy: number; start: EQBand }>(null);
  const bands = params.bands;

  const setBand = (id: string, patch: Partial<EQBand>) =>
    onChange({ ...params, bands: bands.map((b) => (b.id === id ? { ...b, ...patch } : b)) });

  // Curves
  const { total, perBand, totalDb, curveFreqs } = useMemo(() => {
    const N = 220;
    const freqs = Array.from({ length: N }, (_, i) => xToF((i / (N - 1)) * W));
    const per = bands.map((b) => {
      if (!b.enabled) return null;
      const c = designEQBand(b, sampleRate, 1);
      return freqs.map((f) => evaluateBiquadMagnitudeDb(c, f, sampleRate));
    });
    const tilt = params.tiltDb;
    const tl = Math.abs(tilt) > 0.05 ? designLowShelf(650, -tilt * 0.5, 0.55, sampleRate) : null;
    const th = Math.abs(tilt) > 0.05 ? designHighShelf(1500, tilt * 0.5, 0.55, sampleRate) : null;
    const tot = freqs.map((f, i) => {
      let s = 0;
      for (const p of per) if (p) s += p[i];
      if (tl && th) s += evaluateBiquadMagnitudeDb(tl, f, sampleRate) + evaluateBiquadMagnitudeDb(th, f, sampleRate);
      return s;
    });
    return { total: tot.map((g, i) => [fToX(freqs[i]), gToY(Math.max(-G_MAX - 6, Math.min(G_MAX + 6, g)))] as const), perBand: per, totalDb: tot, curveFreqs: freqs };
  }, [bands, params.tiltDb, sampleRate]);

  const spectrumPath = useMemo(() => {
    if (!spectrum || !spectrum.spectrumBinsFreq?.length) return null;
    const fs = spectrum.spectrumBinsFreq;
    const ds = spectrum.spectrumBinsDb;
    let max = -Infinity;
    for (const d of ds) if (d > max) max = d;
    let path = `M0,${H}`;
    for (let i = 0; i < fs.length; i++) {
      if (fs[i] < F_MIN || fs[i] > F_MAX) continue;
      const y = H - Math.max(0, Math.min(1, (ds[i] - (max - 72)) / 72)) * (H - 8);
      path += ` L${fToX(fs[i]).toFixed(1)},${y.toFixed(1)}`;
    }
    return path + ` L${W},${H} Z`;
  }, [spectrum]);

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const onNodeDown = (b: EQBand) => (e: React.PointerEvent) => {
    e.stopPropagation();
    setSel(b.id);
    dragRef.current = { id: b.id, fine: e.shiftKey, sx: e.clientX, sy: e.clientY, start: b };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = toLocal(e);
    const s = d.start;
    if (d.fine) {
      const r = svgRef.current!.getBoundingClientRect();
      const dx = ((e.clientX - d.sx) / r.width) * W * 0.15;
      const dy = ((e.clientY - d.sy) / r.height) * H * 0.15;
      const nf = xToF(fToX(s.freq) + dx);
      const patch: Partial<EQBand> = { freq: Math.round(nf) };
      if (usesGain(s.shape)) patch.gain = Number(Math.max(-G_MAX, Math.min(G_MAX, s.gain - (dy / (H / 2 - 10)) * G_MAX)).toFixed(1));
      setBand(d.id, patch);
      return;
    }
    const patch: Partial<EQBand> = { freq: Math.round(Math.max(F_MIN, Math.min(F_MAX, xToF(p.x)))) };
    if (usesGain(s.shape)) patch.gain = Number(Math.max(-G_MAX, Math.min(G_MAX, yToG(p.y))).toFixed(1));
    else if (s.shape === 'highpass' || s.shape === 'lowpass') patch.q = Number(Math.max(0.3, Math.min(6, 0.707 * Math.pow(2, yToG(p.y) / 6))).toFixed(2));
    setBand(d.id, patch);
  };
  const onUp = () => {
    dragRef.current = null;
  };
  // Mouse wheel over a node = Q. React attaches wheel listeners as passive, so
  // preventDefault there cannot stop the page from scrolling; use a native non-passive
  // listener on the SVG instead and look the band up from the node under the pointer.
  const wheelStateRef = useRef({ bands, setBand });
  wheelStateRef.current = { bands, setBand };
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as Element | null;
      const id = target?.closest?.('[data-band-id]')?.getAttribute('data-band-id');
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      const { bands: current, setBand: set } = wheelStateRef.current;
      const b = current.find((x) => x.id === id);
      if (!b) return;
      const q = Math.max(0.1, Math.min(18, b.q * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      set(b.id, { q: Number(q.toFixed(2)) });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);
  const onDouble = (e: React.MouseEvent) => {
    if (bands.length >= 8) return;
    const p = toLocal(e);
    const nb: EQBand = { id: `b${Date.now().toString(36)}`, enabled: true, shape: 'bell', freq: Math.round(xToF(p.x)), gain: Number(yToG(p.y).toFixed(1)), q: 1 };
    onChange({ ...params, bands: [...bands, nb] });
    setSel(nb.id);
  };

  const selected = bands.find((b) => b.id === sel) ?? null;
  const gridF = [30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000];

  // Waveform "blanket": mirrored envelope of the processed preview (re-rendered, debounced, on
  // every chain change), so the shape visibly reacts to the settings.
  const blanketPath = useMemo(() => {
    if (!isConsole || !waveformPeaks || waveformPeaks.length < 2) return null;
    const N = Math.min(480, waveformPeaks.length);
    const step = waveformPeaks.length / N;
    const env: number[] = [];
    for (let i = 0; i < N; i++) {
      let m = 0;
      const a = Math.floor(i * step);
      const b = Math.max(a + 1, Math.floor((i + 1) * step));
      for (let k = a; k < b && k < waveformPeaks.length; k++) if (waveformPeaks[k] > m) m = waveformPeaks[k];
      env.push(Math.min(1, m));
    }
    const mid = H / 2;
    const amp = H * 0.44;
    let d = `M0,${mid}`;
    for (let i = 0; i < N; i++) d += ` L${((i / (N - 1)) * W).toFixed(1)},${(mid - env[i] * amp).toFixed(1)}`;
    for (let i = N - 1; i >= 0; i--) d += ` L${((i / (N - 1)) * W).toFixed(1)},${(mid + env[i] * amp).toFixed(1)}`;
    return d + ' Z';
  }, [isConsole, waveformPeaks]);
  // Live approximation while the processed render catches up (it is re-rendered offline on
  // every change): estimate the broadband level change of the current EQ curve against the
  // curve the shown blanket was rendered with, weighted by the track's spectrum, and scale the
  // blanket by it immediately. The real render replaces it (and resets the scale) when it lands.
  const [blanketBaseDb, setBlanketBaseDb] = useState<number[] | null>(null);
  const latestTotalDbRef = useRef(totalDb);
  latestTotalDbRef.current = totalDb;
  useEffect(() => {
    setBlanketBaseDb(latestTotalDbRef.current);
  }, [waveformPeaks]);
  const specWeights = useMemo(() => {
    if (!spectrum || !spectrum.spectrumBinsFreq?.length) return curveFreqs.map(() => 1);
    const fs = spectrum.spectrumBinsFreq;
    const ds = spectrum.spectrumBinsDb;
    let j = 0;
    return curveFreqs.map((f) => {
      while (j < fs.length - 1 && fs[j + 1] <= f) j++;
      return Math.pow(10, (ds[j] ?? -120) / 10);
    });
  }, [spectrum, curveFreqs]);
  const blanketScale = useMemo(() => {
    const base = blanketBaseDb;
    if (!isConsole || !base || base.length !== totalDb.length) return 1;
    let eNow = 0;
    let eBase = 0;
    for (let i = 0; i < totalDb.length; i++) {
      const w = specWeights[i] ?? 0;
      eNow += w * Math.pow(10, totalDb[i] / 10);
      eBase += w * Math.pow(10, base[i] / 10);
    }
    if (!(eBase > 0) || !(eNow > 0)) return 1;
    return Math.max(0.5, Math.min(1.4, Math.sqrt(eNow / eBase)));
  }, [isConsole, totalDb, specWeights, blanketBaseDb]);
  const blanketHeadRef = useRef<SVGLineElement | null>(null);
  useEffect(() => {
    if (!isConsole || !durationSec) return;
    const update = (sec: number) => {
      const el = blanketHeadRef.current;
      if (!el) return;
      const x = (Math.max(0, Math.min(1, sec / durationSec)) * W).toFixed(1);
      el.setAttribute('x1', x);
      el.setAttribute('x2', x);
    };
    update(telemetryStore.getSnapshot().currentTimeSec);
    return telemetryStore.subscribe((snap) => update(snap.currentTimeSec));
  }, [isConsole, durationSec]);

  const nudgeBand = (b: EQBand, e: React.KeyboardEvent) => {
    const fine = e.shiftKey;
    let patch: Partial<EQBand> | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const ratio = fine ? 1.01 : 1.06;
      const f = e.key === 'ArrowRight' ? b.freq * ratio : b.freq / ratio;
      patch = { freq: Math.round(Math.max(F_MIN, Math.min(F_MAX, f))) };
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && usesGain(b.shape)) {
      const d = (fine ? 0.1 : 0.5) * (e.key === 'ArrowUp' ? 1 : -1);
      patch = { gain: Number(Math.max(-G_MAX, Math.min(G_MAX, b.gain + d)).toFixed(1)) };
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      const q = b.q * (e.key === '-' ? 1 / 1.12 : 1.12);
      patch = { q: Number(Math.max(0.1, Math.min(18, q)).toFixed(2)) };
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onChange({ ...params, bands: bands.filter((x) => x.id !== b.id) });
      return;
    }
    if (patch) {
      e.preventDefault();
      setBand(b.id, patch);
    }
  };

  const nodeY = (b: EQBand) =>
    usesGain(b.shape) ? gToY(b.gain) : b.shape === 'notch' ? gToY(-G_MAX + 2) : gToY(6 * Math.log2(b.q / 0.707));

  if (isConsole) {
    const consoleGridF = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    const addBand = () => {
      const nb: EQBand = { id: `b${Date.now().toString(36)}`, enabled: true, shape: 'bell', freq: 1000, gain: 0, q: 1 };
      onChange({ ...params, bands: [...bands, nb] });
      setSel(nb.id);
    };
    return (
      <div className="syn-ceq">
        <div className="syn-ceq-plot">
          <span className="syn-ceq-axis-y" aria-hidden="true">GAIN (dB)</span>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="syn-ceq-svg"
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onDoubleClick={onDouble}
            role="group"
            aria-label="Parametric EQ. Tab to a band node; arrow keys move frequency and gain, plus and minus change Q, Delete removes. Drag nodes with the mouse, wheel for Q, double-click to add a band."
          >
            <defs>
              <linearGradient id={`${uid}-curve`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="#2EA8FF" />
                <stop offset="35%" stopColor="#3FE0FF" />
                <stop offset="65%" stopColor="#8B5CF6" />
                <stop offset="100%" stopColor="#E040FB" />
              </linearGradient>
              <linearGradient id={`${uid}-spec`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="#2EA8FF" />
                <stop offset="50%" stopColor="#8B5CF6" />
                <stop offset="100%" stopColor="#2EA8FF" />
              </linearGradient>
              <linearGradient id={`${uid}-blanket`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#8B5CF6" stopOpacity={0.42} />
                <stop offset="50%" stopColor="#2EA8FF" stopOpacity={0.18} />
                <stop offset="100%" stopColor="#8B5CF6" stopOpacity={0.42} />
              </linearGradient>
              <linearGradient id={`${uid}-area`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#3FE0FF" stopOpacity={0.22} />
                <stop offset="100%" stopColor="#E040FB" stopOpacity={0} />
              </linearGradient>
              <filter id={`${uid}-soft`} x="-5%" y="-20%" width="110%" height="140%">
                <feGaussianBlur stdDeviation="1.6" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <filter id={`${uid}-glow`} x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="2.2" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>
            {consoleGridF.map((f) => (
              <line key={f} x1={fToX(f)} x2={fToX(f)} y1={0} y2={H} className="syn-ceq-grid" />
            ))}
            {[-12, -6, 0, 6, 12].map((g) => (
              <line key={g} x1={0} x2={W} y1={gToY(g)} y2={gToY(g)} className={g === 0 ? 'syn-ceq-grid is-zero' : 'syn-ceq-grid'} />
            ))}
            {blanketPath && (
              <g className="syn-ceq-blanket" pointerEvents="none">
                <path d={blanketPath} className="syn-ceq-blanket-path" data-live={Math.abs(blanketScale - 1) > 0.005 ? 'true' : 'false'}
                  transform={Math.abs(blanketScale - 1) > 0.005 ? `translate(0 ${H / 2}) scale(1 ${blanketScale.toFixed(4)}) translate(0 ${-H / 2})` : undefined}
                  fill={`url(#${uid}-blanket)`} stroke={`url(#${uid}-spec)`} strokeWidth={0.8} strokeOpacity={0.5} filter={`url(#${uid}-soft)`} />
                {durationSec > 0 && <line ref={blanketHeadRef} x1={0} x2={0} y1={0} y2={H} className="syn-ceq-playhead" />}
              </g>
            )}
            <path
              d={`${total.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} L${W},${gToY(0)} L0,${gToY(0)} Z`}
              fill={`url(#${uid}-area)`}
              pointerEvents="none"
            />
            <path
              d={total.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
              fill="none"
              stroke={`url(#${uid}-curve)`}
              strokeWidth={2.4}
              filter={`url(#${uid}-glow)`}
            />
            {bands.map((b, i) => {
              const x = fToX(Math.max(F_MIN, Math.min(F_MAX, b.freq)));
              const y = nodeY(b);
              const color = palette[i % palette.length];
              return (
                <g key={b.id} opacity={b.enabled ? 1 : 0.35}>
                  <line x1={x} x2={x} y1={y} y2={H} stroke={color} strokeOpacity={0.25} strokeDasharray="2 3" />
                  <circle
                    cx={x}
                    cy={y}
                    r={b.id === sel ? 9 : 7.5}
                    fill="#05070D"
                    stroke={color}
                    strokeWidth={2.4}
                    className="syn-ceq-node"
                    style={{ cursor: 'grab', color }}
                    tabIndex={0}
                    role="button"
                    aria-label={`Band ${i + 1}, ${SHAPE_LABEL[b.shape]}, ${fmtF(b.freq)} Hz${usesGain(b.shape) ? `, ${b.gain.toFixed(1)} dB` : ''}, Q ${b.q.toFixed(2)}${b.enabled ? '' : ', off'}`}
                    aria-pressed={b.id === sel}
                    onFocus={() => setSel(b.id)}
                    onKeyDown={(e) => nudgeBand(b, e)}
                    onPointerDown={onNodeDown(b)}
                    data-band-id={b.id}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      if (usesGain(b.shape)) setBand(b.id, { gain: 0 });
                    }}
                  />
                  <text x={x} y={y + 3} fontSize={8} textAnchor="middle" fill={color} fontWeight={800} pointerEvents="none">{i + 1}</text>
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
            {consoleGridF.map((f) => (
              <span key={f} className={f === 50 || f === 200 || f === 2000 ? 'is-minor' : undefined} style={{ left: `${(fToX(f) / W) * 100}%` }}>{f >= 1000 ? `${f / 1000}k` : f}</span>
            ))}
          </div>
        </div>
        <div className="syn-ceq-axis-x" aria-hidden="true">FREQUENCY (Hz)</div>

        <div className="syn-ceq-table" role="list" aria-label="EQ bands">
          {bands.map((b, i) => {
            const color = palette[i % palette.length];
            return (
              <div
                key={b.id}
                role="listitem"
                className={`syn-ceq-band${b.id === sel ? ' is-sel' : ''}${b.enabled ? '' : ' is-off'}`}
                style={{ ['--band-color' as string]: color }}
                onClick={() => setSel(b.id)}
              >
                <div className="syn-ceq-band-head">
                  <label className="syn-ceq-band-on">
                    <input type="checkbox" checked={b.enabled} onChange={(e) => setBand(b.id, { enabled: e.target.checked })} aria-label={`Band ${i + 1} enabled`} />
                    <span>{i + 1}</span>
                  </label>
                  <select value={b.shape} onChange={(e) => setBand(b.id, { shape: e.target.value as EQBandShape })} aria-label={`Band ${i + 1} type`}>
                    {SHAPES.map((sh) => (
                      <option key={sh} value={sh}>{SHAPE_SHORT[sh]}</option>
                    ))}
                  </select>
                </div>
                <label className="syn-ceq-row">
                  <span>FREQ</span>
                  <input type="number" min={F_MIN} max={F_MAX} value={b.freq} aria-label={`Band ${i + 1} frequency (Hz)`} onChange={(e) => setBand(b.id, { freq: Math.max(F_MIN, Math.min(F_MAX, Number(e.target.value) || 1000)) })} />
                </label>
                <label className="syn-ceq-row">
                  <span>GAIN</span>
                  <input type="number" step={0.1} min={-G_MAX} max={G_MAX} value={b.gain} disabled={!usesGain(b.shape)} aria-label={`Band ${i + 1} gain (dB)`} onChange={(e) => setBand(b.id, { gain: Math.max(-G_MAX, Math.min(G_MAX, Number(e.target.value) || 0)) })} />
                </label>
                <label className="syn-ceq-row">
                  <span>Q</span>
                  <input type="number" step={0.05} min={0.1} max={18} value={b.q} aria-label={`Band ${i + 1} Q`} className="is-q" onChange={(e) => setBand(b.id, { q: Math.max(0.1, Math.min(18, Number(e.target.value) || 1)) })} />
                </label>
                <button type="button" className="syn-ceq-del" aria-label={`Delete band ${i + 1}`} onClick={(e) => { e.stopPropagation(); onChange({ ...params, bands: bands.filter((x) => x.id !== b.id) }); }}>
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}
          {bands.length < 8 && (
            <button type="button" className="syn-ceq-add" onClick={addBand}>+ Band</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="syn2-peq">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="syn2-peq-svg"
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={onDouble}
        role="application"
        aria-label="Parametric EQ: drag nodes to set frequency and gain, mouse wheel for Q, double-click to add a band"
      >
        <rect x={0} y={0} width={W} height={H} fill="#070604" />
        {spectrumPath && <path d={spectrumPath} fill="rgba(212,175,55,0.16)" stroke="rgba(212,175,55,0.35)" strokeWidth={0.8} />}
        {gridF.map((f) => (
          <g key={f}>
            <line x1={fToX(f)} x2={fToX(f)} y1={0} y2={H} stroke="rgba(212,175,55,0.10)" />
            <text x={fToX(f) + 2} y={H - 3} fontSize={8} fill="#8F7D50" fontFamily="JetBrains Mono, monospace">{fmtF(f)}</text>
          </g>
        ))}
        {[-12, -6, 0, 6, 12].map((g) => (
          <g key={g}>
            <line x1={0} x2={W} y1={gToY(g)} y2={gToY(g)} stroke={g === 0 ? 'rgba(212,175,55,0.35)' : 'rgba(212,175,55,0.08)'} />
            <text x={3} y={gToY(g) - 2} fontSize={8} fill="#8F7D50" fontFamily="JetBrains Mono, monospace">{g > 0 ? `+${g}` : g}</text>
          </g>
        ))}
        {perBand.map((curve, i) =>
          curve ? (
            <path
              key={bands[i].id}
              d={curve.map((g, k) => `${k ? 'L' : 'M'}${((k / (curve.length - 1)) * W).toFixed(1)},${gToY(Math.max(-G_MAX - 6, Math.min(G_MAX + 6, g))).toFixed(1)}`).join(' ') + ` L${W},${H / 2} L0,${H / 2} Z`}
              fill={COLORS[i % COLORS.length]}
              fillOpacity={bands[i].id === sel ? 0.14 : 0.05}
              stroke="none"
            />
          ) : null,
        )}
        <path d={total.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} fill="none" stroke="#FFE08A" strokeWidth={2} />
        {bands.map((b, i) => {
          const x = fToX(Math.max(F_MIN, Math.min(F_MAX, b.freq)));
          const y = nodeY(b);
          return (
            <g key={b.id} opacity={b.enabled ? 1 : 0.35}>
              <circle
                cx={x}
                cy={y}
                r={b.id === sel ? 9 : 7}
                fill={COLORS[i % COLORS.length]}
                stroke="#0A0804"
                strokeWidth={2}
                style={{ cursor: 'grab' }}
                onPointerDown={onNodeDown(b)}
                data-band-id={b.id}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (usesGain(b.shape)) setBand(b.id, { gain: 0 });
                }}
              />
              <text x={x} y={y + 3} fontSize={8} textAnchor="middle" fill="#0A0804" fontWeight={800} pointerEvents="none">{i + 1}</text>
            </g>
          );
        })}
      </svg>

      <div className="syn2-peq-strip">
        {bands.map((b, i) => (
          <button
            key={b.id}
            type="button"
            className={`syn2-peq-tab ${b.id === sel ? 'is-sel' : ''} ${b.enabled ? '' : 'is-off'}`}
            style={{ borderColor: COLORS[i % COLORS.length] }}
            onClick={() => setSel(b.id)}
          >
            <span style={{ background: COLORS[i % COLORS.length] }} />
            {i + 1}
          </button>
        ))}
        {bands.length < 8 && (
          <button
            type="button"
            className="syn2-peq-tab"
            onClick={() => {
              const nb: EQBand = { id: `b${Date.now().toString(36)}`, enabled: true, shape: 'bell', freq: 1000, gain: 0, q: 1 };
              onChange({ ...params, bands: [...bands, nb] });
              setSel(nb.id);
            }}
          >
            + band
          </button>
        )}
      </div>

      {selected && (
        <div className="syn2-peq-edit">
          <label className="syn2-peq-field">
            <span>On</span>
            <input type="checkbox" checked={selected.enabled} onChange={(e) => setBand(selected.id, { enabled: e.target.checked })} />
          </label>
          <label className="syn2-peq-field">
            <span>Type</span>
            <select value={selected.shape} onChange={(e) => setBand(selected.id, { shape: e.target.value as EQBandShape })}>
              {SHAPES.map((s) => (
                <option key={s} value={s}>{SHAPE_LABEL[s]}</option>
              ))}
            </select>
          </label>
          <label className="syn2-peq-field">
            <span>Freq</span>
            <input type="number" min={F_MIN} max={F_MAX} value={selected.freq} onChange={(e) => setBand(selected.id, { freq: Math.max(F_MIN, Math.min(F_MAX, Number(e.target.value) || 1000)) })} />
          </label>
          <label className="syn2-peq-field">
            <span>Gain</span>
            <input type="number" step={0.1} min={-G_MAX} max={G_MAX} value={selected.gain} disabled={!usesGain(selected.shape)} onChange={(e) => setBand(selected.id, { gain: Math.max(-G_MAX, Math.min(G_MAX, Number(e.target.value) || 0)) })} />
          </label>
          <label className="syn2-peq-field">
            <span>Q</span>
            <input type="number" step={0.05} min={0.1} max={18} value={selected.q} onChange={(e) => setBand(selected.id, { q: Math.max(0.1, Math.min(18, Number(e.target.value) || 1)) })} />
          </label>
          <button type="button" className="syn2-peq-del" aria-label="Delete band" onClick={() => onChange({ ...params, bands: bands.filter((b) => b.id !== selected.id) })}>
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      <div className="syn2-peq-help">Drag nodes · wheel = Q · Shift-drag = fine · double-click = add band / reset gain</div>
    </div>
  );
};
