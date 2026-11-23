import type {
  BassEnhancerParams,
  CompressorParams,
  DynamicEQParams,
  EQBand,
  LimiterParams,
  MaximizerParams,
  MultibandBandParams,
  MultibandCompParams,
  ParametricEQParams,
  ProcessorModule,
  RestoreParams,
  SaturationParams,
  StereoImagerParams,
} from '../types/mastering';
import { dbToLinear, linearToDb, maxInterSampleAbsAt, measureIntegratedLufs } from './analyzer';
import {
  BiquadCoeffs,
  BiquadState,
  createBiquadState,
  designAllPass,
  designBandPass,
  designHighPass,
  designHighShelf,
  designLowPass,
  designLowShelf,
  designNotch,
  designPeakingEQ,
  evaluateBiquadMagnitudeDb,
  processBiquadSample,
} from './biquad';
import {
  computeMagnitudeSpectrumDb,
  createBlackmanHarrisWindow,
  createHannWindow,
  fftInPlace,
  ifftInPlace,
} from './fft';

export interface ProcessorMeterTelemetry {
  id: string;
  inputPeakDb: number;
  outputPeakDb: number;
  gainReductionDb: number;
}

export interface OfflineDspResult {
  channels: Float32Array[];
  telemetry: ProcessorMeterTelemetry[];
}

function measurePeakDb(l: Float32Array, r: Float32Array): number {
  let max = 0;
  for (let i = 0; i < l.length; i++) {
    const al = Math.abs(l[i]);
    const ar = Math.abs(r[i]);
    if (al > max) max = al;
    if (ar > max) max = ar;
  }
  return Number(linearToDb(max).toFixed(2));
}

function designEQBand(band: EQBand, sampleRate: number, intensityScale: number): BiquadCoeffs {
  const scaledGain = band.gain * intensityScale;
  switch (band.shape) {
    case 'highpass':
      return designHighPass(band.freq, band.q, sampleRate);
    case 'lowpass':
      return designLowPass(band.freq, band.q, sampleRate);
    case 'lowshelf':
      return designLowShelf(band.freq, scaledGain, band.q, sampleRate);
    case 'highshelf':
      return designHighShelf(band.freq, scaledGain, band.q, sampleRate);
    case 'notch':
      return designNotch(band.freq, band.q * Math.max(0.4, intensityScale), sampleRate);
    case 'bell':
    default:
      return designPeakingEQ(band.freq, scaledGain, band.q, sampleRate);
  }
}

function convolveLinearPhaseFir(
  signal: Float32Array,
  kernelFreqReal: Float32Array,
  kernelFreqImag: Float32Array,
  fftSize: number,
  blockSize: number,
  groupDelay: number,
): void {
  const n = signal.length;
  if (n === 0) return;

  const paddedOut = new Float32Array(n + fftSize);
  const blockReal = new Float32Array(fftSize);
  const blockImag = new Float32Array(fftSize);

  for (let start = 0; start < n; start += blockSize) {
    blockReal.fill(0);
    blockImag.fill(0);
    const copyLen = Math.min(blockSize, n - start);
    for (let i = 0; i < copyLen; i++) {
      blockReal[i] = signal[start + i];
    }

    fftInPlace(blockReal, blockImag);
    for (let k = 0; k < fftSize; k++) {
      const ar = blockReal[k];
      const ai = blockImag[k];
      const br = kernelFreqReal[k];
      const bi = kernelFreqImag[k];
      blockReal[k] = ar * br - ai * bi;
      blockImag[k] = ar * bi + ai * br;
    }
    ifftInPlace(blockReal, blockImag);

    const writeLimit = Math.min(fftSize, paddedOut.length - start);
    for (let i = 0; i < writeLimit; i++) {
      paddedOut[start + i] += blockReal[i];
    }
  }

  for (let i = 0; i < n; i++) {
    const srcIdx = i + groupDelay;
    signal[i] = srcIdx >= 0 && srcIdx < paddedOut.length ? paddedOut[srcIdx] : 0;
  }
}

function applyParametricEQ(
  left: Float32Array,
  right: Float32Array,
  params: ParametricEQParams,
  sampleRate: number,
  intensityScale: number,
): void {
  const n = left.length;
  if (n === 0 || intensityScale <= 1e-4) return;
  const activeBands = params.bands.filter((b) => b.enabled);
  const filters: Array<{ coeffs: BiquadCoeffs; sL: BiquadState; sR: BiquadState }> = activeBands.map(
    (b) => ({
      coeffs: designEQBand(b, sampleRate, intensityScale),
      sL: createBiquadState(),
      sR: createBiquadState(),
    }),
  );

  // Tilt EQ implemented as complementary low/high shelves around 1 kHz
  const tilt = params.tiltDb * intensityScale;
  const hasTilt = Math.abs(tilt) > 0.05;
  const tiltLow = hasTilt ? designLowShelf(650, -tilt * 0.5, 0.55, sampleRate) : null;
  const tiltHigh = hasTilt ? designHighShelf(1500, tilt * 0.5, 0.55, sampleRate) : null;
  const tiltStateL1 = createBiquadState();
  const tiltStateL2 = createBiquadState();
  const tiltStateR1 = createBiquadState();
  const tiltStateR2 = createBiquadState();

  const isMs = params.msMode === 'mid-side';

  if (params.phaseMode === 'linear') {
    const designN = 1024;
    const kernelLen = 1023;
    const halfKernel = (kernelLen - 1) >> 1; // 511
    const convFftSize = 2048;
    const blockSize = 1024;

    const specReal = new Float32Array(designN);
    const specImag = new Float32Array(designN);
    for (let k = 0; k <= designN / 2; k++) {
      const freq = Math.max(1e-3, (k * sampleRate) / designN);
      let magDb = 0;
      for (let f = 0; f < filters.length; f++) {
        magDb += evaluateBiquadMagnitudeDb(filters[f].coeffs, freq, sampleRate);
      }
      if (tiltLow && tiltHigh) {
        magDb += evaluateBiquadMagnitudeDb(tiltLow, freq, sampleRate);
        magDb += evaluateBiquadMagnitudeDb(tiltHigh, freq, sampleRate);
      }
      const mag = dbToLinear(magDb);
      specReal[k] = mag;
      if (k > 0 && k < designN / 2) {
        specReal[designN - k] = mag;
      }
    }

    ifftInPlace(specReal, specImag);
    const win = createBlackmanHarrisWindow(kernelLen);
    const kernelReal = new Float32Array(convFftSize);
    const kernelImag = new Float32Array(convFftSize);
    for (let i = 0; i < kernelLen; i++) {
      const shiftedIdx = (i - halfKernel + designN) % designN;
      kernelReal[i] = specReal[shiftedIdx] * win[i];
    }
    fftInPlace(kernelReal, kernelImag);

    if (isMs) {
      const mid = new Float32Array(n);
      const side = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        mid[i] = 0.5 * (left[i] + right[i]);
        side[i] = 0.5 * (left[i] - right[i]);
      }
      convolveLinearPhaseFir(mid, kernelReal, kernelImag, convFftSize, blockSize, halfKernel);
      for (let i = 0; i < n; i++) {
        left[i] = mid[i] + side[i];
        right[i] = mid[i] - side[i];
      }
    } else {
      convolveLinearPhaseFir(left, kernelReal, kernelImag, convFftSize, blockSize, halfKernel);
      convolveLinearPhaseFir(right, kernelReal, kernelImag, convFftSize, blockSize, halfKernel);
    }
    return;
  }

  for (let i = 0; i < n; i++) {
    let ch1 = isMs ? 0.5 * (left[i] + right[i]) : left[i];
    let ch2 = isMs ? 0.5 * (left[i] - right[i]) : right[i];

    for (let f = 0; f < filters.length; f++) {
      ch1 = processBiquadSample(ch1, filters[f].coeffs, filters[f].sL);
      if (!isMs) {
        ch2 = processBiquadSample(ch2, filters[f].coeffs, filters[f].sR);
      }
    }

    if (tiltLow && tiltHigh) {
      ch1 = processBiquadSample(ch1, tiltLow, tiltStateL1);
      ch1 = processBiquadSample(ch1, tiltHigh, tiltStateL2);
      if (!isMs) {
        ch2 = processBiquadSample(ch2, tiltLow, tiltStateR1);
        ch2 = processBiquadSample(ch2, tiltHigh, tiltStateR2);
      }
    }

    if (isMs) {
      // Mid was EQ'd, Side stays untouched for clean M/S focus
      left[i] = ch1 + ch2;
      right[i] = ch1 - ch2;
    } else {
      left[i] = ch1;
      right[i] = ch2;
    }
  }
}

function applyDynamicEQ(
  left: Float32Array,
  right: Float32Array,
  params: DynamicEQParams,
  sampleRate: number,
  intensityScale: number,
): number {
  const n = left.length;
  let maxGr = 0;

  for (const band of params.bands) {
    if (!band.enabled || band.maxCutDb >= -0.05) continue;
    const bpCoeffs = designBandPass(band.freq, band.q, sampleRate);
    const bpStateL = createBiquadState();
    const bpStateR = createBiquadState();

    const attCoeff = Math.exp(-1 / Math.max(1, (band.attackMs / 1000) * sampleRate));
    const relCoeff = Math.exp(-1 / Math.max(1, (band.releaseMs / 1000) * sampleRate));
    const gainAttackCoeff = attCoeff;
    const gainReleaseCoeff = relCoeff;
    let env = 0;
    let currentGainDb = 0;
    let coeffs = designPeakingEQ(band.freq, 0, band.q, sampleRate);
    const eqL = createBiquadState();
    const eqR = createBiquadState();

    for (let i = 0; i < n; i++) {
      const detL = processBiquadSample(left[i], bpCoeffs, bpStateL);
      const detR = processBiquadSample(right[i], bpCoeffs, bpStateR);
      const det = Math.max(Math.abs(detL), Math.abs(detR));
      env = det > env ? attCoeff * env + (1 - attCoeff) * det : relCoeff * env + (1 - relCoeff) * det;

      const envDb = linearToDb(env);
      let targetCut = 0;
      if (envDb > band.thresholdDb) {
        const over = envDb - band.thresholdDb;
        targetCut = Math.max(band.maxCutDb * intensityScale, -over * 0.65 * intensityScale);
      }
      const gainCoeff = targetCut < currentGainDb ? gainAttackCoeff : gainReleaseCoeff;
      currentGainDb = gainCoeff * currentGainDb + (1 - gainCoeff) * targetCut;
      if (Math.abs(currentGainDb) > maxGr) maxGr = Math.abs(currentGainDb);

      // Update filter coeffs periodically (every 32 samples) for CPU efficiency
      if ((i & 31) === 0) {
        coeffs = designPeakingEQ(band.freq, currentGainDb, band.q, sampleRate);
      }
      left[i] = processBiquadSample(left[i], coeffs, eqL);
      right[i] = processBiquadSample(right[i], coeffs, eqR);
    }
  }

  return Number(maxGr.toFixed(2));
}

function applyCompressor(
  left: Float32Array,
  right: Float32Array,
  params: CompressorParams,
  sampleRate: number,
  intensityScale: number,
): number {
  const n = left.length;
  const attCoeff = Math.exp(-1 / Math.max(1, (params.attackMs / 1000) * sampleRate));
  const relCoeff = Math.exp(-1 / Math.max(1, (params.releaseMs / 1000) * sampleRate));
  const scHpf = designHighPass(params.scHpfHz, 0.707, sampleRate);
  const scL = createBiquadState();
  const scR = createBiquadState();

  const effectiveRatio = 1 + (params.ratio - 1) * intensityScale;
  const makeupLin = dbToLinear(params.makeupDb * intensityScale);
  const knee = Math.max(0.1, params.kneeDb);
  let envDb = -90;
  let maxGr = 0;

  for (let i = 0; i < n; i++) {
    const dl = processBiquadSample(left[i], scHpf, scL);
    const dr = processBiquadSample(right[i], scHpf, scR);
    const peak = Math.max(Math.abs(dl), Math.abs(dr));
    const peakDb = linearToDb(peak);

    const coeff = peakDb > envDb ? attCoeff : relCoeff;
    envDb = coeff * envDb + (1 - coeff) * peakDb;

    let gainChangeDb = 0;
    if (params.mode === 'upward') {
      // Gentle upward boost for quiet signal below threshold
      if (envDb < params.thresholdDb && envDb > -60) {
        const under = params.thresholdDb - envDb;
        gainChangeDb = Math.min(8, under * (1 - 1 / effectiveRatio) * 0.5);
      }
    } else {
      // Soft-knee downward compression
      const diff = envDb - params.thresholdDb;
      if (2 * diff < -knee) {
        gainChangeDb = 0;
      } else if (2 * Math.abs(diff) <= knee) {
        const x = diff + knee * 0.5;
        gainChangeDb = ((1 / effectiveRatio - 1) * x * x) / (2 * knee);
      } else {
        gainChangeDb = (1 / effectiveRatio - 1) * diff;
      }
    }

    if (gainChangeDb < 0 && -gainChangeDb > maxGr) {
      maxGr = -gainChangeDb;
    }

    const linGain = dbToLinear(gainChangeDb) * makeupLin;
    if (params.mode === 'parallel') {
      const compL = left[i] * linGain;
      const compR = right[i] * linGain;
      left[i] = left[i] * 0.55 + compL * 0.45;
      right[i] = right[i] * 0.55 + compR * 0.45;
    } else {
      left[i] *= linGain;
      right[i] *= linGain;
    }
  }

  return Number(maxGr.toFixed(2));
}

function compressMonoBand(
  bufL: Float32Array,
  bufR: Float32Array,
  band: MultibandBandParams,
  sampleRate: number,
  intensityScale: number,
): number {
  if (band.bypass) return 0;
  const n = bufL.length;
  const att = Math.exp(-1 / Math.max(1, (band.attackMs / 1000) * sampleRate));
  const rel = Math.exp(-1 / Math.max(1, (band.releaseMs / 1000) * sampleRate));
  const effRatio = 1 + (band.ratio - 1) * intensityScale;
  const makeup = dbToLinear(band.gainDb * intensityScale);
  let envDb = -90;
  let maxGr = 0;

  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(bufL[i]), Math.abs(bufR[i]));
    const pDb = linearToDb(p);
    const c = pDb > envDb ? att : rel;
    envDb = c * envDb + (1 - c) * pDb;

    let grDb = 0;
    if (envDb > band.thresholdDb) {
      grDb = (1 / effRatio - 1) * (envDb - band.thresholdDb);
    }
    if (-grDb > maxGr) maxGr = -grDb;
    const g = dbToLinear(grDb) * makeup;
    bufL[i] *= g;
    bufR[i] *= g;
  }
  return maxGr;
}

function applyMultibandCompressor(
  left: Float32Array,
  right: Float32Array,
  params: MultibandCompParams,
  sampleRate: number,
  intensityScale: number,
): number {
  const n = left.length;
  const bwQ = Math.SQRT1_2;
  const lpLow = designLowPass(params.lowCrossHz, bwQ, sampleRate);
  const hpLow = designHighPass(params.lowCrossHz, bwQ, sampleRate);
  const lpHigh = designLowPass(params.highCrossHz, bwQ, sampleRate);
  const hpHigh = designHighPass(params.highCrossHz, bwQ, sampleRate);
  const apHigh = designAllPass(params.highCrossHz, bwQ, sampleRate);

  const lowL = new Float32Array(n);
  const lowR = new Float32Array(n);
  const midL = new Float32Array(n);
  const midR = new Float32Array(n);
  const highL = new Float32Array(n);
  const highR = new Float32Array(n);

  const s = Array.from({ length: 18 }, () => createBiquadState());

  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];

    // True 4th-order Linkwitz-Riley (LR4) 3-band crossover with LR2 allpass phase-alignment on low band
    const lLowRaw = processBiquadSample(processBiquadSample(l, lpLow, s[0]), lpLow, s[1]);
    const rLowRaw = processBiquadSample(processBiquadSample(r, lpLow, s[2]), lpLow, s[3]);
    const l1 = processBiquadSample(lLowRaw, apHigh, s[12]);
    const r1 = processBiquadSample(rLowRaw, apHigh, s[13]);

    const restL = processBiquadSample(processBiquadSample(l, hpLow, s[4]), hpLow, s[5]);
    const restR = processBiquadSample(processBiquadSample(r, hpLow, s[6]), hpLow, s[7]);

    const mL = processBiquadSample(processBiquadSample(restL, lpHigh, s[8]), lpHigh, s[9]);
    const mR = processBiquadSample(processBiquadSample(restR, lpHigh, s[10]), lpHigh, s[11]);

    const hL = processBiquadSample(processBiquadSample(restL, hpHigh, s[14]), hpHigh, s[15]);
    const hR = processBiquadSample(processBiquadSample(restR, hpHigh, s[16]), hpHigh, s[17]);

    lowL[i] = l1;
    lowR[i] = r1;
    midL[i] = mL;
    midR[i] = mR;
    highL[i] = hL;
    highR[i] = hR;
  }

  const gr1 = compressMonoBand(lowL, lowR, params.low, sampleRate, intensityScale);
  const gr2 = compressMonoBand(midL, midR, params.mid, sampleRate, intensityScale);
  const gr3 = compressMonoBand(highL, highR, params.high, sampleRate, intensityScale);

  for (let i = 0; i < n; i++) {
    left[i] = lowL[i] + midL[i] + highL[i];
    right[i] = lowR[i] + midR[i] + highR[i];
  }

  return Number(Math.max(gr1, gr2, gr3).toFixed(2));
}

function shapeSample(x: number, driveAmt: number, flavor: SaturationParams['flavor'], harmonics: SaturationParams['harmonics']): number {
  const harmSkew = harmonics === 'even' ? 0.16 * driveAmt : harmonics === 'balanced' ? 0.06 * driveAmt : 0;
  let shaped: number;
  if (flavor === 'hard-clip') {
    const pre = x * (1 + driveAmt * 2.2);
    const thresh = 0.85;
    shaped = Math.max(-thresh, Math.min(thresh, pre)) / (1 + driveAmt * 1.4);
  } else if (flavor === 'tube') {
    const pre = x * (1 + driveAmt * 3.0);
    // Asymmetric grid bias: tanh(pre + harmSkew) generates negative x^2 term, so quadratic bias uses same negative polarity
    shaped = (Math.tanh(pre + harmSkew) - Math.tanh(harmSkew) - harmSkew * 0.45 * (pre * pre) / (1 + pre * pre)) /
      Math.max(1.0, Math.tanh(1 + driveAmt * 2.0));
  } else if (flavor === 'tape') {
    const pre = x * (1 + driveAmt * 2.4);
    const smallSigNorm = 1 + driveAmt * 2.1;
    shaped = ((pre / (1 + Math.abs(pre) * 0.72)) + harmSkew * 0.45 * (pre * pre) / (1 + 0.5 * pre * pre)) / smallSigNorm;
  } else if (flavor === 'exciter') {
    const pre = x * (1 + driveAmt * 2.8);
    const sat = Math.tanh(pre * 1.4 + harmSkew);
    shaped = x * 0.75 + (sat - Math.tanh(harmSkew) - x) * 0.45;
  } else {
    const pre = x * (1 + driveAmt * 2.6);
    shaped = (Math.tanh(pre + harmSkew) - Math.tanh(harmSkew)) / Math.max(1, Math.tanh(1 + driveAmt * 1.8));
  }
  return shaped;
}

function applySaturation(
  left: Float32Array,
  right: Float32Array,
  params: SaturationParams,
  sampleRate: number,
  intensityScale: number,
): void {
  const n = left.length;
  const driveAmt = (params.drive / 100) * intensityScale;
  if (driveAmt <= 0.001 && Math.abs(params.tone) < 1) return;

  const toneTilt = designHighShelf(3200, (params.tone / 100) * 4.5 * intensityScale, 0.65, sampleRate);
  const tL = createBiquadState();
  const tR = createBiquadState();

  // 1st-order DC blocker to eliminate any asymmetric even-harmonic DC offset
  const dcR = Math.exp((-2 * Math.PI * 10) / Math.max(8000, sampleRate));
  let dcPrevInL = 0, dcPrevOutL = 0;
  let dcPrevInR = 0, dcPrevOutR = 0;

  const os = params.oversampling >= 4 ? 4 : params.oversampling >= 2 ? 2 : 1;
  let prevL = 0;
  let prevR = 0;

  for (let i = 0; i < n; i++) {
    const curL = left[i];
    const curR = right[i];

    let shapedL = 0;
    let shapedR = 0;
    if (os === 4) {
      for (let p = 1; p <= 4; p++) {
        const t = p * 0.25;
        shapedL += shapeSample(prevL + (curL - prevL) * t, driveAmt, params.flavor, params.harmonics);
        shapedR += shapeSample(prevR + (curR - prevR) * t, driveAmt, params.flavor, params.harmonics);
      }
      shapedL *= 0.25;
      shapedR *= 0.25;
    } else if (os === 2) {
      const midL = 0.5 * (prevL + curL);
      const midR = 0.5 * (prevR + curR);
      shapedL = 0.5 * (shapeSample(midL, driveAmt, params.flavor, params.harmonics) + shapeSample(curL, driveAmt, params.flavor, params.harmonics));
      shapedR = 0.5 * (shapeSample(midR, driveAmt, params.flavor, params.harmonics) + shapeSample(curR, driveAmt, params.flavor, params.harmonics));
    } else {
      shapedL = shapeSample(curL, driveAmt, params.flavor, params.harmonics);
      shapedR = shapeSample(curR, driveAmt, params.flavor, params.harmonics);
    }

    const dcCleanL = shapedL - dcPrevInL + dcR * dcPrevOutL;
    dcPrevInL = shapedL;
    dcPrevOutL = dcCleanL;

    const dcCleanR = shapedR - dcPrevInR + dcR * dcPrevOutR;
    dcPrevInR = shapedR;
    dcPrevOutR = dcCleanR;

    left[i] = processBiquadSample(dcCleanL, toneTilt, tL);
    right[i] = processBiquadSample(dcCleanR, toneTilt, tR);

    prevL = curL;
    prevR = curR;
  }
}

function applyStereoImager(
  left: Float32Array,
  right: Float32Array,
  params: StereoImagerParams,
  sampleRate: number,
  intensityScale: number,
): void {
  if (intensityScale <= 1e-4) return;
  const n = left.length;
  const bwQ = Math.SQRT1_2;
  const lpLow = designLowPass(params.lowCrossHz, bwQ, sampleRate);
  const hpLow = designHighPass(params.lowCrossHz, bwQ, sampleRate);
  const lpHigh = designLowPass(params.highCrossHz, bwQ, sampleRate);
  const hpHigh = designHighPass(params.highCrossHz, bwQ, sampleRate);
  const apHigh = designAllPass(params.highCrossHz, bwQ, sampleRate);

  const monoSubHp = params.monoBassBelowHz > 15 ? designHighPass(params.monoBassBelowHz, bwQ, sampleRate) : null;
  const monoSubState = createBiquadState();

  const wLow = 1 + ((params.lowWidth / 100 - 1) * intensityScale);
  const wMid = 1 + ((params.midWidth / 100 - 1) * intensityScale);
  const wHigh = 1 + ((params.highWidth / 100 - 1) * intensityScale);
  const sideGainOffset = dbToLinear(params.midSideGainDb * intensityScale);
  const balL = params.lrBalanceDb < 0 ? 1 : dbToLinear(-params.lrBalanceDb * intensityScale);
  const balR = params.lrBalanceDb > 0 ? 1 : dbToLinear(params.lrBalanceDb * intensityScale);

  const s = Array.from({ length: 18 }, () => createBiquadState());

  for (let i = 0; i < n; i++) {
    const l = left[i] * balL;
    const r = right[i] * balR;

    const lLowRaw = processBiquadSample(processBiquadSample(l, lpLow, s[0]), lpLow, s[1]);
    const rLowRaw = processBiquadSample(processBiquadSample(r, lpLow, s[2]), lpLow, s[3]);
    const lLow = processBiquadSample(lLowRaw, apHigh, s[12]);
    const rLow = processBiquadSample(rLowRaw, apHigh, s[13]);

    const lRest = processBiquadSample(processBiquadSample(l, hpLow, s[4]), hpLow, s[5]);
    const rRest = processBiquadSample(processBiquadSample(r, hpLow, s[6]), hpLow, s[7]);

    const lMid = processBiquadSample(processBiquadSample(lRest, lpHigh, s[8]), lpHigh, s[9]);
    const rMid = processBiquadSample(processBiquadSample(rRest, lpHigh, s[10]), lpHigh, s[11]);

    const lHigh = processBiquadSample(processBiquadSample(lRest, hpHigh, s[14]), hpHigh, s[15]);
    const rHigh = processBiquadSample(processBiquadSample(rRest, hpHigh, s[16]), hpHigh, s[17]);

    const mLow = 0.5 * (lLow + rLow);
    const sLow = 0.5 * (lLow - rLow) * wLow;
    const mMid = 0.5 * (lMid + rMid);
    const sMid = 0.5 * (lMid - rMid) * wMid;
    const mHigh = 0.5 * (lHigh + rHigh);
    const sHigh = 0.5 * (lHigh - rHigh) * wHigh;

    const totalM = mLow + mMid + mHigh;
    const rawS = (sLow + sMid + sHigh) * sideGainOffset;
    let totalS = rawS;
    if (monoSubHp) {
      const hpS = processBiquadSample(rawS, monoSubHp, monoSubState);
      totalS = rawS * (1 - intensityScale) + hpS * intensityScale;
    }

    left[i] = totalM + totalS;
    right[i] = totalM - totalS;
  }
}

function applyRestore(
  left: Float32Array,
  right: Float32Array,
  params: RestoreParams,
  sampleRate: number,
  intensityScale: number,
): number {
  const n = left.length;
  let maxGr = 0;

  // 1. DC Offset removal
  if (params.dcOffset) {
    let meanL = 0;
    let meanR = 0;
    for (let i = 0; i < n; i++) {
      meanL += left[i];
      meanR += right[i];
    }
    meanL /= Math.max(1, n);
    meanR /= Math.max(1, n);
    for (let i = 0; i < n; i++) {
      left[i] -= meanL;
      right[i] -= meanR;
    }
  }

  // 2. Hum removal (50Hz or 60Hz + 2nd harmonic notch)
  if (params.humRemovalHz > 0) {
    const q = params.mode === 'aggressive' ? 5 : 9;
    const n1 = designNotch(params.humRemovalHz, q, sampleRate);
    const n2 = designNotch(params.humRemovalHz * 2, q, sampleRate);
    const s = Array.from({ length: 4 }, () => createBiquadState());
    for (let i = 0; i < n; i++) {
      left[i] = processBiquadSample(processBiquadSample(left[i], n1, s[0]), n2, s[1]);
      right[i] = processBiquadSample(processBiquadSample(right[i], n1, s[2]), n2, s[3]);
    }
  }

  // 3. De-Esser (dynamic high-mid band attenuation)
  const deEss = (params.deEssAmount / 100) * intensityScale;
  if (deEss > 0.01) {
    const bp = designBandPass(params.deEssFreqHz, 2.2, sampleRate);
    const bpL = createBiquadState();
    const bpR = createBiquadState();
    const eqL = createBiquadState();
    const eqR = createBiquadState();
    let env = 0;
    let cutDb = 0;
    let eqC = designPeakingEQ(params.deEssFreqHz, 0, 2.2, sampleRate);
    const threshDb = params.mode === 'aggressive' ? -28 : -22;

    for (let i = 0; i < n; i++) {
      const sib = Math.max(
        Math.abs(processBiquadSample(left[i], bp, bpL)),
        Math.abs(processBiquadSample(right[i], bp, bpR)),
      );
      env = sib > env ? env * 0.85 + sib * 0.15 : env * 0.992 + sib * 0.008;
      const eDb = linearToDb(env);
      const target = eDb > threshDb ? Math.max(-7 * deEss, -(eDb - threshDb) * deEss) : 0;
      cutDb = cutDb * 0.95 + target * 0.05;
      if (-cutDb > maxGr) maxGr = -cutDb;
      if ((i & 31) === 0) {
        eqC = designPeakingEQ(params.deEssFreqHz, cutDb, 2.2, sampleRate);
      }
      left[i] = processBiquadSample(left[i], eqC, eqL);
      right[i] = processBiquadSample(right[i], eqC, eqR);
    }
  }

  // 4. Adaptive Hiss Reduction (downward high-shelf noise gate above 6.5 kHz).
  // Fast detector attack opens the shelf for transient detail; slower release keeps
  // quiet-passage reduction stable instead of chopping ambience at the waveform rate.
  const hiss = (params.hissReduction / 100) * intensityScale;
  if (hiss > 0.01) {
    const hsL = createBiquadState();
    const hsR = createBiquadState();
    let rmsEnv = 0;
    let hsCut = 0;
    let hsCoeffs = designHighShelf(7000, 0, 0.7, sampleRate);
    const detectorAttack = Math.exp(-1 / Math.max(1, sampleRate * 0.001));
    const detectorRelease = Math.exp(-1 / Math.max(1, sampleRate * 0.08));
    const cutAttack = Math.exp(-1 / Math.max(1, sampleRate * 0.02));
    const cutRelease = Math.exp(-1 / Math.max(1, sampleRate * 0.005));
    for (let i = 0; i < n; i++) {
      const m = 0.5 * (Math.abs(left[i]) + Math.abs(right[i]));
      const detectorCoeff = m > rmsEnv ? detectorAttack : detectorRelease;
      rmsEnv = detectorCoeff * rmsEnv + (1 - detectorCoeff) * m;
      const lvlDb = linearToDb(rmsEnv);
      const target = lvlDb < -44 ? -6.5 * hiss : 0;
      const gainCoeff = target < hsCut ? cutAttack : cutRelease;
      hsCut = gainCoeff * hsCut + (1 - gainCoeff) * target;
      if ((i & 31) === 0) {
        hsCoeffs = designHighShelf(7000, hsCut, 0.7, sampleRate);
      }
      left[i] = processBiquadSample(left[i], hsCoeffs, hsL);
      right[i] = processBiquadSample(right[i], hsCoeffs, hsR);
    }
  }

  // 5. FFT-Guided Spectral Resonance Suppressor
  const resAmt = (params.resonanceSuppress / 100) * intensityScale;
  if (resAmt > 0.01 && n >= 1024) {
    const fftSize = 4096;
    const halfBins = fftSize >> 1;
    const win = createHannWindow(fftSize);
    const frame = new Float32Array(fftSize);
    const avgPow = new Float64Array(halfBins);
    const numFrames = Math.min(8, Math.max(1, Math.floor(n / fftSize)));
    const stride = Math.max(1, Math.floor((n - fftSize) / Math.max(1, numFrames)));

    for (let f = 0; f < numFrames; f++) {
      const offset = Math.min(Math.max(0, f * stride), Math.max(0, n - fftSize));
      const sliceLen = Math.min(fftSize, n - offset);
      frame.fill(0);
      for (let i = 0; i < sliceLen; i++) {
        frame[i] = 0.5 * (left[offset + i] + right[offset + i]);
      }
      const magDb = computeMagnitudeSpectrumDb(frame, fftSize, win);
      for (let b = 0; b < halfBins; b++) {
        avgPow[b] += Math.pow(10, magDb[b] / 10) / numFrames;
      }
    }

    const avgDb = new Float32Array(halfBins);
    for (let b = 0; b < halfBins; b++) {
      avgDb[b] = 10 * Math.log10(Math.max(avgPow[b], 1e-13));
    }

    const binHz = sampleRate / fftSize;
    const minBin = Math.max(6, Math.floor(120 / binHz));
    const maxBin = Math.min(halfBins - 6, Math.ceil(12000 / binHz));
    const peaks: Array<{ bin: number; freq: number; excess: number }> = [];

    for (let b = minBin; b <= maxBin; b++) {
      if (avgDb[b] < -65) continue;
      if (avgDb[b] < avgDb[b - 1] || avgDb[b] < avgDb[b + 1]) continue;
      const nbAvg =
        (avgDb[b - 5] + avgDb[b - 4] + avgDb[b - 3] + avgDb[b + 3] + avgDb[b + 4] + avgDb[b + 5]) / 6;
      const excess = avgDb[b] - nbAvg;
      if (excess > 4.0) {
        peaks.push({ bin: b, freq: b * binHz, excess });
      }
    }

    peaks.sort((a, b) => b.excess - a.excess);
    const chosen: Array<{ freq: number; cutDb: number }> = [];
    for (const pk of peaks) {
      if (chosen.some((c) => Math.abs(Math.log2(pk.freq / c.freq)) < 0.2)) continue;
      const maxDepth = params.mode === 'aggressive' ? 10.5 : 6.5;
      const cutDb = -Math.min(maxDepth * resAmt, (pk.excess - 2.5) * 0.75 * resAmt);
      if (cutDb < -0.4) {
        chosen.push({ freq: pk.freq, cutDb });
        if (-cutDb > maxGr) maxGr = -cutDb;
      }
      if (chosen.length >= 4) break;
    }

    if (chosen.length > 0) {
      const qVal = params.mode === 'aggressive' ? 5.5 : 7.5;
      const filters = chosen.map((c) => ({
        coeffs: designPeakingEQ(c.freq, c.cutDb, qVal, sampleRate),
        sL: createBiquadState(),
        sR: createBiquadState(),
      }));
      for (let i = 0; i < n; i++) {
        let l = left[i];
        let r = right[i];
        for (let k = 0; k < filters.length; k++) {
          l = processBiquadSample(l, filters[k].coeffs, filters[k].sL);
          r = processBiquadSample(r, filters[k].coeffs, filters[k].sR);
        }
        left[i] = l;
        right[i] = r;
      }
    }
  }

  return Number(maxGr.toFixed(2));
}

function applyBassEnhancer(
  left: Float32Array,
  right: Float32Array,
  params: BassEnhancerParams,
  sampleRate: number,
  intensityScale: number,
): void {
  const n = left.length;
  const subShelf = designPeakingEQ(params.subFreqHz, params.subGainDb * intensityScale, 0.9, sampleRate);
  const lpSub = designLowPass(120, 0.707, sampleRate);
  const hpHarm = designHighPass(70, 0.707, sampleRate);

  const sL = createBiquadState();
  const sR = createBiquadState();
  const lpL = createBiquadState();
  const lpR = createBiquadState();
  const hpL = createBiquadState();
  const hpR = createBiquadState();
  const monoLpL = createBiquadState();
  const monoLpR = createBiquadState();

  const harmAmt = (params.harmonicDrive / 100) * 0.25 * intensityScale;
  const monoTighten = 0.15 * (params.tightness / 100) * intensityScale;

  for (let i = 0; i < n; i++) {
    let l = processBiquadSample(left[i], subShelf, sL);
    let r = processBiquadSample(right[i], subShelf, sR);

    if (harmAmt > 0.002) {
      const subL = processBiquadSample(l, lpSub, lpL);
      const subR = processBiquadSample(r, lpSub, lpR);
      const hL = processBiquadSample(Math.tanh(subL * 3.0) - subL, hpHarm, hpL);
      const hR = processBiquadSample(Math.tanh(subR * 3.0) - subR, hpHarm, hpR);
      l += hL * harmAmt;
      r += hR * harmAmt;
    }

    if (params.monoFocus && monoTighten > 0) {
      // Split sub (<120Hz) vs highs so monoFocus ONLY narrows low-end, leaving 1k-10k stereo image untouched
      const lowL = processBiquadSample(l, lpSub, monoLpL);
      const lowR = processBiquadSample(r, lpSub, monoLpR);
      const hiL = l - lowL;
      const hiR = r - lowR;

      const subMid = 0.5 * (lowL + lowR);
      const subSide = 0.5 * (lowL - lowR) * (1 - monoTighten);
      l = subMid + subSide + hiL;
      r = subMid - subSide + hiR;
    }

    left[i] = l;
    right[i] = r;
  }
}

/** Samples the most recent limiter pass had to hard-clamp (diagnostic; should be ~0). */
export let lastLimiterClampCount = 0;

function applyLookaheadLimiter(
  left: Float32Array,
  right: Float32Array,
  ceilingDb: number,
  thresholdDb: number,
  releaseMs: number,
  lookaheadMs: number,
  sampleRate: number,
  intensityScale: number,
  truePeak = true,
  oversampling: 1 | 2 | 4 = 4,
): number {
  const n = left.length;
  if (n === 0) return 0;
  const ceilingLin = dbToLinear(ceilingDb);
  const driveDb = -thresholdDb * intensityScale;
  const driveLin = dbToLinear(driveDb);

  const lookSamples = Math.max(1, Math.min(512, Math.round((lookaheadMs / 1000) * sampleRate)));
  const relCoeff = Math.exp(-1 / Math.max(1, (releaseMs / 1000) * sampleRate));

  const drivenL = new Float32Array(n);
  const drivenR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    drivenL[i] = left[i] * driveLin;
    drivenR[i] = right[i] * driveLin;
  }

  // Precompute sample-by-sample True Peak envelope at requested oversampling (1x/2x/4x)
  const tpEnv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (truePeak && oversampling > 1 && i + 1 < n) {
      const tpL = maxInterSampleAbsAt(drivenL, i, n, oversampling);
      const tpR = maxInterSampleAbsAt(drivenR, i, n, oversampling);
      tpEnv[i] = Math.max(tpL, tpR);
    } else {
      tpEnv[i] = Math.max(Math.abs(drivenL[i]), Math.abs(drivenR[i]));
    }
  }

  // 1. Required gain per sample so that sample's (true) peak lands on the ceiling.
  const required = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const pk = tpEnv[i];
    required[i] = pk > ceilingLin ? ceilingLin / pk : 1.0;
  }

  // 2. Lookahead hold: minimum required gain over [i, i + L - 1] (monotonic deque, O(n)).
  const L = lookSamples;
  const held = new Float64Array(n);
  const dq = new Int32Array(n + L);
  let head = 0;
  let tail = 0;
  for (let j = 0; j < n + L - 1; j++) {
    if (j < n) {
      while (tail > head && required[dq[tail - 1]] >= required[j]) tail--;
      dq[tail++] = j;
    }
    const i = j - L + 1;
    if (i >= 0 && i < n) {
      while (dq[head] < i) head++;
      held[i] = required[dq[head]];
    }
  }

  // 3. Attack ramp: average the held gain over the previous L samples. Because every
  // held value in [p - L + 1, p] is <= required[p], the ramp reaches the needed
  // reduction exactly when the peak arrives, with no instantaneous gain step.
  // 4. Release: recover smoothly toward the ramped target; never rise above it.
  let runSum = 0;
  let gain = 1.0;
  let maxGr = 0;
  let clampCount = 0;
  for (let i = 0; i < n; i++) {
    runSum += held[i];
    if (i >= L) runSum -= held[i - L];
    const count = Math.min(i + 1, L);
    // Before the first L samples, pad the window with held[0] (the minimum required gain
    // over the opening lookahead), so the opening peak is never under-limited.
    const attackGain = (runSum + (L - count) * held[0]) / L;
    const target = attackGain;
    gain = target < gain ? target : Math.min(target, gain * relCoeff + target * (1 - relCoeff));

    const grDb = -linearToDb(Math.max(gain, 1e-6));
    if (grDb > maxGr) maxGr = grDb;

    const outL = drivenL[i] * gain;
    const outR = drivenR[i] * gain;
    // Final safety clamp only; with the ramp above it should almost never engage.
    if (Math.abs(outL) > ceilingLin * 1.000001 || Math.abs(outR) > ceilingLin * 1.000001) clampCount++;
    left[i] = Math.max(-ceilingLin, Math.min(ceilingLin, outL));
    right[i] = Math.max(-ceilingLin, Math.min(ceilingLin, outR));
  }
  lastLimiterClampCount = clampCount;

  return Number(maxGr.toFixed(2));
}

function applyMaximizer(
  left: Float32Array,
  right: Float32Array,
  params: MaximizerParams,
  sampleRate: number,
  intensityScale: number,
): number {
  if (left.length === 0 || intensityScale <= 1e-4) return 0;

  // Measure real ITU-R BS.1770-4 K-weighted integrated LUFS instead of flat RMS
  const currentLufs = measureIntegratedLufs([left, right], sampleRate);
  if (currentLufs <= -69) return 0;

  // Apply transient emphasis (fast-vs-slow crest envelope shaping) prior to limiting
  const transRatio = Math.max(0, Math.min(1, params.transientEmphasis / 100)) * intensityScale;
  if (transRatio > 0.005) {
    const fastCoeff = Math.exp(-1 / Math.max(1, (0.8 / 1000) * sampleRate));
    const slowCoeff = Math.exp(-1 / Math.max(1, (28 / 1000) * sampleRate));
    let fastEnv = 0;
    let slowEnv = 0;
    for (let i = 0; i < left.length; i++) {
      const peak = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      fastEnv = fastCoeff * fastEnv + (1 - fastCoeff) * peak;
      slowEnv = slowCoeff * slowEnv + (1 - slowCoeff) * peak;
      const transientDelta = Math.max(0, fastEnv - slowEnv * 1.15);
      const boost = 1 + Math.min(0.45, transientDelta * 3.5 * transRatio);
      left[i] *= boost;
      right[i] *= boost;
    }
  }

  const targetLufs = params.targetLufs;
  const postTransientLufs = transRatio > 0.005 ? measureIntegratedLufs([left, right], sampleRate) : currentLufs;
  // Apply positive gain when below target AND attenuation when already above target.
  // The previous zero floor made the maximizer unable to hit a lower LUFS target.
  const neededGainDb = Math.max(-24, Math.min(24, targetLufs - postTransientLufs)) * intensityScale;

  const baseReleaseMs =
    params.character === 'aggressive'
      ? 45
      : params.character === 'punchy'
        ? 75
        : params.character === 'smooth'
          ? 160
          : 110;
  // Faster release preserves transient punch between peaks as transientEmphasis rises
  const releaseMs = Math.max(25, baseReleaseMs * (1 - 0.35 * transRatio));

  let gr = applyLookaheadLimiter(
    left,
    right,
    params.ceilingDb,
    -neededGainDb,
    releaseMs,
    4.0,
    sampleRate,
    1.0,
    params.truePeak,
    4,
  );

  // One adaptive correction pass compensates for gain reduction at the ceiling.
  // Keep the correction signed so an overshoot can be attenuated as well as boosted.
  {
    const postLufs = measureIntegratedLufs([left, right], sampleRate);
    const err = targetLufs - postLufs;
    if (Math.abs(err) > 0.35 && Math.abs(err) < 6.0) {
      const trimGr = applyLookaheadLimiter(
        left,
        right,
        params.ceilingDb,
        -err * intensityScale,
        releaseMs,
        4.0,
        sampleRate,
        1.0,
        params.truePeak,
        4,
      );
      gr = Math.max(gr, trimGr);
    }
  }

  return gr;
}

/**
 * Process stereo/mono Float32Array buffers through the entire SYN-CHAIN
 * without mutating the source buffers.
 */
export function processChainOffline(
  sourceChannels: Float32Array[],
  sampleRate: number,
  chain: ProcessorModule[],
): OfflineDspResult {
  const numCh = sourceChannels.length;
  const length = sourceChannels[0].length;
  const left = new Float32Array(sourceChannels[0]);
  const right = new Float32Array(numCh > 1 ? sourceChannels[1] : sourceChannels[0]);

  const telemetry: ProcessorMeterTelemetry[] = [];

  for (const mod of chain) {
    const inputPeakDb = measurePeakDb(left, right);
    if (!mod.enabled || mod.bypassed) {
      telemetry.push({ id: mod.id, inputPeakDb, outputPeakDb: inputPeakDb, gainReductionDb: 0 });
      continue;
    }

    const dryL = mod.wetDry < 99.5 ? new Float32Array(left) : null;
    const dryR = mod.wetDry < 99.5 ? new Float32Array(right) : null;

    // Input gain stage
    const inGain = dbToLinear(mod.inputGainDb);
    if (Math.abs(mod.inputGainDb) > 0.01) {
      for (let i = 0; i < length; i++) {
        left[i] *= inGain;
        right[i] *= inGain;
      }
    }

    const intensityScale = Math.max(0, Math.min(1, mod.intensity / 100));
    let grDb = 0;

    switch (mod.type) {
      case 'parametric-eq':
        applyParametricEQ(left, right, mod.params as ParametricEQParams, sampleRate, intensityScale);
        break;
      case 'dynamic-eq':
        grDb = applyDynamicEQ(left, right, mod.params as DynamicEQParams, sampleRate, intensityScale);
        break;
      case 'compressor':
        grDb = applyCompressor(left, right, mod.params as CompressorParams, sampleRate, intensityScale);
        break;
      case 'multiband-comp':
        grDb = applyMultibandCompressor(left, right, mod.params as MultibandCompParams, sampleRate, intensityScale);
        break;
      case 'saturation':
        applySaturation(left, right, mod.params as SaturationParams, sampleRate, intensityScale);
        break;
      case 'stereo-imager':
        applyStereoImager(left, right, mod.params as StereoImagerParams, sampleRate, intensityScale);
        break;
      case 'restore':
        grDb = applyRestore(left, right, mod.params as RestoreParams, sampleRate, intensityScale);
        break;
      case 'bass-enhancer':
        applyBassEnhancer(left, right, mod.params as BassEnhancerParams, sampleRate, intensityScale);
        break;
      case 'limiter': {
        const lp = mod.params as LimiterParams;
        grDb = applyLookaheadLimiter(
          left,
          right,
          lp.ceilingDb,
          lp.thresholdDb,
          lp.releaseMs,
          lp.lookaheadMs,
          sampleRate,
          intensityScale,
          lp.truePeak,
          lp.oversampling,
        );
        break;
      }
      case 'maximizer':
        grDb = applyMaximizer(left, right, mod.params as MaximizerParams, sampleRate, intensityScale);
        break;
    }

    // Wet/Dry parallel blend
    if (dryL && dryR) {
      const wet = Math.max(0, Math.min(1, mod.wetDry / 100));
      const dry = 1 - wet;
      for (let i = 0; i < length; i++) {
        left[i] = dryL[i] * dry + left[i] * wet;
        right[i] = dryR[i] * dry + right[i] * wet;
      }
    }

    // Output gain stage
    const outGain = dbToLinear(mod.outputGainDb);
    if (Math.abs(mod.outputGainDb) > 0.01) {
      for (let i = 0; i < length; i++) {
        left[i] *= outGain;
        right[i] *= outGain;
      }
    }

    const outputPeakDb = measurePeakDb(left, right);
    telemetry.push({
      id: mod.id,
      inputPeakDb,
      outputPeakDb,
      gainReductionDb: grDb,
    });
  }

  return {
    channels: numCh > 1 ? [left, right] : [left],
    telemetry,
  };
}
