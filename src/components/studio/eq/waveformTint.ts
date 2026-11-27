/**
 * Loudness tint for the EQ graph's waveform layer (FL Studio colored-clip style) and the
 * frequency colors of the analyser fill. Pure math, loaded only by the lazy waveform layers.
 * Display only: nothing here touches audio or analysis.
 */

/** Quiet floor and loud ceiling of the tint scale (RMS, dBFS). */
export const TINT_FLOOR_DB = -42;
export const TINT_CEIL_DB = -6;

/** RMS (linear, 0..1) to tint position 0 (quiet) .. 1 (loud). Silence and NaN map to 0. */
export function loudnessT(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db - TINT_FLOOR_DB) / (TINT_CEIL_DB - TINT_FLOOR_DB)));
}

/** Cool blue (quiet) > violet > hot magenta > gold (loud). */
const RAMP: Array<[number, [number, number, number]]> = [
  [0, [46, 120, 255]],
  [0.45, [139, 92, 246]],
  [0.78, [224, 64, 251]],
  [1, [245, 196, 81]],
];

export function tintColor(t: number): string {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  let i = 0;
  while (i < RAMP.length - 2 && x > RAMP[i + 1][0]) i++;
  const [a, ca] = RAMP[i];
  const [b, cb] = RAMP[i + 1];
  const k = b > a ? (x - a) / (b - a) : 0;
  const c = ca.map((v, j) => Math.round(v + (cb[j] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * Gradient stops (offset 0..1, color, opacity) for per-column RMS levels, reduced to at most
 * `maxStops` by taking the loudest column in each group (so short hits still glow).
 */
export function tintStops(levels: ArrayLike<number>, maxStops = 96): Array<{ offset: number; color: string; opacity: number }> {
  const n = levels.length;
  if (!n) return [];
  const count = Math.max(2, Math.min(maxStops, n));
  const out: Array<{ offset: number; color: string; opacity: number }> = [];
  for (let s = 0; s < count; s++) {
    const a = Math.floor((s / count) * n);
    const b = Math.max(a + 1, Math.floor(((s + 1) / count) * n));
    let m = 0;
    for (let i = a; i < Math.min(n, b); i++) if (levels[i] > m) m = levels[i];
    const t = loudnessT(m);
    out.push({ offset: count > 1 ? s / (count - 1) : 0, color: tintColor(t), opacity: Number((0.3 + 0.3 * t).toFixed(3)) });
  }
  return out;
}

/** Analyser fill colors by frequency: deep magenta lows, violet/blue mids, cyan and gold highs. */
export const FREQ_FILL_STOPS: ReadonlyArray<[number, string]> = [
  [20, '#C2189B'],
  [150, '#E040FB'],
  [500, '#8B5CF6'],
  [2000, '#2E6BFF'],
  [6000, '#3FE0FF'],
  [16000, '#F5C451'],
];

/* ---------------------------------------------------------------------------------------------
 * Neon mesh gradient for the waveform body, in the neon blue family (MESH_PALETTE).
 * Hue flows along TIME (stops pinned to track seconds, so zooming keeps colors on the audio) and a
 * phase-shifted copy shows toward the peaks, so color also changes from the center line outward.
 * Loudness drives brightness: a per-column glow mask (dim when quiet, bright when loud) and soft
 * radial blobs anchored on the loudest moments. Pure math; display only.
 * ------------------------------------------------------------------------------------------- */

/**
 * Cyclic NEON BLUE palette (owner, 2026-11-26: "bright neon glowing blue"): dodger blue > electric
 * blue-cyan > hot cyan > ice-blue highlight > back. Stays in the blue family everywhere, so the body
 * reads as one glowing blue tube with a gentle shimmer along time, not a rainbow.
 */
export const MESH_PALETTE: ReadonlyArray<[number, number, number]> = [
  [30, 144, 255], // #1E90FF dodger / neon blue
  [0, 180, 255], // #00B4FF electric blue-cyan
  [0, 214, 255], // hot cyan
  [127, 219, 255], // #7FDBFF ice-blue highlight
  [0, 180, 255], // #00B4FF
  [41, 121, 255], // deep electric blue
];

/** Bright near-white blue for the center-line core and the inner neon rim. */
export const NEON_BLUE_CORE = '#7FDBFF';
/** Outer glow / bloom color along the waveform edges. */
export const NEON_BLUE_GLOW = '#00B4FF';

/** Palette color at a cyclic phase (any real number; 1 = one full trip through the palette). */
export function meshColor(phase: number): string {
  const p = Number.isFinite(phase) ? phase : 0;
  const n = MESH_PALETTE.length;
  const x = (((p % 1) + 1) % 1) * n;
  const i = Math.floor(x) % n;
  const k = x - Math.floor(x);
  // Smoothstep between neighbours: no visible kinks (banding) at the palette joints.
  const s = k * k * (3 - 2 * k);
  const a = MESH_PALETTE[i];
  const b = MESH_PALETTE[(i + 1) % n];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * s)},${Math.round(a[1] + (b[1] - a[1]) * s)},${Math.round(a[2] + (b[2] - a[2]) * s)})`;
}

/** Palette trips across a whole track (enough hues to read as a rainbow at full view). */
export const MESH_CYCLES = 1.5;

/** Minimum palette trips visible in any window, so a deep zoom still shows several hues. */
export const MESH_MIN_VISIBLE_CYCLES = 0.7;

/** Palette phase per second for a window: track-wide rate, raised when zoomed so hues keep flowing. */
export function meshRate(span: number, durationSec: number): number {
  const dur = durationSec > 0 ? durationSec : 1;
  const sp = span > 0 && Number.isFinite(span) ? span : dur;
  return Math.max(MESH_CYCLES / dur, MESH_MIN_VISIBLE_CYCLES / sp);
}

/**
 * Hue stops for the visible window, pinned to track time (panning moves colors with the audio). `shift` offsets the phase (the peak
 * layer uses a shifted copy so color varies from center to edge). Without a duration the window
 * is treated as the whole track.
 */
export function meshHueStops(view: { start: number; end: number }, durationSec: number, count = 32, shift = 0): Array<{ offset: number; color: string }> {
  const dur = durationSec > 0 ? durationSec : 1;
  const start = durationSec > 0 && Number.isFinite(view.start) ? view.start : 0;
  const end = durationSec > 0 && Number.isFinite(view.end) && view.end > start ? view.end : start + dur;
  const c = Math.max(2, Math.min(96, Math.floor(count)));
  const rate = meshRate(end - start, dur);
  const out: Array<{ offset: number; color: string }> = [];
  for (let i = 0; i < c; i++) {
    const o = i / (c - 1);
    const t = start + o * (end - start);
    out.push({ offset: o, color: meshColor(t * rate + shift) });
  }
  return out;
}

/**
 * Glow mask stops from per-column RMS: opacity 0.38 (quiet) .. 1 (loud), loudest column of each
 * group wins so short hits still glow. Smoothed lightly so neighbouring groups blend, not band.
 */
export function meshGlowStops(levels: ArrayLike<number>, maxStops = 64): Array<{ offset: number; opacity: number }> {
  const n = levels.length;
  if (!n) return [];
  const count = Math.max(2, Math.min(maxStops, n));
  const raw: number[] = [];
  for (let s = 0; s < count; s++) {
    const a = Math.floor((s / count) * n);
    const b = Math.max(a + 1, Math.floor(((s + 1) / count) * n));
    let m = 0;
    for (let i = a; i < Math.min(n, b); i++) if (levels[i] > m) m = levels[i];
    raw.push(loudnessT(m));
  }
  return raw.map((t, s) => {
    const l = raw[Math.max(0, s - 1)];
    const r = raw[Math.min(count - 1, s + 1)];
    const sm = Math.max(t, 0.25 * l + 0.5 * t + 0.25 * r);
    return { offset: s / (count - 1), opacity: Number((0.38 + 0.62 * sm).toFixed(3)) };
  });
}

/**
 * Up to `max` glow blobs (x 0..1, loudness t 0..1) on the loudest, well separated moments.
 * Quiet material (t < 0.2) gets no blob, so a silent track stays calm.
 */
export function meshBlobs(levels: ArrayLike<number>, max = 3, minGap = 0.18): Array<{ x: number; t: number }> {
  const n = levels.length;
  if (!n) return [];
  const cand = Array.from({ length: n }, (_, i) => ({ x: n > 1 ? i / (n - 1) : 0.5, t: loudnessT(levels[i]) }))
    .filter((c) => c.t >= 0.2)
    .sort((a, b) => b.t - a.t || a.x - b.x);
  const out: Array<{ x: number; t: number }> = [];
  for (const c of cand) {
    if (out.length >= max) break;
    if (out.every((o) => Math.abs(o.x - c.x) >= minGap)) out.push(c);
  }
  return out.sort((a, b) => a.x - b.x);
}
