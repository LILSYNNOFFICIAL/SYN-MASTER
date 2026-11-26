/** Shared coordinate system for the parametric and dynamic EQ graphs (log frequency, linear dB). */
export const W = 640;
export const H = 240;
export const F_MIN = 20;
export const F_MAX = 20000;
export const G_MAX = 18;

export const fToX = (f: number) => (Math.log10(Math.max(F_MIN, Math.min(F_MAX, f)) / F_MIN) / Math.log10(F_MAX / F_MIN)) * W;
export const xToF = (x: number) => F_MIN * Math.pow(F_MAX / F_MIN, Math.max(0, Math.min(1, x / W)));
export const gToY = (g: number) => H / 2 - (g / G_MAX) * (H / 2 - 10);
export const yToG = (y: number) => ((H / 2 - y) / (H / 2 - 10)) * G_MAX;
export const clampF = (f: number) => Math.max(F_MIN, Math.min(F_MAX, f));
export const clampG = (g: number) => Math.max(-G_MAX, Math.min(G_MAX, g));

/** Band colours (Ozone-style distinct hues on the blue/purple skin). */
export const BAND_COLORS = ['#2EA8FF', '#3FE0FF', '#8B5CF6', '#E040FB', '#F2CA52', '#7BE0A0', '#FF8A5B', '#FF6B9A', '#5EC8FF', '#C792EA'];

export function fmtHz(f: number): string {
  if (f >= 1000) return `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz`;
  return `${f >= 100 ? Math.round(f) : f.toFixed(1)} Hz`;
}

export function fmtF(f: number): string {
  return f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)}k` : f.toFixed(0);
}

/** Log-spaced frequencies across the graph width. */
export function curveFreqs(n = 240): number[] {
  return Array.from({ length: n }, (_, i) => xToF((i / (n - 1)) * W));
}

export function curvePath(freqs: number[], db: number[]): string {
  let d = '';
  for (let i = 0; i < freqs.length; i++) {
    const y = gToY(Math.max(-G_MAX - 8, Math.min(G_MAX + 8, db[i])));
    d += `${i ? 'L' : 'M'}${fToX(freqs[i]).toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}
