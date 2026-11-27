/**
 * Waveform timeline view math for the EQ graph's waveform layer (FL Studio style zoom).
 * Pure functions only: the EQ curve stays frequency-based; only the time layer
 * (waveform, fades, playhead, seeking) uses the visible time window.
 */
import { fadeGain, type FadeSettings } from '../../../dsp/fades';

export interface TimeView {
  /** Visible window start, seconds. */
  start: number;
  /** Visible window end, seconds. */
  end: number;
}

/** Smallest visible window: 100 ms, or the whole track when it is shorter. */
export function minViewSpan(durationSec: number): number {
  return Math.min(Math.max(0, durationSec), 0.1);
}

export function fullView(durationSec: number): TimeView {
  return { start: 0, end: Math.max(0, durationSec) };
}

export function isFullView(view: TimeView, durationSec: number): boolean {
  return view.start <= 1e-6 && view.end >= durationSec - 1e-6;
}

/** Keep the window inside the track and no narrower than the minimum span. */
export function clampView(view: TimeView, durationSec: number): TimeView {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return { start: 0, end: 0 };
  const minSpan = minViewSpan(durationSec);
  let span = Number.isFinite(view.end - view.start) ? view.end - view.start : durationSec;
  span = Math.max(minSpan, Math.min(durationSec, span));
  let start = Number.isFinite(view.start) ? view.start : 0;
  start = Math.max(0, Math.min(durationSec - span, start));
  return { start, end: start + span };
}

/** Zoom by `factor` (>1 zooms in) keeping `anchorSec` under the same screen position. */
export function zoomAround(view: TimeView, anchorSec: number, factor: number, durationSec: number): TimeView {
  const span = view.end - view.start;
  if (!(span > 0) || !Number.isFinite(factor) || factor <= 0) return clampView(view, durationSec);
  const anchor = Math.max(view.start, Math.min(view.end, anchorSec));
  const frac = (anchor - view.start) / span;
  const nextSpan = Math.max(minViewSpan(durationSec), Math.min(durationSec, span / factor));
  return clampView({ start: anchor - frac * nextSpan, end: anchor - frac * nextSpan + nextSpan }, durationSec);
}

export function panBy(view: TimeView, deltaSec: number, durationSec: number): TimeView {
  if (!Number.isFinite(deltaSec)) return clampView(view, durationSec);
  return clampView({ start: view.start + deltaSec, end: view.end + deltaSec }, durationSec);
}

export function secToX(sec: number, view: TimeView, width: number): number {
  const span = view.end - view.start;
  return span > 0 ? ((sec - view.start) / span) * width : 0;
}

export function xToSec(x: number, view: TimeView, width: number): number {
  return width > 0 ? view.start + (x / width) * (view.end - view.start) : view.start;
}

/** Wheel delta in pixels regardless of deltaMode (0 px, 1 line, 2 page). */
export function wheelPixels(delta: number, deltaMode: number, pageSize = 800): number {
  return deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * pageSize : delta;
}

/** Ctrl/pinch wheel zoom factor: smooth, symmetric (in then out returns to the same span). */
export function wheelZoomFactor(deltaPixels: number): number {
  return Math.exp(-Math.max(-600, Math.min(600, deltaPixels)) * 0.0022);
}

/** Gain the master fades apply at a time (1 outside the fades). Same law as the render. */
export function fadeGainAt(sec: number, durationSec: number, fades: FadeSettings | null | undefined): number {
  if (!fades || durationSec <= 0) return 1;
  let g = 1;
  if (fades.inSec > 0 && sec < fades.inSec) g *= fadeGain(sec / fades.inSec, fades.inCurve);
  const fromEnd = durationSec - sec;
  if (fades.outSec > 0 && fromEnd < fades.outSec) g *= fadeGain(fromEnd / fades.outSec, fades.outCurve);
  return Math.max(0, Math.min(1, g));
}

/**
 * Envelope values (0..1) for `bins` columns across the view, read from the whole-track
 * peak array (max over the covered peak bins; nearest bin when zoomed past its resolution).
 */
export function envelopeFromGlobalPeaks(peaks: ArrayLike<number>, durationSec: number, view: TimeView, bins: number): number[] {
  const out: number[] = new Array(Math.max(0, bins)).fill(0);
  const len = peaks.length;
  if (!len || durationSec <= 0 || bins <= 0) return out;
  const span = view.end - view.start;
  for (let i = 0; i < bins; i++) {
    const t0 = view.start + (i / bins) * span;
    const t1 = view.start + ((i + 1) / bins) * span;
    const a = Math.max(0, Math.min(len - 1, Math.floor((t0 / durationSec) * len)));
    const b = Math.max(a + 1, Math.min(len, Math.ceil((t1 / durationSec) * len)));
    let m = 0;
    for (let k = a; k < b; k++) if (peaks[k] > m) m = peaks[k];
    out[i] = Math.min(1, m);
  }
  return out;
}

/** Mirrored blanket path (upper and lower edge) for envelope columns spread across width. */
export function blanketPathFromEnvelope(env: number[], width: number, height: number): string | null {
  const N = env.length;
  if (N < 2) return null;
  const mid = height / 2;
  const amp = height * 0.44;
  let d = `M0,${mid}`;
  for (let i = 0; i < N; i++) d += ` L${((i / (N - 1)) * width).toFixed(1)},${(mid - env[i] * amp).toFixed(1)}`;
  for (let i = N - 1; i >= 0; i--) d += ` L${((i / (N - 1)) * width).toFixed(1)},${(mid + env[i] * amp).toFixed(1)}`;
  return d + ' Z';
}

export interface FadeGeometry {
  /** Fade line (gain law, bottom = silence, top = unity) in view coordinates. */
  line: string;
  /** Region above the line (the attenuated part), for shading. */
  shade: string;
  /** Screen x of the region edges. */
  x0: number;
  x1: number;
  /** Gradient stops along the region: offset 0..1 and attenuation 0..1 (1 = silent). */
  stops: Array<{ offset: number; attenuation: number }>;
}

/**
 * Smooth fade geometry sampled from the exact render gain law. `side` 'in' runs from the
 * track start; 'out' ends at the track end. Returns null when the fade is off or off-screen.
 */
export function fadeGeometry(
  side: 'in' | 'out',
  fades: FadeSettings,
  durationSec: number,
  view: TimeView,
  width: number,
  height: number,
  steps = 160,
): FadeGeometry | null {
  const len = side === 'in' ? fades.inSec : fades.outSec;
  if (!(len > 0) || durationSec <= 0) return null;
  const curve = side === 'in' ? fades.inCurve : fades.outCurve;
  const t0 = side === 'in' ? 0 : durationSec - len;
  const t1 = side === 'in' ? Math.min(durationSec, len) : durationSec;
  const vis0 = Math.max(t0, view.start);
  const vis1 = Math.min(t1, view.end);
  if (vis1 <= vis0) return null;
  const gainAt = (sec: number) => fadeGain(side === 'in' ? (sec - t0) / len : (t1 - sec) / len, curve);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const sec = vis0 + ((vis1 - vis0) * i) / steps;
    pts.push([secToX(sec, view, width), height - gainAt(sec) * height]);
  }
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const x0 = pts[0][0];
  const x1 = pts[pts.length - 1][0];
  const shade = `${line} L${x1.toFixed(2)},0 L${x0.toFixed(2)},0 Z`;
  const stops: FadeGeometry['stops'] = [];
  const nStops = 12;
  for (let i = 0; i <= nStops; i++) {
    const sec = vis0 + ((vis1 - vis0) * i) / nStops;
    stops.push({ offset: i / nStops, attenuation: 1 - gainAt(sec) });
  }
  return { line, shade, x0, x1, stops };
}
