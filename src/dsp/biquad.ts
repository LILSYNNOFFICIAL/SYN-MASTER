/**
 * Robert Bristow-Johnson (RBJ) Audio EQ Cookbook Biquad Filters
 * Direct Form II Transposed for numerical stability
 */

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface BiquadState {
  z1: number;
  z2: number;
}

export function createBiquadState(): BiquadState {
  return { z1: 0, z2: 0 };
}

export function designLowPass(freq: number, q: number, sampleRate: number): BiquadCoeffs {
  const f = Math.max(10, Math.min(freq, sampleRate * 0.49));
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cosw) / 2) / a0,
    b1: (1 - cosw) / a0,
    b2: ((1 - cosw) / 2) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function designHighPass(freq: number, q: number, sampleRate: number): BiquadCoeffs {
  const f = Math.max(10, Math.min(freq, sampleRate * 0.49));
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cosw) / 2) / a0,
    b1: -(1 + cosw) / a0,
    b2: ((1 + cosw) / 2) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function designBandPass(freq: number, q: number, sampleRate: number): BiquadCoeffs {
  const f = Math.max(10, Math.min(freq, sampleRate * 0.49));
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function designNotch(freq: number, q: number, sampleRate: number): BiquadCoeffs {
  const f = Math.max(10, Math.min(freq, sampleRate * 0.49));
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));
  const a0 = 1 + alpha;
  return {
    b0: 1 / a0,
    b1: (-2 * cosw) / a0,
    b2: 1 / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function designAllPass(freq: number, q: number, sampleRate: number): BiquadCoeffs {
  const f = Math.max(10, Math.min(freq, sampleRate * 0.49));
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));
  const a0 = 1 + alpha;
  return {
    b0: (1 - alpha) / a0,
    b1: (-2 * cosw) / a0,
    b2: (1 + alpha) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function designPeakingEQ(
  freq: number,
  gainDb: number,
  q: number,
  sampleRate: number,
): BiquadCoeffs {
  if (Math.abs(gainDb) < 1e-4) {
    return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  }
  const f = Math.max(10, Math.min(freq, sampleRate * 0.49));
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cosw) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

export function designLowShelf(
  freq: number,
  gainDb: number,
  q: number,
  sampleRate: number,
): BiquadCoeffs {
  if (Math.abs(gainDb) < 1e-4) {
    return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  }
  const f = Math.max(10, Math.min(freq, sampleRate * 0.49));
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const slope = Math.max(0.2, Math.min(2.0, q));
  const alpha = (sinw / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 + (A - 1) * cosw + twoSqrtAAlpha;
  return {
    b0: (A * (A + 1 - (A - 1) * cosw + twoSqrtAAlpha)) / a0,
    b1: (2 * A * (A - 1 - (A + 1) * cosw)) / a0,
    b2: (A * (A + 1 - (A - 1) * cosw - twoSqrtAAlpha)) / a0,
    a1: (-2 * (A - 1 + (A + 1) * cosw)) / a0,
    a2: (A + 1 + (A - 1) * cosw - twoSqrtAAlpha) / a0,
  };
}

export function designHighShelf(
  freq: number,
  gainDb: number,
  q: number,
  sampleRate: number,
): BiquadCoeffs {
  if (Math.abs(gainDb) < 1e-4) {
    return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  }
  const f = Math.max(10, Math.min(freq, sampleRate * 0.49));
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const slope = Math.max(0.2, Math.min(2.0, q));
  const alpha = (sinw / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 - (A - 1) * cosw + twoSqrtAAlpha;
  return {
    b0: (A * (A + 1 + (A - 1) * cosw + twoSqrtAAlpha)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * cosw)) / a0,
    b2: (A * (A + 1 + (A - 1) * cosw - twoSqrtAAlpha)) / a0,
    a1: (2 * (A - 1 - (A + 1) * cosw)) / a0,
    a2: (A + 1 - (A - 1) * cosw - twoSqrtAAlpha) / a0,
  };
}

export function processBiquadSample(
  x: number,
  c: BiquadCoeffs,
  s: BiquadState,
): number {
  const y = c.b0 * x + s.z1;
  s.z1 = c.b1 * x - c.a1 * y + s.z2;
  s.z2 = c.b2 * x - c.a2 * y;
  return y;
}

export function processBiquadBuffer(
  input: Float32Array,
  output: Float32Array,
  coeffs: BiquadCoeffs,
): void {
  let z1 = 0;
  let z2 = 0;
  const { b0, b1, b2, a1, a2 } = coeffs;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    output[i] = y;
  }
}

export function evaluateBiquadMagnitudeDb(
  coeffs: BiquadCoeffs,
  freq: number,
  sampleRate: number,
): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const cosw = Math.cos(w);
  const cos2w = Math.cos(2 * w);
  const sinw = Math.sin(w);
  const sin2w = Math.sin(2 * w);

  const numR = coeffs.b0 + coeffs.b1 * cosw + coeffs.b2 * cos2w;
  const numI = -(coeffs.b1 * sinw + coeffs.b2 * sin2w);
  const denR = 1 + coeffs.a1 * cosw + coeffs.a2 * cos2w;
  const denI = -(coeffs.a1 * sinw + coeffs.a2 * sin2w);

  const numMag2 = numR * numR + numI * numI;
  const denMag2 = Math.max(1e-18, denR * denR + denI * denI);
  const mag = Math.sqrt(numMag2 / denMag2);
  return 20 * Math.log10(Math.max(mag, 1e-6));
}
