/**
 * Measured AI-shimmer detector.
 *
 * AI generators (Suno, Udio, ...) often leave a "swirly", metallic layer above ~9 kHz:
 * narrow partials whose level flickers frame to frame, mostly in the SIDE channel and not
 * driven by the drums. Natural cymbals and hats are noisy (flat spectrum), mostly centred,
 * and their flux follows the mid channel's transients.
 *
 * On runs of 24 consecutive STFT frames (2048, hop 1024) sampled across the track:
 *  - sideHfRatio : side / mid energy in the 9-16 kHz band
 *  - fluxRatio   : how independently the side HF band level moves frame to frame
 *                  (1 - corr with the mid HF level changes)
 *  - tonality    : 1 - spectral flatness of the side HF band (metallic = tonal = high)
 * Each feature is mapped to 0..1 and combined into `score`. `confidence` additionally
 * requires enough HF energy to judge (a dark track cannot be judged) and is what the
 * auto engine uses to switch de-shimmer on.
 */
import { createHannWindow, fftInPlace } from './fft';

export interface ShimmerMeasurement {
  score: number;
  confidence: number;
  sideHfRatio: number;
  fluxRatio: number;
  tonality: number;
  /** HF (9-16 kHz) energy relative to the full band, dB. */
  hfShareDb: number;
}

const N = 2048;
const HOP = 1024;
const SEG_FRAMES = 24;
const MAX_SEGMENTS = 12;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 1;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 1e-12 && sbb > 1e-12 ? sab / Math.sqrt(saa * sbb) : 1;
}

export function measureShimmer(left: Float32Array, right: Float32Array, sampleRate: number): ShimmerMeasurement {
  const empty: ShimmerMeasurement = { score: 0, confidence: 0, sideHfRatio: 0, fluxRatio: 0, tonality: 0, hfShareDb: -120 };
  const n = left.length;
  const segLen = N + HOP * (SEG_FRAMES - 1);
  if (n < segLen + N || sampleRate < 32000) return empty;
  const lo = Math.ceil((9000 / sampleRate) * N);
  const hi = Math.min(N / 2 - 1, Math.floor((Math.min(16000, sampleRate * 0.45) / sampleRate) * N));
  if (hi - lo < 16) return empty;
  const win = createHannWindow(N);
  const reM = new Float32Array(N), imM = new Float32Array(N), reS = new Float32Array(N), imS = new Float32Array(N);
  const bins = hi - lo + 1;
  const segments = Math.max(1, Math.min(MAX_SEGMENTS, Math.floor(n / (segLen * 2))));
  const step = Math.floor((n - segLen) / segments);

  let eM = 0, eS = 0, eAll = 0, flatSum = 0, flatCount = 0;
  let indepSum = 0, flickSum = 0, segCount = 0;
  for (let sgi = 0; sgi < segments; sgi++) {
    const base = sgi * step;
    const logM: number[] = [];
    const logS: number[] = [];
    for (let f = 0; f < SEG_FRAMES; f++) {
      const off = base + f * HOP;
      for (let i = 0; i < N; i++) {
        const l = left[off + i], r = right[off + i];
        reM[i] = 0.5 * (l + r) * win[i]; imM[i] = 0;
        reS[i] = 0.5 * (l - r) * win[i]; imS[i] = 0;
      }
      fftInPlace(reM, imM);
      fftInPlace(reS, imS);
      let frameAll = 0;
      for (let k = 1; k < N / 2; k++) frameAll += reM[k] * reM[k] + imM[k] * imM[k] + reS[k] * reS[k] + imS[k] * imS[k];
      let logSum = 0, frameS = 0, frameM = 0;
      for (let b = 0; b < bins; b++) {
        const k = lo + b;
        const pm = reM[k] * reM[k] + imM[k] * imM[k];
        const ps = reS[k] * reS[k] + imS[k] * imS[k];
        frameM += pm;
        frameS += ps;
        logSum += Math.log(ps + 1e-20);
      }
      eM += frameM;
      eS += frameS;
      eAll += frameAll;
      logM.push(10 * Math.log10(frameM + 1e-14));
      logS.push(10 * Math.log10(frameS + 1e-14));
      if (frameS > 1e-12) {
        flatSum += Math.exp(logSum / bins) / (frameS / bins);
        flatCount++;
      }
    }
    // Frame-to-frame changes of the HF band level in side vs mid.
    const dM = logM.slice(1).map((v, i) => v - logM[i]);
    const dS = logS.slice(1).map((v, i) => v - logS[i]);
    const sd = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
    const sdM = sd(dM), sdS = sd(dS);
    if (sdM + sdS > 1e-6) {
      indepSum += 1 - Math.max(0, corr(dS, dM)); // 0 = side follows mid, 1 = independent
      flickSum += sdS / Math.max(0.3, sdM);
      segCount++;
    }
  }
  const hfShareDb = 10 * Math.log10((eM + eS) / Math.max(1e-20, eAll) + 1e-20);
  if (eM + eS < 1e-10 || segCount === 0) return { ...empty, hfShareDb: Number(hfShareDb.toFixed(1)) };
  const sideHfRatio = eS / Math.max(1e-20, eM);
  const independence = indepSum / segCount;
  const flicker = flickSum / segCount;
  // fluxRatio: how independently the side HF level moves from the mid HF level (0 = it
  // follows the drums/cymbals, 1 = it flickers on its own). Counted only when the side
  // band actually moves (flicker vs mid >= 0.05).
  const fluxRatio = flicker >= 0.05 ? independence : 0;
  const tonality = flatCount ? 1 - flatSum / flatCount : 0;

  const fSide = clamp01((sideHfRatio - 0.25) / 0.75); // 0.25 -> 0, 1.0 -> 1
  const fFlux = clamp01((fluxRatio - 0.6) / 0.3); // measured: clean mixes ~0.5, AI-style shimmer ~0.93
  const fTone = clamp01((tonality - 0.75) / 0.2); // metallic partials vs noisy cymbals
  const score = clamp01(0.35 * fSide + 0.35 * fFlux + 0.3 * fTone);
  // Only trust the score when there is enough HF content and all three cues agree.
  const hfOk = clamp01((hfShareDb + 45) / 15); // -45 dB share -> 0, -30 dB -> 1
  const agreement = Math.min(fSide, fFlux, fTone) > 0.2 ? 1 : 0.6;
  const confidence = clamp01(score * hfOk * agreement);
  const r = (x: number) => Number(x.toFixed(3));
  return { score: r(score), confidence: r(confidence), sideHfRatio: r(sideHfRatio), fluxRatio: r(fluxRatio), tonality: r(tonality), hfShareDb: Number(hfShareDb.toFixed(1)) };
}
