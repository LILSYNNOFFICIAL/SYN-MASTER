/**
 * Audio repair for AI-generated tracks (Suno, Udio, etc.):
 *  - de-click       : isolated spikes are cut out and re-drawn with a cubic Hermite bridge
 *  - de-crackle     : same, tuned for many small, low-level clicks
 *  - spike repair   : single-sample transient spikes above the local peak envelope are tamed
 *  - de-shimmer     : AI "metallic"/swirly high-frequency artifacts are reduced with a
 *                     fast-vs-slow envelope dynamic attenuation of the 9 kHz+ band,
 *                     strongest on the side channel where the shimmer usually lives
 *
 * Everything runs offline on Float32Array buffers in place and is deterministic, so
 * the Fix-All loop can re-render and re-measure the result.
 */
import { createBiquadState, designHighPass, processBiquadSample } from './biquad';

export interface RepairSettings {
  /** 0..100 de-click strength (0 = off). */
  declick: number;
  /** 0..100 de-crackle strength (0 = off). */
  decrackle: number;
  /** Tame single-sample spikes. */
  spikeRepair: boolean;
  /** 0..100 AI shimmer / metallic artifact reduction (0 = off). */
  deShimmer: number;
}

function d2(ch: Float32Array, i: number): number {
  return Math.abs(ch[i] - 2 * ch[i - 1] + ch[i - 2]);
}

/**
 * Repairs isolated discontinuities in one channel. Returns the number of repairs.
 * ratio: how far above the local second-difference level a spike must be.
 * floor: absolute minimum |d2|. halfWidth: samples replaced on each side of the spike.
 */
export function repairClicksChannel(
  ch: Float32Array,
  sampleRate: number,
  ratio: number,
  floor: number,
  halfWidth: number,
): number {
  const n = ch.length;
  if (n < 32) return 0;
  const alpha = 1 - Math.exp(-1 / Math.max(1, sampleRate * 0.005));
  const after = Math.max(8, Math.round(sampleRate * 0.003));
  let env = 0;
  const prime = Math.min(n, Math.round(sampleRate * 0.01));
  for (let i = 2; i < prime; i++) env += d2(ch, i);
  env = prime > 2 ? env / (prime - 2) : 0;
  let repairs = 0;
  let i = 2;
  while (i < n) {
    const v = d2(ch, i);
    const local = env + 1e-6;
    if (v > floor && v > ratio * local) {
      // Isolation test: roughness must fall back afterwards (not a drum onset).
      const s = i + 4;
      const e = Math.min(n, s + after);
      let sum = 0;
      for (let j = s; j < e; j++) sum += d2(ch, j);
      const meanAfter = e > s ? sum / (e - s) : 0;
      if (meanAfter < local * 2) {
        const a = Math.max(2, i - halfWidth);
        const b = Math.min(n - 3, i + halfWidth);
        bridgeHermite(ch, a, b);
        repairs++;
        i = b + 1;
        continue;
      }
    }
    env += alpha * (v - env);
    i++;
  }
  return repairs;
}

/**
 * Replace samples (a, b) exclusive with a cubic Hermite curve. End slopes are averaged
 * over 4 samples and the result is clamped to the level of the surrounding audio, so a
 * bridge can never overshoot (important inside noisy material such as hi-hats).
 */
function bridgeHermite(ch: Float32Array, a: number, b: number): void {
  const len = b - a;
  if (len < 2 || a < 5 || b > ch.length - 6) return;
  const p0 = ch[a];
  const p1 = ch[b];
  const m0 = (ch[a] - ch[a - 4]) / 4;
  const m1 = (ch[b + 4] - ch[b]) / 4;
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = Math.max(0, a - 8); j <= a; j++) { lo = Math.min(lo, ch[j]); hi = Math.max(hi, ch[j]); }
  for (let j = b; j <= Math.min(ch.length - 1, b + 8); j++) { lo = Math.min(lo, ch[j]); hi = Math.max(hi, ch[j]); }
  for (let k = 1; k < len; k++) {
    const t = k / len;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const v = h00 * p0 + h10 * m0 * len + h01 * p1 + h11 * m1 * len;
    ch[a + k] = Math.max(lo, Math.min(hi, v));
  }
}

/** Clamp single-sample spikes that jump far above both neighbours. Returns repairs. */
export function repairSpikesChannel(ch: Float32Array): number {
  let repairs = 0;
  const w = 16;
  for (let i = w; i < ch.length - w; i++) {
    const x = Math.abs(ch[i]);
    if (x < 0.08) continue;
    const prev = ch[i - 1];
    const next = ch[i + 1];
    if (x < 3 * Math.max(Math.abs(prev), Math.abs(next)) + 0.05) continue;
    // Must stand far above everything around it, not just its two neighbours.
    let around = 0;
    for (let j = i - w; j <= i + w; j++) {
      if (j !== i) around = Math.max(around, Math.abs(ch[j]));
    }
    if (x > 2.5 * around) {
      ch[i] = 0.5 * (prev + next);
      repairs++;
    }
  }
  return repairs;
}

/**
 * Dynamic high-band attenuation for AI shimmer. Splits the 9 kHz+ band; where its fast
 * envelope jumps above its slow envelope (swirly, phasey bursts) the band is pulled down.
 * The side channel gets the full amount, the mid channel half, so vocals keep their air.
 */
export function reduceShimmer(left: Float32Array, right: Float32Array, sampleRate: number, amount: number): number {
  const amt = Math.max(0, Math.min(1, amount));
  if (amt <= 0) return 0;
  const cutoff = Math.min(9000, sampleRate * 0.4);
  const hp = designHighPass(cutoff, 0.707, sampleRate);
  const sM1 = createBiquadState();
  const sM2 = createBiquadState();
  const sS1 = createBiquadState();
  const sS2 = createBiquadState();
  const aFast = 1 - Math.exp(-1 / (sampleRate * 0.002));
  const aSlow = 1 - Math.exp(-1 / (sampleRate * 0.08));
  let fastM = 0, slowM = 0, fastS = 0, slowS = 0;
  let maxGr = 0;
  for (let i = 0; i < left.length; i++) {
    const m = 0.5 * (left[i] + right[i]);
    const s = 0.5 * (left[i] - right[i]);
    const hm = processBiquadSample(processBiquadSample(m, hp, sM1), hp, sM2);
    const hs = processBiquadSample(processBiquadSample(s, hp, sS1), hp, sS2);
    fastM += aFast * (Math.abs(hm) - fastM);
    slowM += aSlow * (Math.abs(hm) - slowM);
    fastS += aFast * (Math.abs(hs) - fastS);
    slowS += aSlow * (Math.abs(hs) - slowS);
    // Excess of fast over slow envelope, 0..1
    const exM = slowM > 1e-6 ? Math.max(0, Math.min(1, fastM / slowM - 1.3)) : 0;
    const exS = slowS > 1e-6 ? Math.max(0, Math.min(1, fastS / slowS - 1.1)) : 0;
    // Static floor reduction on side HF plus dynamic reduction on bursts.
    const gS = 1 - amt * (0.25 + 0.6 * exS);
    const gM = 1 - amt * 0.5 * (0.6 * exM);
    const newM = m - hm * (1 - gM);
    const newS = s - hs * (1 - gS);
    left[i] = newM + newS;
    right[i] = newM - newS;
    const gr = -20 * Math.log10(Math.max(1e-4, Math.min(gM, gS)));
    if (gr > maxGr) maxGr = gr;
  }
  return Number(maxGr.toFixed(2));
}

/** Apply all enabled repair stages in place. Returns counts for telemetry/logs. */
export function applyRepair(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  settings: Partial<RepairSettings>,
  intensityScale = 1,
): { clicksRepaired: number; spikesRepaired: number; shimmerGrDb: number } {
  let clicksRepaired = 0;
  let spikesRepaired = 0;
  const stereoSame = left === right;
  if (settings.spikeRepair) {
    spikesRepaired += repairSpikesChannel(left);
    if (!stereoSame) spikesRepaired += repairSpikesChannel(right);
  }
  const declick = ((settings.declick ?? 0) / 100) * intensityScale;
  if (declick > 0) {
    // Higher strength = lower ratio (more sensitive) and wider repair window.
    const ratio = 20 - 12 * declick;
    const half = Math.max(2, Math.round(sampleRate * (0.0005 + 0.001 * declick)));
    clicksRepaired += repairClicksChannel(left, sampleRate, ratio, 0.02, half);
    if (!stereoSame) clicksRepaired += repairClicksChannel(right, sampleRate, ratio, 0.02, half);
  }
  const crackle = ((settings.decrackle ?? 0) / 100) * intensityScale;
  if (crackle > 0) {
    const ratio = 16 - 5 * crackle;
    const half = Math.max(1, Math.round(sampleRate * 0.0002));
    clicksRepaired += repairClicksChannel(left, sampleRate, ratio, 0.006, half);
    if (!stereoSame) clicksRepaired += repairClicksChannel(right, sampleRate, ratio, 0.006, half);
  }
  const shimmer = ((settings.deShimmer ?? 0) / 100) * intensityScale;
  const shimmerGrDb = shimmer > 0 && !stereoSame ? reduceShimmer(left, right, sampleRate, shimmer) : 0;
  return { clicksRepaired, spikesRepaired, shimmerGrDb };
}
