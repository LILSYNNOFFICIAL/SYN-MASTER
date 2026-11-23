import React, { useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { AudioAnalysis, EQBand, EQBandShape, ParametricEQParams } from '../../types/mastering';
import { designEQBand } from '../../dsp/offlineDsp';
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
}

const W = 640;
const H = 240;
const F_MIN = 20;
const F_MAX = 20000;
const G_MAX = 18;
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

export const ParametricEQ2: React.FC<Props> = ({ params, sampleRate, spectrum, onChange }) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [sel, setSel] = useState<string | null>(params.bands[0]?.id ?? null);
  const dragRef = useRef<null | { id: string; fine: boolean; sx: number; sy: number; start: EQBand }>(null);
  const bands = params.bands;

  const setBand = (id: string, patch: Partial<EQBand>) =>
    onChange({ ...params, bands: bands.map((b) => (b.id === id ? { ...b, ...patch } : b)) });

  // Curves
  const { total, perBand } = useMemo(() => {
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
    return { total: tot.map((g, i) => [fToX(freqs[i]), gToY(Math.max(-G_MAX - 6, Math.min(G_MAX + 6, g)))] as const), perBand: per };
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
  const onWheelNode = (b: EQBand) => (e: React.WheelEvent) => {
    e.preventDefault();
    const q = Math.max(0.1, Math.min(18, b.q * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    setBand(b.id, { q: Number(q.toFixed(2)) });
  };
  const onDouble = (e: React.MouseEvent) => {
    if (bands.length >= 8) return;
    const p = toLocal(e);
    const nb: EQBand = { id: `b${Date.now().toString(36)}`, enabled: true, shape: 'bell', freq: Math.round(xToF(p.x)), gain: Number(yToG(p.y).toFixed(1)), q: 1 };
    onChange({ ...params, bands: [...bands, nb] });
    setSel(nb.id);
  };

  const selected = bands.find((b) => b.id === sel) ?? null;
  const gridF = [30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000];

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
          const y = usesGain(b.shape) ? gToY(b.gain) : b.shape === 'notch' ? gToY(-G_MAX + 2) : gToY(6 * Math.log2(b.q / 0.707));
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
                onWheel={onWheelNode(b)}
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
