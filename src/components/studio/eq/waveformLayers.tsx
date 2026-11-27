/**
 * Lazy-loaded extra layers for the EQ graph (kept out of the main bundle):
 * - NeonFill: frequency-colored translucent fill under the analyser's neon outline.
 * - LoudnessTint: waveform tinted by RMS loudness per column (blue quiet > magenta/gold loud).
 * - FadeLabel: fade length in seconds, shown on the fade curve while hovering or dragging.
 * Display only. No blur, no animation (cheap on phones, nothing to reduce for reduced-motion).
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { FadeSettings } from '../../../dsp/fades';
import { H, W, fToX } from './graphMath';
import { fadeGainAt, secToX, type TimeView } from './waveformView';
import type { WaveformSource } from './waveformSource';
import { FREQ_FILL_STOPS, tintStops } from './waveformTint';

export const NeonFill: React.FC<{ uid: string; d: string }> = ({ uid, d }) => (
  <g pointerEvents="none" data-neon-fill="freq">
    <linearGradient id={`${uid}-nfx`} x1={0} x2={W} y1={0} y2={0} gradientUnits="userSpaceOnUse">
      {FREQ_FILL_STOPS.map(([f, c]) => <stop key={f} offset={Math.max(0, Math.min(1, fToX(f) / W)).toFixed(3)} stopColor={c} />)}
    </linearGradient>
    <linearGradient id={`${uid}-nfy`} x1={0} x2={0} y1={0} y2={1}>
      <stop offset="0%" stopColor="#fff" stopOpacity={0.62} />
      <stop offset="45%" stopColor="#fff" stopOpacity={0.26} />
      <stop offset="100%" stopColor="#fff" stopOpacity={0} />
    </linearGradient>
    <mask id={`${uid}-nfm`} maskContentUnits="objectBoundingBox">
      <rect width={1} height={1} fill={`url(#${uid}-nfy)`} />
    </mask>
    <path d={d} fill={`url(#${uid}-nfx)`} mask={`url(#${uid}-nfm)`} className="syn-wf-neon-fill" />
  </g>
);

interface TintProps {
  uid: string;
  d: string;
  /** Peak envelope of the drawn columns (fallback loudness when no audio is linked). */
  env: number[];
  view: TimeView;
  durationSec: number;
  source: WaveformSource | null;
  fades?: FadeSettings;
  scaleByFades: boolean;
}

/** Typical crest factor of mixed music (~9 dB) to estimate RMS from peaks when no audio is linked. */
const PEAK_TO_RMS = 0.35;

export const LoudnessTint: React.FC<TintProps> = ({ uid, d, env, view, durationSec, source, fades, scaleByFades }) => {
  const [rms, setRms] = useState<null | { key: unknown; start: number; end: number; levels: number[] }>(null);
  useEffect(() => {
    if (!source || !(durationSec > 0)) return;
    let cancelled = false;
    const target = { ...view };
    const timer = window.setTimeout(() => {
      void import('./waveformDetail').then(async (m) => {
        const energy = await m.ensureEnergyBlocks(source.channels);
        if (cancelled) return;
        setRms({ key: source, start: target.start, end: target.end, levels: m.rmsFromSamples(source.channels, source.sampleRate, target, 240, energy) });
      });
    }, 60);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [source, view, durationSec]);
  const stops = useMemo(() => {
    const fresh = rms && rms.key === source && Math.abs(rms.start - view.start) < 1e-9 && Math.abs(rms.end - view.end) < 1e-9;
    const levels = fresh ? rms.levels.slice() : env.map((v) => v * PEAK_TO_RMS);
    // The fallback envelope is already fade-scaled by the graph; real RMS is pre-fade audio.
    if (fresh && scaleByFades && fades && durationSec > 0) {
      const span = view.end - view.start;
      for (let i = 0; i < levels.length; i++) levels[i] *= fadeGainAt(view.start + ((i + 0.5) / levels.length) * span, durationSec, fades);
    }
    return tintStops(levels, 96);
  }, [rms, source, env, view, scaleByFades, fades, durationSec]);
  if (!stops.length) return null;
  return (
    <g pointerEvents="none" data-waveform-tint="loudness">
      <linearGradient id={`${uid}-tint`} x1={0} x2={W} y1={0} y2={0} gradientUnits="userSpaceOnUse">
        {stops.map((s, i) => <stop key={i} offset={s.offset.toFixed(4)} stopColor={s.color} stopOpacity={s.opacity} />)}
      </linearGradient>
      <path d={d} fill={`url(#${uid}-tint)`} stroke="none" className="syn-wf-tint" />
    </g>
  );
};

/** Fade length label pinned to the middle of the fade curve (HTML, so it is never stretched). */
export const FadeLabel: React.FC<{ side: 'in' | 'out'; fades: FadeSettings; durationSec: number; view: TimeView; svg: SVGSVGElement | null }> = ({ side, fades, durationSec, view, svg }) => {
  const len = side === 'in' ? fades.inSec : fades.outSec;
  const host = svg?.parentElement;
  if (!svg || !host || !(durationSec > 0)) return null;
  const r = svg.getBoundingClientRect();
  const hr = host.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const t0 = side === 'in' ? 0 : durationSec - len;
  const mid = Math.max(view.start, Math.min(view.end, t0 + len / 2));
  const x = len > 0 ? secToX(mid, view, W) : secToX(side === 'in' ? 0 : durationSec, view, W);
  const y = len > 0 ? H - fadeGainAt(mid, durationSec, fades) * H : side === 'in' ? 12 : 28;
  const left = Math.max(38, Math.min(hr.width - 38, r.left - hr.left + (x / W) * r.width));
  const top = r.top - hr.top + (y / H) * r.height;
  const below = top < 22;
  return (
    <span className={`syn-wf-fade-label${below ? ' is-below' : ''}`} style={{ left, top }} data-fade-label={side} aria-hidden="true">
      {side === 'in' ? 'Fade in' : 'Fade out'} <b>{len.toFixed(2)} s</b>
    </span>
  );
};

/** Single lazy entry for the graph (one React.lazy wrapper keeps the main chunk small). */
type LayerProps =
  | ({ kind: 'fill' } & React.ComponentProps<typeof NeonFill>)
  | ({ kind: 'tint' } & TintProps)
  | ({ kind: 'label' } & React.ComponentProps<typeof FadeLabel>);
export default function WaveformLayer(p: LayerProps) {
  return p.kind === 'fill' ? <NeonFill {...p} /> : p.kind === 'tint' ? <LoudnessTint {...p} /> : <FadeLabel {...p} />;
}
