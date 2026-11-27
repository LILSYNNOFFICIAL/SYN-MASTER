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
