import { detectClicks } from './clickDetect';
import type { AudioAnalysis, ResonancePeak, SpectralBandEnergy } from '../types/mastering';
import { SPECTRAL_ZONES_HZ } from './bandMap';
import { BiquadCoeffs, designHighPass, designHighShelf, designLowPass, processBiquadBuffer } from './biquad';
import { computeMagnitudeSpectrumDb, createHannWindow } from './fft';

export function linearToDb(val: number, floorDb = -120): number {
  if (val <= 1e-9) return floorDb;
  return Math.max(floorDb, 20 * Math.log10(val));
}

export function dbToLinear(db: number): number {
  if (db <= -120) return 0;
  return Math.pow(10, db / 20);
}

/**
 * ITU-R BS.1770-4 K-Weighting Filter Design for arbitrary sampleRate
 */
function designKWeightingFilters(sampleRate: number): {
  shelf: BiquadCoeffs;
  rlb: BiquadCoeffs;
} {
  // Exact coefficients at 48kHz, frequency-warped via RBJ bilinear design for general SR
  if (Math.abs(sampleRate - 48000) < 1) {
    return {
      shelf: {
        b0: 1.53512485958697,
        b1: -2.69169618940638,
        b2: 1.19839281085285,
        a1: -1.69065929318241,
        a2: 0.73248077421585,
      },
      rlb: {
        b0: 1.0,
        b1: -2.0,
        b2: 1.0,
        a1: -1.99004745483398,
        a2: 0.99007225036621,
      },
    };
  }
  return {
    shelf: designHighShelf(1681.974, 3.99984, 0.707175, sampleRate),
    rlb: designHighPass(38.135, 0.500327, sampleRate),
  };
}

/**
 * ITU-R BS.1770-4 4x oversampling polyphase windowed-sinc FIR kernels (12 taps per phase, phases 1/4, 2/4, 3/4)
 */
const TP_HALF_TAPS = 6; // m in [-5, 6] => 12 taps
export const TP_POLYPHASE_PHASES: readonly Float64Array[] = (() => {
  const tapsPerPhase = TP_HALF_TAPS * 2;
  const phases: Float64Array[] = [];
  for (let p = 1; p <= 3; p++) {
    const frac = p * 0.25;
    const kernel = new Float64Array(tapsPerPhase);
    let sum = 0;
    for (let k = 0; k < tapsPerPhase; k++) {
      const m = k - (TP_HALF_TAPS - 1); // -5 .. +6
      const x = m - frac;
      const sinc = Math.abs(x) < 1e-9 ? 1.0 : Math.sin(Math.PI * x) / (Math.PI * x);
      // Blackman-Harris / Blackman window over [-TP_HALF_TAPS, TP_HALF_TAPS]
      const u = (x + TP_HALF_TAPS) / (2 * TP_HALF_TAPS);
      const w =
        u >= 0 && u <= 1
          ? 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u)
          : 0;
      kernel[k] = sinc * w;
      sum += kernel[k];
    }
    for (let k = 0; k < tapsPerPhase; k++) {
      kernel[k] /= sum;
    }
    phases.push(kernel);
  }
  return phases;
})();

/**
 * Evaluate 3 fractional inter-sample phases (0.25, 0.5, 0.75) between sample idx and idx+1
 */
export function maxInterSampleAbsAt(
  samples: Float32Array,
  idx: number,
  length = samples.length,
  oversampling: 1 | 2 | 4 = 4,
): number {
  let maxAbs = Math.abs(samples[idx]);
  if (oversampling === 1) return maxAbs;

  const phaseIndices = oversampling === 2 ? [1] : [0, 1, 2];
  for (const p of phaseIndices) {
    const k = TP_POLYPHASE_PHASES[p];
    let acc = 0;
    for (let t = 0; t < k.length; t++) {
      const pos = idx + (t - (TP_HALF_TAPS - 1));
      if (pos >= 0 && pos < length) {
        acc += samples[pos] * k[t];
      }
    }
    const a = Math.abs(acc);
    if (a > maxAbs) maxAbs = a;
  }
  return maxAbs;
}

/**
 * Estimate 4x oversampled True Peak using ITU-R BS.1770-4 windowed-sinc polyphase FIR
 */
function estimateChannelTruePeak(samples: Float32Array): {
  samplePeak: number;
  truePeak: number;
  clippedSamples: number;
  interSamplePeaks: number;
} {
  const n = samples.length;
  let samplePeak = 0;
  let clippedSamples = 0;

  // First pass establishes the sample-peak floor. A polyphase FIR output is
  // bounded by max(|window samples|) * the phase kernel's L1 norm.
  for (let i = 0; i < n; i++) {
    const magnitude = Math.abs(samples[i]);
    if (magnitude > samplePeak) samplePeak = magnitude;
    if (magnitude >= 0.999) clippedSamples++;
  }

  if (n < 2) {
    return { samplePeak, truePeak: samplePeak, clippedSamples, interSamplePeaks: 0 };
  }

  let maxKernelL1 = 0;
  for (let p = 0; p < TP_POLYPHASE_PHASES.length; p++) {
    const kernel = TP_POLYPHASE_PHASES[p];
    let l1 = 0;
    for (let t = 0; t < kernel.length; t++) l1 += Math.abs(kernel[t]);
    if (l1 > maxKernelL1) maxKernelL1 = l1;
  }

  // Only windows capable of beating the sample peak need interpolation.
  // When the source already clips, also retain windows capable of producing
  // an inter-sample-peak event (> 0 dBFS), even if they cannot beat global peak.
  const candidateThreshold = Math.min(samplePeak, 1) / Math.max(maxKernelL1, 1e-12);
  const candidates = new Uint8Array(n);
  const leftReach = TP_HALF_TAPS;
  const rightReach = TP_HALF_TAPS - 1;

  for (let sampleIndex = 0; sampleIndex < n; sampleIndex++) {
    if (Math.abs(samples[sampleIndex]) <= candidateThreshold) continue;
    const firstCenter = Math.max(0, sampleIndex - leftReach);
    const lastCenter = Math.min(n - 2, sampleIndex + rightReach);
    for (let center = firstCenter; center <= lastCenter; center++) {
      candidates[center] = 1;
    }
  }

  let truePeak = samplePeak;
  let interSamplePeaks = 0;
  const phase0 = TP_POLYPHASE_PHASES[0];
  const phase1 = TP_POLYPHASE_PHASES[1];
  const phase2 = TP_POLYPHASE_PHASES[2];

  for (let i = 0; i < n - 1; i++) {
    if (candidates[i] === 0) continue;

    let phaseMax = 0;
    let acc0 = 0;
    let acc1 = 0;
    let acc2 = 0;
    for (let t = 0; t < phase0.length; t++) {
      const pos = i + (t - (TP_HALF_TAPS - 1));
      if (pos < 0 || pos >= n) continue;
      const sample = samples[pos];
      acc0 += sample * phase0[t];
      acc1 += sample * phase1[t];
      acc2 += sample * phase2[t];
    }
    phaseMax = Math.max(Math.abs(acc0), Math.abs(acc1), Math.abs(acc2));
    if (phaseMax > truePeak) truePeak = phaseMax;

    if (phaseMax > 1 && Math.abs(samples[i]) <= 1 && Math.abs(samples[i + 1]) <= 1) {
      interSamplePeaks++;
    }
  }

  return { samplePeak, truePeak, clippedSamples, interSamplePeaks };
}

/**
 * Fast ITU-R BS.1770-4 K-weighted integrated LUFS helper
 */
export function measureIntegratedLufs(channels: Float32Array[], sampleRate: number): number {
  const numChannels = channels.length;
  const left = channels[0];
  if (!left || left.length === 0) return -70;
  const right = numChannels > 1 ? channels[1] : left;
  const length = left.length;

  const { shelf, rlb } = designKWeightingFilters(sampleRate);
  const workL = new Float32Array(length);
  const workR = numChannels > 1 ? new Float32Array(length) : workL;
  processBiquadBuffer(left, workL, shelf);
  processBiquadBuffer(workL, workL, rlb);
  if (numChannels > 1) {
    processBiquadBuffer(right, workR, shelf);
    processBiquadBuffer(workR, workR, rlb);
  }

  const blockSamples = Math.max(1, Math.round(sampleRate * 0.4));
  const hopSamples = Math.max(1, Math.round(sampleRate * 0.1));
  const blockMeanSquares: number[] = [];

  if (length < blockSamples) {
    let ms = 0;
    for (let i = 0; i < length; i++) {
      ms += workL[i] * workL[i] + (numChannels > 1 ? workR[i] * workR[i] : 0);
    }
    blockMeanSquares.push(ms / Math.max(1, length));
  } else {
    const energyRing = new Float64Array(blockSamples);
    let rollingEnergy = 0;
    for (let i = 0; i < length; i++) {
      const energy = workL[i] * workL[i] + (numChannels > 1 ? workR[i] * workR[i] : 0);
      const slot = i % blockSamples;
      if (i >= blockSamples) rollingEnergy -= energyRing[slot];
      energyRing[slot] = energy;
      rollingEnergy += energy;
      if (i + 1 >= blockSamples && (i + 1 - blockSamples) % hopSamples === 0) {
        blockMeanSquares.push(Math.max(0, rollingEnergy) / blockSamples);
      }
    }
  }

  const absGate = Math.pow(10, (-70 + 0.691) / 10);
  const absPassed = blockMeanSquares.filter((z) => z > absGate);
  if (absPassed.length === 0) return -70;
  const ungatedMean = absPassed.reduce((a, b) => a + b, 0) / absPassed.length;
  const ungatedLufs = -0.691 + 10 * Math.log10(Math.max(ungatedMean, 1e-12));
  const relGate = Math.pow(10, (ungatedLufs - 10 + 0.691) / 10);
  const relPassed = absPassed.filter((z) => z > relGate);
  if (relPassed.length === 0) return -70;
  const gatedMean = relPassed.reduce((a, b) => a + b, 0) / relPassed.length;
  return -0.691 + 10 * Math.log10(Math.max(gatedMean, 1e-12));
}

/**
 * Compute full SYN-ANALYZE AudioAnalysis from stereo/mono Float32Array channels
 */
export function analyzeAudioBuffer(
  channels: Float32Array[],
  sampleRate: number,
): AudioAnalysis {
  const numChannels = channels.length;
  const left = channels[0];
  const right = numChannels > 1 ? channels[1] : channels[0];
  const length = left.length;
  const durationSec = length / sampleRate;

  // 1. Sample Peak, True Peak, Clipping, DC Offset, RMS
  const tpLeft = estimateChannelTruePeak(left);
  const tpRight = numChannels > 1 ? estimateChannelTruePeak(right) : tpLeft;

  const samplePeak = Math.max(tpLeft.samplePeak, tpRight.samplePeak);
  const truePeak = Math.max(tpLeft.truePeak, tpRight.truePeak);
  const clippedSamples = tpLeft.clippedSamples + (numChannels > 1 ? tpRight.clippedSamples : 0);
  const interSamplePeaks = tpLeft.interSamplePeaks + (numChannels > 1 ? tpRight.interSamplePeaks : 0);

  let sumSqL = 0;
  let sumSqR = 0;
  let sumL = 0;
  let sumR = 0;
  let sumProd = 0;
  let sumMidSq = 0;
  let sumSideSq = 0;

  for (let i = 0; i < length; i++) {
    const l = left[i];
    const r = right[i];
    sumL += l;
    sumR += r;
    sumSqL += l * l;
    sumSqR += r * r;
    sumProd += l * r;
    const m = 0.5 * (l + r);
    const s = 0.5 * (l - r);
    sumMidSq += m * m;
    sumSideSq += s * s;
  }

  const rmsL = Math.sqrt(sumSqL / Math.max(1, length));
  const rmsR = Math.sqrt(sumSqR / Math.max(1, length));
  const rmsCombined = Math.sqrt((sumSqL + sumSqR) / Math.max(1, length * 2));
  const rmsDb = linearToDb(rmsCombined);
  const samplePeakDb = linearToDb(samplePeak);
  const truePeakDb = linearToDb(truePeak);
  const dcOffset = Math.max(Math.abs(sumL / Math.max(1, length)), Math.abs(sumR / Math.max(1, length)));
  const clicks = detectClicks(numChannels > 1 ? [left, right] : [left], sampleRate);

  // 2. Stereo Correlation & Width
  const denom = Math.sqrt(sumSqL * sumSqR);
  const phaseCorrelation =
    sumSqL < 1e-12 && sumSqR < 1e-12
      ? 1
      : sumSqL < 1e-12 || sumSqR < 1e-12
        ? 0
        : Math.max(-1, Math.min(1, sumProd / denom));
  const midRms = Math.sqrt(sumMidSq / Math.max(1, length));
  const sideRms = Math.sqrt(sumSideSq / Math.max(1, length));
  const midSideRatioDb = linearToDb(midRms) - linearToDb(Math.max(sideRms, 1e-7));
  const stereoWidth = Math.min(2.0, (2 * sideRms) / Math.max(midRms + sideRms, 1e-9));
  const lrBalanceDb = linearToDb(rmsR) - linearToDb(rmsL);

  // Two reusable full-track work buffers keep stereo analysis memory bounded.
  const scratchL = new Float32Array(length);
  const scratchR = numChannels > 1 ? new Float32Array(length) : scratchL;

  // Low-end (<120Hz) phase correlation via 2nd-order Butterworth LPF (-12 dB/oct)
  const lpCoeffs = designLowPass(120, Math.SQRT1_2, sampleRate);
  processBiquadBuffer(left, scratchL, lpCoeffs);
  if (numChannels > 1) processBiquadBuffer(right, scratchR, lpCoeffs);
  let lpSqL = 0;
  let lpSqR = 0;
  let lpProd = 0;
  for (let i = 0; i < length; i++) {
    const lVal = scratchL[i];
    const rVal = scratchR[i];
    lpSqL += lVal * lVal;
    lpSqR += rVal * rVal;
    lpProd += lVal * rVal;
  }
  const lpDenom = Math.sqrt(lpSqL * lpSqR);
  const lowEndCorrelation =
    lpSqL < 1e-12 && lpSqR < 1e-12
      ? 1
      : lpSqL < 1e-12 || lpSqR < 1e-12
        ? 0
        : Math.max(-1, Math.min(1, lpProd / lpDenom));

  // Measure each frequency-localized band before reusing the same work buffers.
  const lp150 = designLowPass(150, Math.SQRT1_2, sampleRate);
  const hp150 = designHighPass(150, Math.SQRT1_2, sampleRate);
  const lp3500 = designLowPass(3500, Math.SQRT1_2, sampleRate);
  const hp3500 = designHighPass(3500, Math.SQRT1_2, sampleRate);
  const measureCorrelation = (a: Float32Array, b: Float32Array): number => {
    let aa = 0;
    let bb = 0;
    let ab = 0;
    for (let i = 0; i < length; i++) {
      aa += a[i] * a[i];
      bb += b[i] * b[i];
      ab += a[i] * b[i];
    }
    if (aa < 1e-12 && bb < 1e-12) return 1;
    if (aa < 1e-12 || bb < 1e-12) return 0;
    const d = Math.sqrt(aa * bb);
    return d > 1e-12 ? Math.max(-1, Math.min(1, ab / d)) : 0;
  };

  processBiquadBuffer(left, scratchL, lp150);
  if (numChannels > 1) processBiquadBuffer(right, scratchR, lp150);
  const lowBandCorrelation = measureCorrelation(scratchL, scratchR);

  processBiquadBuffer(left, scratchL, hp150);
  if (numChannels > 1) processBiquadBuffer(right, scratchR, hp150);
  processBiquadBuffer(scratchL, scratchL, lp3500);
  if (numChannels > 1) processBiquadBuffer(scratchR, scratchR, lp3500);
  const midBandCorrelation = measureCorrelation(scratchL, scratchR);

  processBiquadBuffer(left, scratchL, hp3500);
  if (numChannels > 1) processBiquadBuffer(right, scratchR, hp3500);
  const highBandCorrelation = measureCorrelation(scratchL, scratchR);

  const stereoBandCorrelation = {
    low: Number(lowBandCorrelation.toFixed(3)),
    mid: Number(midBandCorrelation.toFixed(3)),
    high: Number(highBandCorrelation.toFixed(3)),
  };

  const monoCompatibilityScore = Math.round(Math.max(0, Math.min(100,
    ((phaseCorrelation + 1) * 0.5) * 20 +
    ((stereoBandCorrelation.low + 1) * 0.5) * 30 +
    ((stereoBandCorrelation.mid + 1) * 0.5) * 25 +
    ((stereoBandCorrelation.high + 1) * 0.5) * 25,
  )));

  // 3. ITU-R BS.1770-4 K-Weighted LUFS
  const { shelf, rlb } = designKWeightingFilters(sampleRate);
  processBiquadBuffer(left, scratchL, shelf);
  processBiquadBuffer(scratchL, scratchL, rlb);
  if (numChannels > 1) {
    processBiquadBuffer(right, scratchR, shelf);
    processBiquadBuffer(scratchR, scratchR, rlb);
  }

  const blockSamples = Math.max(1, Math.round(sampleRate * 0.4)); // 400ms
  const hopSamples = Math.max(1, Math.round(sampleRate * 0.1)); // 100ms (75% overlap)
  const blockMeanSquares: number[] = [];
  const blockLufsList: number[] = [];

  if (length < blockSamples) {
    let ms = 0;
    for (let i = 0; i < length; i++) {
      ms += scratchL[i] * scratchL[i] + (numChannels > 1 ? scratchR[i] * scratchR[i] : 0);
    }
    const meanSq = ms / Math.max(1, length);
    blockMeanSquares.push(meanSq);
    blockLufsList.push(-0.691 + 10 * Math.log10(Math.max(meanSq, 1e-12)));
  } else {
    // Rolling 400ms energy window with 100ms hops; storage is bounded by one window.
    const energyRing = new Float64Array(blockSamples);
    let rollingEnergy = 0;
    for (let i = 0; i < length; i++) {
      const energy = scratchL[i] * scratchL[i] + (numChannels > 1 ? scratchR[i] * scratchR[i] : 0);
      const slot = i % blockSamples;
      if (i >= blockSamples) rollingEnergy -= energyRing[slot];
      energyRing[slot] = energy;
      rollingEnergy += energy;
      if (i + 1 >= blockSamples && (i + 1 - blockSamples) % hopSamples === 0) {
        const meanSq = Math.max(0, rollingEnergy) / blockSamples;
        blockMeanSquares.push(meanSq);
        blockLufsList.push(-0.691 + 10 * Math.log10(Math.max(meanSq, 1e-12)));
      }
    }
  }

  // Absolute gate (-70 LKFS)
  const absGate = Math.pow(10, (-70 + 0.691) / 10);
  const absPassed = blockMeanSquares.filter((z) => z > absGate);
  let integratedLufs = -70;
  if (absPassed.length > 0) {
    const ungatedMean = absPassed.reduce((a, b) => a + b, 0) / absPassed.length;
    const ungatedLufs = -0.691 + 10 * Math.log10(Math.max(ungatedMean, 1e-12));
    const relGate = Math.pow(10, (ungatedLufs - 10 + 0.691) / 10);
    const relPassed = absPassed.filter((z) => z > relGate);
    if (relPassed.length > 0) {
      const gatedMean = relPassed.reduce((a, b) => a + b, 0) / relPassed.length;
      integratedLufs = -0.691 + 10 * Math.log10(Math.max(gatedMean, 1e-12));
    }
  }

  const momentaryLufsMax = blockLufsList.reduce((max, value) => Math.max(max, value), integratedLufs);

  // Short-term 3-second sliding LUFS (30 x 100ms hops)
  const shortTermBlocks: number[] = [];
  if (blockMeanSquares.length >= 30) {
    for (let i = 0; i <= blockMeanSquares.length - 30; i++) {
      let sum = 0;
      for (let j = 0; j < 30; j++) sum += blockMeanSquares[i + j];
      shortTermBlocks.push(-0.691 + 10 * Math.log10(Math.max(sum / 30, 1e-12)));
    }
  } else if (blockLufsList.length > 0) {
    shortTermBlocks.push(...blockLufsList);
  }
  const shortTermLufsMax = shortTermBlocks.reduce((max, value) => Math.max(max, value), integratedLufs);

  // Loudness Range (LRA)
  const lraCandidates = shortTermBlocks.filter((l) => l > -70 && l > integratedLufs - 20).sort((a, b) => a - b);
  let loudnessRangeLu = 0;
  if (lraCandidates.length >= 4) {
    const p10 = lraCandidates[Math.floor(lraCandidates.length * 0.1)];
    const p95 = lraCandidates[Math.min(lraCandidates.length - 1, Math.floor(lraCandidates.length * 0.95))];
    loudnessRangeLu = Math.max(0, p95 - p10);
  }

  // Downsample loudness history to ~60 points for Dynamics Lab chart
  const loudnessHistoryLufs: number[] = [];
  const histSource = shortTermBlocks.length > 0 ? shortTermBlocks : blockLufsList;
  const histSteps = Math.min(60, Math.max(1, histSource.length));
  for (let i = 0; i < histSteps; i++) {
    const idx = Math.floor((i / histSteps) * histSource.length);
    loudnessHistoryLufs.push(Number(Math.max(-60, histSource[idx] ?? -60).toFixed(2)));
  }

  // 4. Dynamics & Transients
  const crestFactorDb = Math.max(0, samplePeakDb - rmsDb);
  const plrDb = Math.max(0, truePeakDb - integratedLufs);
  // DR estimate from top 20% RMS blocks minus overall RMS / crest blend
  const sortedBlocks = [...blockLufsList].filter((v) => v > -65).sort((a, b) => b - a);
  const top20Count = Math.max(1, Math.floor(sortedBlocks.length * 0.2));
  const top20Avg =
    sortedBlocks.length > 0
      ? sortedBlocks.slice(0, top20Count).reduce((a, b) => a + b, 0) / top20Count
      : integratedLufs;
  const dynamicRangeDb =
    length === 0 || samplePeak < 1e-7
      ? 0
      : Math.max(
          1,
          Math.min(28, crestFactorDb * 0.65 + (samplePeakDb - top20Avg) * 0.35 + loudnessRangeLu * 0.25),
        );

  // Transient density via short-window energy flux
  const hopTr = Math.max(128, Math.round(sampleRate * 0.01));
  let prevE = 0;
  let transientHits = 0;
  let frameCount = 0;
  for (let start = 0; start + hopTr <= length; start += hopTr) {
    let e = 0;
    for (let i = 0; i < hopTr; i++) {
      const m = 0.5 * (left[start + i] + right[start + i]);
      e += m * m;
    }
    e /= hopTr;
    if (frameCount > 0 && e > prevE * 3.2 && e > 1e-5) {
      transientHits++;
    }
    prevE = e * 0.6 + prevE * 0.4;
    frameCount++;
  }
  const transientDensity = Math.min(1, transientHits / Math.max(1, durationSec * 6));

  // 5. Spectral Analysis via averaged Hann-windowed 4096-pt FFT across full track span
  const fftSize = 4096;
  const halfBins = fftSize >> 1;
  const win = createHannWindow(fftSize);
  const leftForFft = new Float32Array(fftSize);
  const rightForFft = numChannels > 1 ? new Float32Array(fftSize) : leftForFft;
  const avgPower = new Float64Array(halfBins);
  const maxOffset = Math.max(0, length - fftSize);
  const numFrames = length <= fftSize ? 1 : Math.min(48, Math.max(1, Math.floor(length / (fftSize >> 1))));

  for (let f = 0; f < numFrames; f++) {
    const offset =
      numFrames <= 1 || maxOffset === 0
        ? 0
        : Math.min(maxOffset, Math.round((f / (numFrames - 1)) * maxOffset));
    const sliceLen = Math.min(fftSize, length - offset);
    leftForFft.fill(0);
    if (numChannels > 1) rightForFft.fill(0);
    for (let i = 0; i < sliceLen; i++) {
      leftForFft[i] = left[offset + i];
      if (numChannels > 1) rightForFft[i] = right[offset + i];
    }

    const frameWindow = sliceLen < fftSize ? undefined : win;
    const leftFrameDb = computeMagnitudeSpectrumDb(
      sliceLen < fftSize ? leftForFft.subarray(0, sliceLen) : leftForFft,
      fftSize,
      frameWindow,
    );
    const rightFrameDb =
      numChannels > 1
        ? computeMagnitudeSpectrumDb(
            sliceLen < fftSize ? rightForFft.subarray(0, sliceLen) : rightForFft,
            fftSize,
            frameWindow,
          )
        : leftFrameDb;

    // Average channel powers, not waveforms. A mono fold-down here would erase
    // legitimate spectral content from wide or polarity-inverted stereo masters.
    for (let b = 0; b < halfBins; b++) {
      const leftPower = Math.pow(10, leftFrameDb[b] / 10);
      const rightPower = Math.pow(10, rightFrameDb[b] / 10);
      avgPower[b] += (0.5 * (leftPower + rightPower)) / numFrames;
    }
  }

  const binHz = sampleRate / fftSize;
  const avgDb = new Float32Array(halfBins);
  for (let b = 0; b < halfBins; b++) {
    avgDb[b] = 10 * Math.log10(Math.max(avgPower[b], 1e-13));
  }

  // Log-spaced 64-band spectrum for display & AI interpretation
  const numLogBands = 64;
  const spectrumBinsFreq: number[] = [];
  const spectrumBinsDb: number[] = [];
  const minF = 24;
  const maxF = Math.min(20000, sampleRate * 0.48);

  for (let i = 0; i < numLogBands; i++) {
    const fLow = minF * Math.pow(maxF / minF, i / numLogBands);
    const fHigh = minF * Math.pow(maxF / minF, (i + 1) / numLogBands);
    const fCenter = Math.sqrt(fLow * fHigh);
    const bStart = Math.max(1, Math.floor(fLow / binHz));
    const bEnd = Math.min(halfBins - 1, Math.max(bStart, Math.ceil(fHigh / binHz)));
    let powerSum = 0;
    let count = 0;
    for (let b = bStart; b <= bEnd; b++) {
      powerSum += avgPower[b];
      count++;
    }
    spectrumBinsFreq.push(Math.round(fCenter));
    spectrumBinsDb.push(Number((10 * Math.log10(Math.max(powerSum / Math.max(1, count), 1e-13))).toFixed(2)));
  }

  // Band levels use the same log-frequency spectral samples exposed to the Director.
  // Each stored log band represents an equal interval on the log-frequency axis, so
  // averaging their linear powers estimates mean spectral density per log-frequency band.
  // This intentionally differs from integrated band power: it compares tonal balance
  // without automatically favoring wider frequency ranges.
  const logBandMeanDb = (f1: number, f2: number): number => {
    let powerSum = 0;
    let count = 0;
    for (let i = 0; i < spectrumBinsFreq.length; i++) {
      const f = spectrumBinsFreq[i];
      const db = spectrumBinsDb[i];
      if (f >= f1 && f <= f2 && Number.isFinite(db)) {
        powerSum += Math.pow(10, db / 10);
        count++;
      }
    }
    return count > 0
      ? Number((10 * Math.log10(Math.max(powerSum / count, 1e-13))).toFixed(2))
      : -130;
  };

  const zoneEnergyDb: SpectralBandEnergy = {
    sub: logBandMeanDb(SPECTRAL_ZONES_HZ.sub[0], SPECTRAL_ZONES_HZ.sub[1]),
    bass: logBandMeanDb(SPECTRAL_ZONES_HZ.bass[0], SPECTRAL_ZONES_HZ.bass[1]),
    lowMid: logBandMeanDb(SPECTRAL_ZONES_HZ.lowMid[0], SPECTRAL_ZONES_HZ.lowMid[1]),
    mid: logBandMeanDb(SPECTRAL_ZONES_HZ.mid[0], SPECTRAL_ZONES_HZ.mid[1]),
    highMid: logBandMeanDb(SPECTRAL_ZONES_HZ.highMid[0], SPECTRAL_ZONES_HZ.highMid[1]),
    presence: logBandMeanDb(SPECTRAL_ZONES_HZ.presence[0], SPECTRAL_ZONES_HZ.presence[1]),
    air: logBandMeanDb(SPECTRAL_ZONES_HZ.air[0], Math.min(SPECTRAL_ZONES_HZ.air[1], sampleRate * 0.48)),
  };

  // Spectral Centroid & Slope
  let weightedFreqSum = 0;
  let totalMag = 0;
  for (let b = 1; b < halfBins; b++) {
    const mag = Math.sqrt(avgPower[b]);
    weightedFreqSum += b * binHz * mag;
    totalMag += mag;
  }
  const spectralCentroidHz = Math.round(totalMag > 1e-12 ? weightedFreqSum / totalMag : 1000);
  const bassCenterHz = Math.sqrt(60 * 250);
  const presenceCenterHz = Math.sqrt(6000 * 12000);
  const slopeOctaves = Math.log2(presenceCenterHz / bassCenterHz);
  const spectralSlopeDbPerOct = Number(((zoneEnergyDb.presence - zoneEnergyDb.bass) / slopeOctaves).toFixed(2));

  // Resonance candidates are local spectral prominences, not simply loud partials.
  // A coherent harmonic family is treated as musical/instrument energy rather than a
  // collection of independent resonances. Cutting each partial dynamically would
  // hollow sustained notes and can make pitched instruments sound dull or unstable.
  const resonanceCandidates: Array<{ freqHz: number; excessDb: number; levelDb: number }> = [];
  for (let i = 4; i < spectrumBinsDb.length - 4; i++) {
    const f = spectrumBinsFreq[i];
    if (f < 80 || f > 12000) continue;
    const neighborAvg =
      (spectrumBinsDb[i - 4] +
        spectrumBinsDb[i - 3] +
        spectrumBinsDb[i - 2] +
        spectrumBinsDb[i + 2] +
        spectrumBinsDb[i + 3] +
        spectrumBinsDb[i + 4]) /
      6;
    const excess = spectrumBinsDb[i] - neighborAvg;
    if (
      excess > 4.8 &&
      spectrumBinsDb[i] > spectrumBinsDb[i - 1] &&
      spectrumBinsDb[i] >= spectrumBinsDb[i + 1] &&
      spectrumBinsDb[i] > -65
    ) {
      resonanceCandidates.push({
        freqHz: f,
        excessDb: Number(excess.toFixed(1)),
        levelDb: spectrumBinsDb[i],
      });
    }
  }

  const isHarmonicRelated = (aHz: number, bHz: number): boolean => {
    const ratio = Math.max(aHz, bHz) / Math.min(aHz, bHz);
    const harmonicNumber = Math.round(ratio);
    return harmonicNumber >= 2 &&
      harmonicNumber <= 8 &&
      Math.abs(ratio - harmonicNumber) / harmonicNumber <= 0.12;
  };
  const harmonicFamily = new Set<number>();
  for (let i = 0; i < resonanceCandidates.length; i++) {
    const relatedIndices: number[] = [];
    for (let j = 0; j < resonanceCandidates.length; j++) {
      if (i === j) continue;
      const candidate = resonanceCandidates[i];
      const related = resonanceCandidates[j];
      if (
        Math.abs(candidate.levelDb - related.levelDb) <= 24 &&
        isHarmonicRelated(candidate.freqHz, related.freqHz)
      ) {
        relatedIndices.push(j);
      }
    }
    // When one measured fundamental has at least two matching partials, protect the
    // entire family, not only the fundamental. Otherwise upper partials are still
    // misclassified as isolated resonances and receive unnecessary dynamic cuts.
    if (relatedIndices.length >= 2) {
      harmonicFamily.add(i);
      for (const relatedIndex of relatedIndices) harmonicFamily.add(relatedIndex);
    }
  }

  const resonances: ResonancePeak[] = resonanceCandidates
    .filter((_candidate, index) => !harmonicFamily.has(index))
    .map((candidate) => ({
      freqHz: candidate.freqHz,
      excessDb: candidate.excessDb,
      severity: candidate.excessDb > 8 ? ('high' as const) : candidate.excessDb > 6 ? ('moderate' as const) : ('low' as const),
    }))
    .sort((a, b) => b.excessDb - a.excessDb);

  // Harmonic / Saturation / Clipping indicator
  // Measure spectral harmonic THD when a dominant tonal fundamental peak rises > 18 dB above broadband floor
  let harmonicThdPercent = 0;
  let fundBin = 2;
  let maxPower = 0;
  const maxFundSearchBin = Math.floor(halfBins / 4);
  for (let b = 2; b < maxFundSearchBin; b++) {
    if (avgPower[b] > maxPower) {
      maxPower = avgPower[b];
      fundBin = b;
    }
  }
  if (maxPower > 1e-7 && fundBin >= 3) {
    let localFloorSum = 0;
    let localCount = 0;
    for (let d = 10; d <= 20; d++) {
      if (fundBin - d >= 2) {
        localFloorSum += avgPower[fundBin - d];
        localCount++;
      }
      if (fundBin + d < halfBins) {
        localFloorSum += avgPower[fundBin + d];
        localCount++;
      }
    }
    const localFloor = localFloorSum / Math.max(1, localCount);
    if (maxPower > localFloor * 64) {
      let fundPower = 0;
      for (let k = -2; k <= 2; k++) {
        if (fundBin + k >= 1 && fundBin + k < halfBins) fundPower += avgPower[fundBin + k];
      }
      let harmPower = 0;
      for (let h = 2; h <= 7; h++) {
        const hb = fundBin * h;
        if (hb + 2 >= halfBins) break;
        for (let k = -2; k <= 2; k++) {
          const excess = avgPower[hb + k] - localFloor;
          if (excess > 0) harmPower += excess;
        }
      }
      if (fundPower > 1e-12) {
        harmonicThdPercent = 100 * Math.sqrt(harmPower / fundPower);
      }
    }
  }

  const clipRatio = clippedSamples / Math.max(1, length * numChannels);
  const clipThdPercent = clipRatio * 100 * 12 + (interSamplePeaks > 0 ? Math.min(2.5, interSamplePeaks * 0.02) : 0);
  const thdEstimatePercent = Number(
    Math.min(50, Math.max(harmonicThdPercent, clipThdPercent)).toFixed(3),
  );

  // 6. Noise Floor estimation from 50ms RMS windows (5th percentile of active/quiet frames)
  const noiseWinSamples = Math.max(64, Math.round(sampleRate * 0.05));
  const frameRmsDb: number[] = [];
  for (let start = 0; start + noiseWinSamples <= length; start += noiseWinSamples) {
    let e = 0;
    for (let i = 0; i < noiseWinSamples; i++) {
      const lVal = left[start + i];
      const rVal = right[start + i];
      e += 0.5 * (lVal * lVal + rVal * rVal);
    }
    const rmsWin = Math.sqrt(e / noiseWinSamples);
    frameRmsDb.push(linearToDb(rmsWin, -96));
  }
  if (frameRmsDb.length === 0 && length > 0) {
    frameRmsDb.push(Math.max(-96, rmsDb));
  }
  frameRmsDb.sort((a, b) => a - b);
  const nonSilent = frameRmsDb.filter((db) => db > -95.5);
  const noiseSource = nonSilent.length >= 4 ? nonSilent : frameRmsDb;
  const noisePercentileIdx = Math.min(
    Math.max(0, noiseSource.length - 1),
    Math.floor(noiseSource.length * 0.05),
  );
  const noiseFloorDb = Number(
    Math.max(-96, Math.min(0, noiseSource[noisePercentileIdx] ?? -96)).toFixed(2),
  );

  return {
    durationSec: Number(durationSec.toFixed(3)),
    sampleRate,
    channels: numChannels,
    integratedLufs: Number(integratedLufs.toFixed(2)),
    shortTermLufsMax: Number(shortTermLufsMax.toFixed(2)),
    momentaryLufsMax: Number(momentaryLufsMax.toFixed(2)),
    loudnessRangeLu: Number(loudnessRangeLu.toFixed(2)),
    rmsDb: Number(rmsDb.toFixed(2)),
    samplePeakDb: Number(samplePeakDb.toFixed(2)),
    truePeakDb: Number(truePeakDb.toFixed(2)),
    dynamicRangeDb: Number(dynamicRangeDb.toFixed(2)),
    crestFactorDb: Number(crestFactorDb.toFixed(2)),
    plrDb: Number(plrDb.toFixed(2)),
    transientDensity: Number(transientDensity.toFixed(2)),
    spectralCentroidHz,
    spectralSlopeDbPerOct,
    zoneEnergyDb,
    spectrumBinsFreq,
    spectrumBinsDb,
    resonances: resonances.slice(0, 6),
    stereoWidth: Number(stereoWidth.toFixed(3)),
    midSideRatioDb: Number(midSideRatioDb.toFixed(2)),
    phaseCorrelation: Number(phaseCorrelation.toFixed(3)),
    lowEndCorrelation: Number(lowEndCorrelation.toFixed(3)),
    stereoBandCorrelation,
    lrBalanceDb: Number(lrBalanceDb.toFixed(2)),
    monoCompatibilityScore,
    clippedSamples,
    interSamplePeaks,
    thdEstimatePercent,
    noiseFloorDb,
    dcOffset: Number(dcOffset.toFixed(5)),
    loudnessHistoryLufs,
    clickCount: clicks.clickCount,
    clicksPerMinute: clicks.clicksPerMinute,
    clickTimesSec: clicks.clickTimesSec,
    clickAtStart: clicks.startClick,
    clickAtEnd: clicks.endClick,
    edgeStartStep: clicks.startStep,
    edgeEndStep: clicks.endStep,
  };
}

/**
 * Generate waveform min/max envelope peaks for high-resolution canvas timeline
 */
export function extractWaveformPeaks(
  channels: Float32Array[],
  targetBuckets = 400,
): number[] {
  const left = channels[0];
  const right = channels.length > 1 ? channels[1] : left;
  const n = left.length;
  const bucketSize = Math.max(1, Math.floor(n / targetBuckets));
  const peaks: number[] = [];

  for (let b = 0; b < targetBuckets; b++) {
    const start = b * bucketSize;
    const end = Math.min(n, start + bucketSize);
    let maxVal = 0;
    for (let i = start; i < end; i++) {
      const m = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      if (m > maxVal) maxVal = m;
    }
    peaks.push(Number(maxVal.toFixed(4)));
  }

  return peaks;
}
