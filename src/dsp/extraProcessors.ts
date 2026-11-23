/**
 * Extra mastering processors (offline, deterministic, in place):
 *  - Transient shaper (SPL-style differential envelope: attack / sustain)
 *  - Peak clipper (oversampled hard/soft-knee clipper with drive and ceiling)
 */
import type { ClipperParams, TransientShaperParams } from '../types/mastering';
import { createBiquadState, designHighPass, processBiquadSample } from './biquad';

const dbToLin = (db: number) => Math.pow(10, db / 20);

export function applyTransientShaper(
  left: Float32Array,
  right: Float32Array,
  p: TransientShaperParams,
  sampleRate: number,
  intensity: number,
): number {
  const n = left.length;
  const atk = p.attackDb * intensity;
  const sus = p.sustainDb * intensity;
  if (Math.abs(atk) < 0.01 && Math.abs(sus) < 0.01) return 0;
  const hp = designHighPass(Math.max(20, p.lowCutHz), 0.707, sampleRate);
  const sh = createBiquadState();
  const coef = (ms: number) => Math.exp(-1 / Math.max(1, (ms / 1000) * sampleRate));
  const fastA = coef(0.5);
  const fastR = coef(Math.max(2, p.speedMs));
  const slowA = coef(Math.max(8, p.speedMs * 2));
  const slowR = coef(Math.max(60, p.speedMs * 12));
  const smooth = coef(1.5);
  let fast = 0;
  let slow = 0;
  let gDb = 0;
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const det = Math.abs(processBiquadSample(0.5 * (left[i] + right[i]), hp, sh));
    fast = det > fast ? fastA * fast + (1 - fastA) * det : fastR * fast + (1 - fastR) * det;
    slow = det > slow ? slowA * slow + (1 - slowA) * det : slowR * slow + (1 - slowR) * det;
    const fDb = 20 * Math.log10(fast + 1e-9);
    const sDb = 20 * Math.log10(slow + 1e-9);
    const diff = fDb - sDb; // >0 on attacks, <0 on decays
    const target = atk * Math.max(0, Math.min(1, diff / 6)) + sus * Math.max(0, Math.min(1, -diff / 6));
    gDb = smooth * gDb + (1 - smooth) * target;
    if (Math.abs(gDb) > maxAbs) maxAbs = Math.abs(gDb);
    const g = dbToLin(gDb);
    left[i] *= g;
    right[i] *= g;
  }
  return Number(maxAbs.toFixed(2));
}

function clipSample(x: number, c: number, soft: number): number {
  const hard = Math.max(-c, Math.min(c, x));
  if (soft <= 0) return hard;
  // Soft knee: tanh curve scaled to the ceiling, blended with the hard clip.
  const s = c * Math.tanh(x / c);
  return hard * (1 - soft) + s * soft;
}

export function applyClipper(
  left: Float32Array,
  right: Float32Array,
  p: ClipperParams,
  _sampleRate: number,
  intensity: number,
): number {
  const n = left.length;
  const drive = dbToLin(p.driveDb * intensity);
  const c = dbToLin(p.ceilingDb);
  const soft = Math.max(0, Math.min(1, p.softness / 100));
  const os = p.oversampling >= 4 ? 4 : p.oversampling >= 2 ? 2 : 1;
  let prevL = 0;
  let prevR = 0;
  let maxGr = 0;
  for (let i = 0; i < n; i++) {
    const curL = left[i] * drive;
    const curR = right[i] * drive;
    let outL = 0;
    let outR = 0;
    // Linear-interpolated oversampling, box-filter decimation (same scheme as SYN saturation).
    for (let k = 1; k <= os; k++) {
      const t = k / os;
      outL += clipSample(prevL + (curL - prevL) * t, c, soft);
      outR += clipSample(prevR + (curR - prevR) * t, c, soft);
    }
    outL /= os;
    outR /= os;
    const peakIn = Math.max(Math.abs(curL), Math.abs(curR));
    if (peakIn > c) {
      const gr = 20 * Math.log10(peakIn / c);
      if (gr > maxGr) maxGr = gr;
    }
    prevL = curL;
    prevR = curR;
    left[i] = outL;
    right[i] = outR;
  }
  return Number(maxGr.toFixed(2));
}
