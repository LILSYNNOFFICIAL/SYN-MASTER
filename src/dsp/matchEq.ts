/**
 * Match EQ (Ozone-style spectral matching).
 *
 * 1. Learn: the long-term average spectrum (LTAS) of the source and of a reference track,
 *    as stereo, mid and side power spectra on a fixed 1/24-octave grid (20 Hz - 19.4 kHz).
 *    Silent frames are gated out so intros/outros do not bias the average.
 * 2. Curve: both spectra are fractional-octave smoothed, level-aligned over the active
 *    frequency range (Match EQ matches shape, not loudness), differenced, scaled by Amount,
 *    clamped to the max boost / max cut limits and faded to 0 dB outside [lowHz, highHz].
 * 3. Render: the curve becomes a frequency-sampled FIR. Linear phase (latency compensated, so
 *    the output stays time-aligned with the dry signal) or minimum phase (cepstral method,
 *    no latency). It is applied by bounded-memory overlap-add, in place.
 *
 * The same `computeMatchEqCurve` feeds the graph, the offline renderer and the realtime
 * approximation, so the drawn curve is the curve that renders.
 */
import type { MatchEqChannel, MatchEqParams, MatchEqSmoothing, MatchEqSpectrumSet } from '../types/mastering';
import { fftInPlace, ifftInPlace } from './fft.ts';

export const MATCH_EQ_POINTS_PER_OCTAVE = 24;
export const MATCH_EQ_GRID_POINTS = 240;
/** 1/24-octave grid, 20 Hz upward (last point ≈ 19.4 kHz). */
export const MATCH_EQ_GRID_HZ: readonly number[] = Object.freeze(
  Array.from({ length: MATCH_EQ_GRID_POINTS }, (_, i) => 20 * Math.pow(2, i / MATCH_EQ_POINTS_PER_OCTAVE)),
);
export const MATCH_EQ_SMOOTHING_OPTIONS: MatchEqSmoothing[] = [1, 2, 3, 6, 12, 24];
export const MATCH_EQ_CHANNELS: MatchEqChannel[] = ['stereo', 'mid', 'side'];
/** Width of the cosine fade outside the low/high limits, in octaves. */
const RANGE_FADE_OCT = 1 / 3;

export const MATCH_EQ_LIMITS = {
  amount: [0, 100],
  maxBoostDb: [0, 12],
  maxCutDb: [0, 12],
  lowHz: [20, 2000],
  highHz: [1000, 20000],
} as const;

export function isValidSpectrumArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === MATCH_EQ_GRID_POINTS && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

export function isValidSpectrumSet(v: unknown): v is MatchEqSpectrumSet {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return isValidSpectrumArray(o.stereo) && isValidSpectrumArray(o.mid) && isValidSpectrumArray(o.side);
}

export function isMatchEqLearned(p: Pick<MatchEqParams, 'source' | 'reference'>): boolean {
  return isValidSpectrumSet(p.source) && isValidSpectrumSet(p.reference);
}

// ---------------------------------------------------------------------------------------
// Learning (long-term average spectrum)
// ---------------------------------------------------------------------------------------

export interface LearnSpectrumOptions {
  /** Upper bound on analysed frames; longer files are sampled at evenly spaced offsets. */
  maxFrames?: number;
  /** Frames quieter than (loudest frame + gateDb) are ignored. */
  gateDb?: number;
}

function learnFftSize(sampleRate: number): number {
  return sampleRate <= 50000 ? 8192 : sampleRate <= 100000 ? 16384 : 32768;
}

/**
 * Long-term average power spectrum of a stereo (or mono) signal as stereo / mid / side views
 * on MATCH_EQ_GRID_HZ, in dB. Returns null for silence.
 */
export function learnMatchEqSpectrum(
  channels: Float32Array[],
  sampleRate: number,
  options: LearnSpectrumOptions = {},
): MatchEqSpectrumSet | null {
  if (!channels.length || channels[0].length === 0 || !(sampleRate > 0)) return null;
  const left = channels[0];
  const right = channels.length > 1 ? channels[1] : channels[0];
  const len = Math.min(left.length, right.length);
  const n = learnFftSize(sampleRate);
  const half = n >> 1;
  const hop = n >> 1;
  const maxFrames = Math.max(1, Math.floor(options.maxFrames ?? 1200));
  const gateDb = options.gateDb ?? -45;

  const totalFrames = len <= n ? 1 : Math.floor((len - n) / hop) + 1;
  const frameCount = Math.min(totalFrames, maxFrames);
  const offsets: number[] = [];
  for (let f = 0; f < frameCount; f++) {
    const idx = frameCount === 1 ? 0 : Math.round((f * (totalFrames - 1)) / (frameCount - 1));
    offsets.push(Math.min(Math.max(0, len - n), idx * hop));
  }

  // Pass 1: frame energies for the silence gate.
  const energies = new Float64Array(offsets.length);
  let maxEnergy = 0;
  for (let f = 0; f < offsets.length; f++) {
    const o = offsets[f];
    const end = Math.min(len, o + n);
    let e = 0;
    for (let i = o; i < end; i++) e += 0.5 * (left[i] * left[i] + right[i] * right[i]);
    e /= Math.max(1, end - o);
    energies[f] = e;
    if (e > maxEnergy) maxEnergy = e;
  }
  const gate = Math.max(maxEnergy * Math.pow(10, gateDb / 10), 1e-10);
  if (maxEnergy <= 1e-10) return null;

  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const pS = new Float64Array(half + 1);
  const pM = new Float64Array(half + 1);
  const pSide = new Float64Array(half + 1);
  let used = 0;

  for (let f = 0; f < offsets.length; f++) {
    if (energies[f] < gate) continue;
    used++;
    const o = offsets[f];
    re.fill(0);
    im.fill(0);
    const end = Math.min(n, len - o);
    // Two real FFTs in one complex FFT: z = L + iR.
    for (let i = 0; i < end; i++) {
      re[i] = left[o + i] * win[i];
      im[i] = right[o + i] * win[i];
    }
    fftInPlace(re, im);
    for (let k = 0; k <= half; k++) {
      const nk = (n - k) % n;
      const zr = re[k], zi = im[k], cr = re[nk], ci = -im[nk];
      // L = (Z + conj(Z[N-k])) / 2 ; R = (Z - conj(Z[N-k])) / (2i)
      const lr = 0.5 * (zr + cr), li = 0.5 * (zi + ci);
      const rr = 0.5 * (zi - ci), ri = -0.5 * (zr - cr);
      const lp = lr * lr + li * li;
      const rp = rr * rr + ri * ri;
      const mr = 0.5 * (lr + rr), mi = 0.5 * (li + ri);
      const sr = 0.5 * (lr - rr), si = 0.5 * (li - ri);
      pS[k] += 0.5 * (lp + rp);
      pM[k] += mr * mr + mi * mi;
      pSide[k] += sr * sr + si * si;
    }
  }
  if (used === 0) return null;

  const binHz = sampleRate / n;
  const nyq = sampleRate / 2;
  const toGrid = (p: Float64Array): number[] => {
    const out: number[] = [];
    let last = -200;
    for (const fc of MATCH_EQ_GRID_HZ) {
      let power: number;
      if (fc >= nyq * 0.97) {
        out.push(last);
        continue;
      }
      const lo = fc * Math.pow(2, -1 / 48);
      const hi = Math.min(nyq * 0.97, fc * Math.pow(2, 1 / 48));
      const kLo = Math.max(1, Math.ceil(lo / binHz));
      const kHi = Math.min(half, Math.floor(hi / binHz));
      if (kHi >= kLo) {
        let s = 0;
        for (let k = kLo; k <= kHi; k++) s += p[k];
        power = s / (kHi - kLo + 1);
      } else {
        const x = fc / binHz;
        const k0 = Math.max(1, Math.min(half - 1, Math.floor(x)));
        const t = Math.max(0, Math.min(1, x - k0));
        power = p[k0] * (1 - t) + p[k0 + 1] * t;
      }
      last = Number((10 * Math.log10(Math.max(power / used, 1e-20))).toFixed(2));
      out.push(last);
    }
    return out;
  };
  return { stereo: toGrid(pS), mid: toGrid(pM), side: toGrid(pSide) };
}

// ---------------------------------------------------------------------------------------
// Curve
// ---------------------------------------------------------------------------------------

/** Fractional-octave smoothing in the power domain on the 1/24-octave grid. */
export function smoothSpectrumDb(db: readonly number[], smoothing: number): number[] {
  const halfWidth = MATCH_EQ_POINTS_PER_OCTAVE / (2 * Math.max(1, smoothing));
  const r = Math.floor(halfWidth);
  const edge = halfWidth - r;
  const pw = db.map((d) => Math.pow(10, d / 10));
  const out: number[] = [];
  for (let i = 0; i < db.length; i++) {
    let s = 0;
    let w = 0;
    for (let j = -r - 1; j <= r + 1; j++) {
      const k = i + j;
      if (k < 0 || k >= db.length) continue;
      const wt = Math.abs(j) <= r ? 1 : edge;
      if (wt <= 0) continue;
      s += pw[k] * wt;
      w += wt;
    }
    out.push(10 * Math.log10(Math.max(s / Math.max(w, 1e-12), 1e-20)));
  }
  return out;
}

/** 1 inside [lowHz, highHz], cosine fade to 0 over RANGE_FADE_OCT outside. */
export function rangeTaper(freq: number, lowHz: number, highHz: number): number {
  const octLow = Math.log2(lowHz / freq);
  const octHigh = Math.log2(freq / highHz);
  const o = Math.max(octLow, octHigh);
  if (o <= 0) return 1;
  if (o >= RANGE_FADE_OCT) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * o) / RANGE_FADE_OCT));
}

export interface MatchEqCurve {
  freqsHz: readonly number[];
  /** Final correction (amount, limits, range fade and intensity applied). */
  correctionDb: number[];
  /** Smoothed spectra, each level-aligned to 0 dB mean inside the range (display). */
  sourceDb: number[];
  referenceDb: number[];
  /** Unlimited full-amount difference (reference - source, aligned), for display / tests. */
  targetDb: number[];
  learned: boolean;
}

export function computeMatchEqCurve(params: MatchEqParams, intensity = 1): MatchEqCurve {
  const freqsHz = MATCH_EQ_GRID_HZ;
  const zeros = () => new Array(MATCH_EQ_GRID_POINTS).fill(0);
  if (!isMatchEqLearned(params)) {
    return { freqsHz, correctionDb: zeros(), sourceDb: [], referenceDb: [], targetDb: zeros(), learned: false };
  }
  const ch: MatchEqChannel = MATCH_EQ_CHANNELS.includes(params.channel) ? params.channel : 'stereo';
  const lowHz = Math.max(20, Math.min(params.lowHz, params.highHz));
  const highHz = Math.max(lowHz, params.highHz);
  const src = smoothSpectrumDb(params.source![ch], params.smoothing);
  const ref = smoothSpectrumDb(params.reference![ch], params.smoothing);
  const taper = freqsHz.map((f) => rangeTaper(f, lowHz, highHz));
  let sSum = 0, rSum = 0, count = 0;
  for (let i = 0; i < freqsHz.length; i++) {
    if (taper[i] < 1) continue;
    sSum += src[i];
    rSum += ref[i];
    count++;
  }
  if (count === 0) {
    // Range narrower than one grid step: align on the nearest point.
    let best = 0;
    for (let i = 1; i < freqsHz.length; i++) if (taper[i] > taper[best]) best = i;
    sSum = src[best];
    rSum = ref[best];
    count = 1;
  }
  const sMean = sSum / count;
  const rMean = rSum / count;
  const amount = Math.max(0, Math.min(1, params.amount / 100));
  const k = Math.max(0, Math.min(1, intensity));
  const maxBoost = Math.max(0, params.maxBoostDb);
  const maxCut = Math.max(0, params.maxCutDb);
  const sourceDb: number[] = [];
  const referenceDb: number[] = [];
  const targetDb: number[] = [];
  const correctionDb: number[] = [];
  for (let i = 0; i < freqsHz.length; i++) {
    const s = src[i] - sMean;
    const r = ref[i] - rMean;
    sourceDb.push(s);
    referenceDb.push(r);
    const t = r - s;
    targetDb.push(t);
    const c = Math.max(-maxCut, Math.min(maxBoost, t * amount)) * taper[i] * k;
    correctionDb.push(Object.is(c, -0) ? 0 : c);
  }
  return { freqsHz, correctionDb, sourceDb, referenceDb, targetDb, learned: true };
}

/** Correction (dB) at an arbitrary frequency: log-frequency interpolation, held at the ends. */
export function interpolateCurveDb(curveDb: readonly number[], freq: number): number {
  if (!(freq > MATCH_EQ_GRID_HZ[0])) return curveDb[0];
  const x = Math.log2(freq / 20) * MATCH_EQ_POINTS_PER_OCTAVE;
  const i = Math.floor(x);
  if (i >= MATCH_EQ_GRID_POINTS - 1) return curveDb[MATCH_EQ_GRID_POINTS - 1];
  const t = x - i;
  return curveDb[i] * (1 - t) + curveDb[i + 1] * t;
}

// ---------------------------------------------------------------------------------------
// FIR design
// ---------------------------------------------------------------------------------------

/** Float64 radix-2 FFT for filter design (the cepstrum needs more precision than Float32). */
function fft64(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / size;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const halfSize = size >> 1;
    for (let start = 0; start < n; start += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < halfSize; k++) {
        const a = start + k, b = a + halfSize;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

export interface MatchEqKernel {
  taps: Float32Array;
  /** Group delay compensated by the offline renderer (linear phase), else 0. */
  latency: number;
  phase: 'linear' | 'minimum';
}

/** Linear-phase length (odd) for a sample rate; ≈ 0.34 s, enough for 1/3-octave detail at 30 Hz. */
export function matchEqKernelLength(sampleRate: number, phase: 'linear' | 'minimum'): number {
  const base = sampleRate <= 50000 ? 16384 : sampleRate <= 100000 ? 32768 : 65536;
  return phase === 'linear' ? base - 1 : base;
}

export function designMatchEqKernel(
  correctionDb: readonly number[],
  sampleRate: number,
  phase: 'linear' | 'minimum',
): MatchEqKernel {
  const len = matchEqKernelLength(sampleRate, phase);
  const pow2 = 1 << Math.ceil(Math.log2(len));
  const n = pow2 * 4;
  const halfN = n >> 1;
  const mag = new Float64Array(halfN + 1);
  for (let k = 0; k <= halfN; k++) {
    const f = (k * sampleRate) / n;
    mag[k] = interpolateCurveDb(correctionDb, Math.max(f, 1e-3));
  }
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const taps = new Float32Array(len);

  if (phase === 'linear') {
    for (let k = 0; k <= halfN; k++) {
      const m = Math.pow(10, mag[k] / 20);
      re[k] = m;
      if (k > 0 && k < halfN) re[n - k] = m;
    }
    fft64(re, im, true); // zero-phase impulse, centred at 0 (circular)
    const d = (len - 1) >> 1;
    for (let i = 0; i < len; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * (i + 1)) / (len + 1))); // Hann, nonzero ends
      taps[i] = re[(i - d + n) % n] * w;
    }
    return { taps, latency: d, phase };
  }

  // Minimum phase via the real cepstrum (homomorphic folding).
  const LN10_20 = Math.LN10 / 20;
  for (let k = 0; k <= halfN; k++) {
    const lm = mag[k] * LN10_20; // ln|H|
    re[k] = lm;
    if (k > 0 && k < halfN) re[n - k] = lm;
  }
  fft64(re, im, true);
  for (let i = 1; i < halfN; i++) re[i] *= 2;
  for (let i = halfN + 1; i < n; i++) re[i] = 0;
  im.fill(0);
  fft64(re, im, false);
  for (let k = 0; k < n; k++) {
    const e = Math.exp(re[k]);
    const ph = im[k];
    re[k] = e * Math.cos(ph);
    im[k] = e * Math.sin(ph);
  }
  fft64(re, im, true);
  const fadeStart = Math.floor(len * 0.75);
  for (let i = 0; i < len; i++) {
    const w = i < fadeStart ? 1 : 0.5 * (1 + Math.cos((Math.PI * (i - fadeStart)) / (len - fadeStart)));
    taps[i] = re[i] * w;
  }
  return { taps, latency: 0, phase };
}

/** Magnitude (dB) of FIR taps at a frequency (direct DTFT; tests and diagnostics). */
export function firMagnitudeDb(taps: Float32Array, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  let r = 0, i = 0;
  for (let n = 0; n < taps.length; n++) {
    r += taps[n] * Math.cos(w * n);
    i -= taps[n] * Math.sin(w * n);
  }
  return 10 * Math.log10(Math.max(r * r + i * i, 1e-30));
}

// ---------------------------------------------------------------------------------------
// Offline render
// ---------------------------------------------------------------------------------------

interface KernelSpectrum {
  re: Float32Array;
  im: Float32Array;
  fftSize: number;
  blockSize: number;
  latency: number;
}

function kernelSpectrum(k: MatchEqKernel): KernelSpectrum {
  const blockSize = 1 << Math.ceil(Math.log2(k.taps.length));
  const fftSize = blockSize * 2;
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  re.set(k.taps);
  fftInPlace(re, im);
  return { re, im, fftSize, blockSize, latency: k.latency };
}

/**
 * Overlap-add FIR convolution written back into `signal`, shifted left by the kernel latency
 * (so linear-phase output is time-aligned). Memory is bounded by the FFT size: a finished
 * output sample is only ever written to a position whose input has already been read.
 */
export function convolveInPlace(signal: Float32Array, ks: KernelSpectrum): void {
  convolvePairInPlace(signal, null, ks);
}

/**
 * Same as convolveInPlace for two channels at once: the kernel is real, so packing
 * z = a + i·b into one complex FFT gives (a*h) + i·(b*h), half the FFT work for stereo.
 */
export function convolvePairInPlace(a: Float32Array, b: Float32Array | null, ks: KernelSpectrum): void {
  const len = b ? Math.min(a.length, b.length) : a.length;
  if (len === 0) return;
  const { fftSize, blockSize, latency } = ks;
  const bufRe = new Float32Array(fftSize);
  const bufIm = new Float32Array(fftSize);
  const accA = new Float64Array(fftSize + blockSize);
  const accB = b ? new Float64Array(fftSize + blockSize) : null;
  // `acc[j]` holds unshifted output position (start + j).
  for (let start = 0; start - latency < len; start += blockSize) {
    if (start < len) {
      bufRe.fill(0);
      bufIm.fill(0);
      const copy = Math.min(blockSize, len - start);
      for (let i = 0; i < copy; i++) bufRe[i] = a[start + i];
      if (b) for (let i = 0; i < copy; i++) bufIm[i] = b[start + i];
      fftInPlace(bufRe, bufIm);
      for (let k = 0; k < fftSize; k++) {
        const ar = bufRe[k], ai = bufIm[k];
        const br = ks.re[k], bi = ks.im[k];
        bufRe[k] = ar * br - ai * bi;
        bufIm[k] = ar * bi + ai * br;
      }
      ifftInPlace(bufRe, bufIm);
      for (let i = 0; i < fftSize; i++) accA[i] += bufRe[i];
      if (accB) for (let i = 0; i < fftSize; i++) accB[i] += bufIm[i];
    }
    // Positions [start, start + blockSize) are final: later blocks start at start + blockSize.
    for (let i = 0; i < blockSize; i++) {
      const dst = start + i - latency;
      if (dst >= 0 && dst < len) {
        a[dst] = accA[i];
        if (b && accB) b[dst] = accB[i];
      }
    }
    accA.copyWithin(0, blockSize);
    accA.fill(0, accA.length - blockSize);
    if (accB) {
      accB.copyWithin(0, blockSize);
      accB.fill(0, accB.length - blockSize);
    }
  }
}

const kernelCache = new Map<string, KernelSpectrum>();
const KERNEL_CACHE_MAX = 6;

function cachedKernelSpectrum(correctionDb: number[], sampleRate: number, phase: 'linear' | 'minimum'): KernelSpectrum {
  const key = `${sampleRate}|${phase}|${correctionDb.map((c) => c.toFixed(4)).join(',')}`;
  const hit = kernelCache.get(key);
  if (hit) {
    kernelCache.delete(key);
    kernelCache.set(key, hit);
    return hit;
  }
  const ks = kernelSpectrum(designMatchEqKernel(correctionDb, sampleRate, phase));
  kernelCache.set(key, ks);
  while (kernelCache.size > KERNEL_CACHE_MAX) kernelCache.delete(kernelCache.keys().next().value!);
  return ks;
}

/** True when the module would change the signal (learned and a non-flat curve). */
export function matchEqIsActive(params: MatchEqParams, intensity = 1): boolean {
  if (!isMatchEqLearned(params) || params.amount <= 0 || intensity <= 0) return false;
  return computeMatchEqCurve(params, intensity).correctionDb.some((c) => Math.abs(c) > 1e-4);
}

/**
 * Offline Match EQ (preview, Fix All, export). Unlearned or flat = untouched (bit-identical).
 * Stereo filters L and R; mid / side filters only that component and leaves the other as is.
 */
export function applyMatchEq(
  left: Float32Array,
  right: Float32Array,
  params: MatchEqParams,
  sampleRate: number,
  intensity = 1,
): void {
  if (!matchEqIsActive(params, intensity)) return;
  const curve = computeMatchEqCurve(params, intensity);
  const phase = params.phase === 'minimum' ? 'minimum' : 'linear';
  const ks = cachedKernelSpectrum(curve.correctionDb, sampleRate, phase);
  if (params.channel === 'mid' || params.channel === 'side') {
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n; i++) {
      const m = 0.5 * (left[i] + right[i]);
      const s = 0.5 * (left[i] - right[i]);
      left[i] = m;
      right[i] = s;
    }
    convolveInPlace(params.channel === 'mid' ? left : right, ks);
    for (let i = 0; i < n; i++) {
      const m = left[i];
      const s = right[i];
      left[i] = m + s;
      right[i] = m - s;
    }
    return;
  }
  convolvePairInPlace(left, right, ks);
}

/**
 * Realtime approximation: a minimum-phase impulse response (no latency) for a ConvolverNode.
 * Returns 4 channels for the true-stereo convolver (LL, LR, RL, RR) so mid / side modes need
 * no extra routing, or null when the module is a pass-through.
 */
export function matchEqRealtimeImpulse(
  params: MatchEqParams,
  sampleRate: number,
  intensity = 1,
): Float32Array[] | null {
  if (!matchEqIsActive(params, intensity)) return null;
  const curve = computeMatchEqCurve(params, intensity);
  const h = designMatchEqKernel(curve.correctionDb, sampleRate, 'minimum').taps;
  if (params.channel !== 'mid' && params.channel !== 'side') {
    const zero = new Float32Array(h.length);
    return [h, zero, zero, h];
  }
  // mid: L' = L(h+d)/2 + R(h-d)/2 ; side: L' = L(1+g)/2 + R(1-g)/2 (d = unit impulse).
  const plus = new Float32Array(h.length);
  const minus = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    plus[i] = 0.5 * h[i];
    minus[i] = params.channel === 'mid' ? 0.5 * h[i] : -0.5 * h[i];
  }
  plus[0] += 0.5;
  minus[0] += params.channel === 'mid' ? -0.5 : 0.5;
  // Web Audio 4-channel order: L->L, L->R, R->L, R->R.
  return [plus, minus, minus, plus];
}

// ---------------------------------------------------------------------------------------
// Chain helpers
// ---------------------------------------------------------------------------------------

export interface MatchEqProfile {
  source: MatchEqSpectrumSet;
  reference: MatchEqSpectrumSet;
  referenceName?: string;
}

/** Conservative settings used by the local Director and as the AI's safe starting point. */
export const MATCH_EQ_DIRECTOR_DEFAULTS: Pick<
  MatchEqParams,
  'amount' | 'smoothing' | 'maxBoostDb' | 'maxCutDb' | 'lowHz' | 'highHz' | 'channel' | 'phase'
> = {
  amount: 40,
  smoothing: 3,
  maxBoostDb: 2.5,
  maxCutDb: 2.5,
  lowHz: 40,
  highHz: 16000,
  channel: 'stereo',
  phase: 'linear',
};

/** Largest absolute correction the curve applies (dB). */
export function matchEqPeakCorrectionDb(params: MatchEqParams, intensity = 1): number {
  return computeMatchEqCurve(params, intensity).correctionDb.reduce((m, c) => Math.max(m, Math.abs(c)), 0);
}
