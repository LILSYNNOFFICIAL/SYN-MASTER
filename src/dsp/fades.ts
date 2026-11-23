/**
 * Timeline fades for the master (FL Studio style fade lines on the waveform).
 * Applied AFTER the effects chain (processChainOffline's postFades), so the limiter
 * sees the unfaded signal; the Fix-All loop, playback of the verified render and the
 * export all include the same fades.
 */
export type FadeCurve = 'linear' | 'exp' | 'scurve';

export interface FadeSettings {
  inSec: number;
  outSec: number;
  inCurve: FadeCurve;
  outCurve: FadeCurve;
}

export const NO_FADES: FadeSettings = { inSec: 0, outSec: 0, inCurve: 'scurve', outCurve: 'scurve' };

export function fadeGain(t01: number, curve: FadeCurve): number {
  const t = Math.max(0, Math.min(1, t01));
  if (curve === 'linear') return t;
  if (curve === 'exp') return t * t * t;
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

export function hasFades(f: FadeSettings | null | undefined): boolean {
  return Boolean(f && (f.inSec > 0.001 || f.outSec > 0.001));
}

/** Same as applyFades but writes into the given arrays (used on freshly rendered output). */
export function applyFadesInPlace(channels: Float32Array[], sampleRate: number, fades: FadeSettings): Float32Array[] {
  if (!hasFades(fades)) return channels;
  const n = channels[0]?.length ?? 0;
  const inN = Math.min(n, Math.round(fades.inSec * sampleRate));
  const outN = Math.min(n - inN, Math.round(fades.outSec * sampleRate));
  for (const out of channels) {
    for (let i = 0; i < inN; i++) out[i] *= fadeGain(i / inN, fades.inCurve);
    for (let i = 0; i < outN; i++) out[n - 1 - i] *= fadeGain(i / outN, fades.outCurve);
  }
  return channels;
}

export function applyFades(channels: Float32Array[], sampleRate: number, fades: FadeSettings): Float32Array[] {
  if (!hasFades(fades)) return channels;
  const n = channels[0]?.length ?? 0;
  const inN = Math.min(n, Math.round(fades.inSec * sampleRate));
  const outN = Math.min(n - inN, Math.round(fades.outSec * sampleRate));
  return channels.map((ch) => {
    const out = new Float32Array(ch);
    for (let i = 0; i < inN; i++) out[i] *= fadeGain(i / inN, fades.inCurve);
    for (let i = 0; i < outN; i++) out[n - 1 - i] *= fadeGain(i / outN, fades.outCurve);
    return out;
  });
}
