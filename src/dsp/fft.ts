/**
 * Pure TypeScript Radix-2 Cooley-Tukey FFT & Hann Windowing
 */

export function createHannWindow(size: number): Float32Array {
  const win = new Float32Array(size);
  const denom = size - 1;
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom));
  }
  return win;
}

export function createBlackmanHarrisWindow(size: number): Float32Array {
  const win = new Float32Array(size);
  const a0 = 0.35875;
  const a1 = 0.48829;
  const a2 = 0.14128;
  const a3 = 0.01168;
  const N = size - 1;
  for (let i = 0; i < size; i++) {
    const t = (2 * Math.PI * i) / N;
    win[i] = a0 - a1 * Math.cos(t) + a2 * Math.cos(2 * t) - a3 * Math.cos(3 * t);
  }
  return win;
}

export function fftInPlace(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  if (n === 0 || (n & (n - 1)) !== 0) {
    throw new Error(`FFT size must be a power of 2, received ${n}`);
  }

  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  // Cooley-Tukey decimation-in-time butterflies
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const step = (-2 * Math.PI) / size;
    const wStepR = Math.cos(step);
    const wStepI = Math.sin(step);

    for (let start = 0; start < n; start += size) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < halfSize; k++) {
        const evenIdx = start + k;
        const oddIdx = evenIdx + halfSize;

        const or = real[oddIdx];
        const oi = imag[oddIdx];
        const tr = wr * or - wi * oi;
        const ti = wr * oi + wi * or;

        real[oddIdx] = real[evenIdx] - tr;
        imag[oddIdx] = imag[evenIdx] - ti;
        real[evenIdx] += tr;
        imag[evenIdx] += ti;

        const nextWr = wr * wStepR - wi * wStepI;
        wi = wr * wStepI + wi * wStepR;
        wr = nextWr;
      }
    }
  }
}

export function ifftInPlace(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  for (let i = 0; i < n; i++) {
    imag[i] = -imag[i];
  }
  fftInPlace(real, imag);
  const invN = 1 / n;
  for (let i = 0; i < n; i++) {
    real[i] *= invN;
    imag[i] = -imag[i] * invN;
  }
}

export function computeMagnitudeSpectrumDb(
  samples: Float32Array,
  fftSize: number,
  windowFn?: Float32Array,
): Float32Array {
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  const win = windowFn ?? createHannWindow(fftSize);
  const len = Math.min(samples.length, fftSize);

  let winSum = 0;
  for (let i = 0; i < fftSize; i++) {
    winSum += win[i];
    if (i < len) {
      real[i] = samples[i] * win[i];
    }
  }

  fftInPlace(real, imag);

  const bins = fftSize >> 1;
  const magDb = new Float32Array(bins);
  const scale = 2 / Math.max(winSum, 1e-12);

  for (let i = 0; i < bins; i++) {
    const re = real[i];
    const im = imag[i];
    const mag = Math.sqrt(re * re + im * im) * scale;
    magDb[i] = 20 * Math.log10(Math.max(mag, 1e-7));
  }

  return magDb;
}
