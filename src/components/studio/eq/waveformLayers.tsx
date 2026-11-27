/**
 * Lazy-loaded extra layers for the EQ graph (kept out of the main bundle):
 * - NeonFill: frequency-colored translucent fill under the analyser's neon outline.
 * - LoudnessTint: bright NEON BLUE body clipped to the waveform (blue/cyan shimmer along time, a
 *   brighter ice-blue core on the center line, soft cyan blobs on the loudest moments) plus a cheap
 *   edge bloom (duplicated low-opacity strokes, no blur). RMS loudness drives brightness and glow
 *   (quiet = dim, loud = bright).
 * - FadeLabel: fade length in seconds, shown on the fade curve while hovering or dragging.
 * Display only. No blur, no animation (cheap on phones, nothing to reduce for reduced-motion).
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { FadeSettings } from '../../../dsp/fades';
import { H, W, fToX } from './graphMath';
import { fadeGainAt, secToX, type TimeView } from './waveformView';
import type { WaveformSource } from './waveformSource';
import { FREQ_FILL_STOPS, meshBlobs, meshColor, meshGlowStops, meshHueStops, meshRate, NEON_BLUE_CORE, NEON_BLUE_GLOW } from './waveformTint';

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
  const levels = useMemo(() => {
    const fresh = rms && rms.key === source && Math.abs(rms.start - view.start) < 1e-9 && Math.abs(rms.end - view.end) < 1e-9;
    const lv = fresh ? rms.levels.slice() : env.map((v) => v * PEAK_TO_RMS);
    // The fallback envelope is already fade-scaled by the graph; real RMS is pre-fade audio.
    if (fresh && scaleByFades && fades && durationSec > 0) {
      const span = view.end - view.start;
      for (let i = 0; i < lv.length; i++) lv[i] *= fadeGainAt(view.start + ((i + 0.5) / lv.length) * span, durationSec, fades);
    }
    return lv;
  }, [rms, source, env, view, scaleByFades, fades, durationSec]);
  const mesh = useMemo(() => {
    if (!levels.length) return null;
    const span = view.end - view.start;
    const rate = meshRate(durationSec > 0 ? span : 1, durationSec);
    return {
      core: meshHueStops(view, durationSec, 40, 0),
      edge: meshHueStops(view, durationSec, 40, 0.5),
      glow: meshGlowStops(levels, 64),
      blobs: meshBlobs(levels, 3).map((b) => ({
        ...b,
        // Blob hue = palette half a trip away from the time hue there (contrast, still blue/cyan).
        color: meshColor((durationSec > 0 ? view.start + b.x * span : b.x) * rate + 0.5),
      })),
    };
  }, [levels, view, durationSec]);
  if (!mesh) return null;
  const id = (k: string) => `${uid}-m${k}`;
  return (
    <g pointerEvents="none" data-waveform-tint="loudness" data-waveform-mesh="neon" data-waveform-color="neon-blue">
      <defs>
        <clipPath id={id('clip')}><path d={d} /></clipPath>
        <linearGradient id={id('core')} x1={0} x2={W} y1={0} y2={0} gradientUnits="userSpaceOnUse">
          {mesh.core.map((s, i) => <stop key={i} offset={s.offset.toFixed(4)} stopColor={s.color} />)}
        </linearGradient>
        <linearGradient id={id('edge')} x1={0} x2={W} y1={0} y2={0} gradientUnits="userSpaceOnUse">
          {mesh.edge.map((s, i) => <stop key={i} offset={s.offset.toFixed(4)} stopColor={s.color} />)}
        </linearGradient>
        {/* Center line > peaks: the shifted hue takes over away from the middle. */}
        <linearGradient id={id('ev')} x1={0} x2={0} y1={0} y2={H} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity={1} />
          <stop offset="0.33" stopColor="#fff" stopOpacity={0.95} />
          <stop offset="0.5" stopColor="#fff" stopOpacity={0} />
          <stop offset="0.67" stopColor="#fff" stopOpacity={0.95} />
          <stop offset="1" stopColor="#fff" stopOpacity={1} />
        </linearGradient>
        <mask id={id('edgem')} maskUnits="userSpaceOnUse" x={0} y={0} width={W} height={H}>
          <rect width={W} height={H} fill={`url(#${id('ev')})`} />
        </mask>
        {/* Loudness: quiet columns dim, loud columns bright. */}
        <linearGradient id={id('glow')} x1={0} x2={W} y1={0} y2={0} gradientUnits="userSpaceOnUse">
          {mesh.glow.map((s, i) => <stop key={i} offset={s.offset.toFixed(4)} stopColor="#fff" stopOpacity={s.opacity} />)}
        </linearGradient>
        <mask id={id('glowm')} maskUnits="userSpaceOnUse" x={0} y={0} width={W} height={H}>
          <rect width={W} height={H} fill={`url(#${id('glow')})`} />
        </mask>
        {/* Bright ice-blue core along the center line (the hot middle of the neon tube). */}
        <linearGradient id={id('cv')} x1={0} x2={0} y1={0} y2={H} gradientUnits="userSpaceOnUse">
          <stop offset="0.3" stopColor={NEON_BLUE_CORE} stopOpacity={0} />
          <stop offset="0.44" stopColor={NEON_BLUE_CORE} stopOpacity={0.4} />
          <stop offset="0.5" stopColor="#E6F8FF" stopOpacity={0.62} />
          <stop offset="0.56" stopColor={NEON_BLUE_CORE} stopOpacity={0.4} />
          <stop offset="0.7" stopColor={NEON_BLUE_CORE} stopOpacity={0} />
        </linearGradient>
        {mesh.blobs.map((b, i) => (
          <radialGradient key={i} id={id(`b${i}`)} cx={b.x * W} cy={H / 2} r={W * (0.1 + 0.08 * b.t)} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={b.color} stopOpacity={(0.35 + 0.4 * b.t).toFixed(3)} />
            <stop offset="0.55" stopColor={b.color} stopOpacity={(0.12 + 0.14 * b.t).toFixed(3)} />
            <stop offset="1" stopColor={b.color} stopOpacity={0} />
          </radialGradient>
        ))}
      </defs>
      <g clipPath={`url(#${id('clip')})`} mask={`url(#${id('glowm')})`} className="syn-wf-tint" opacity={0.84}>
        <rect width={W} height={H} fill={`url(#${id('core')})`} />
        <rect width={W} height={H} fill={`url(#${id('edge')})`} mask={`url(#${id('edgem')})`} />
        {mesh.blobs.map((b, i) => <rect key={i} width={W} height={H} fill={`url(#${id(`b${i}`)})`} data-mesh-blob={i} />)}
        <rect width={W} height={H} fill={`url(#${id('cv')})`} />
      </g>
      {/* Edge bloom: wide faint strokes + a thin bright rim (no blur filter: cheap on phones). Loudness mask: loud = more glow. */}
      <g mask={`url(#${id('glowm')})`} className="syn-wf-tint" data-waveform-glow="blue" fill="none" strokeLinejoin="round">
        <path d={d} stroke={NEON_BLUE_GLOW} strokeOpacity={0.12} strokeWidth={9} vectorEffect="non-scaling-stroke" />
        <path d={d} stroke={NEON_BLUE_GLOW} strokeOpacity={0.24} strokeWidth={4.5} vectorEffect="non-scaling-stroke" />
        <path d={d} stroke={NEON_BLUE_CORE} strokeOpacity={0.85} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />
      </g>
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
