export const DEMUCS_SAMPLE_RATE = 44_100;
export const DEMUCS_SEGMENT_SAMPLES = 343_980;
export const DEMUCS_OVERLAP_SAMPLES = Math.floor(DEMUCS_SEGMENT_SAMPLES / 4);
export const DEMUCS_STRIDE_SAMPLES = DEMUCS_SEGMENT_SAMPLES - DEMUCS_OVERLAP_SAMPLES;

export const DEMUCS_STEM_ROWS = [
  { id: 'drums', label: 'Drums', role: 'drums' },
  { id: 'bass', label: 'Bass', role: 'bass' },
  { id: 'other', label: 'Other', role: 'other' },
  { id: 'vocals', label: 'Vocals', role: 'vocals' },
] as const;

export function getDemucsChunkCount(totalSamples: number): number {
  if (!Number.isSafeInteger(totalSamples) || totalSamples < 1) {
    throw new RangeError('Audio must contain at least one sample.');
  }
  return Math.max(1, Math.ceil(Math.max(0, totalSamples - DEMUCS_SEGMENT_SAMPLES) / DEMUCS_STRIDE_SAMPLES) + 1);
}

export function createDemucsChunkWindow(
  segmentSamples: number,
  overlapSamples: number,
  fadeIn: boolean,
  fadeOut: boolean,
): Float32Array {
  if (!Number.isSafeInteger(segmentSamples) || segmentSamples < 2) {
    throw new RangeError('Segment length must be at least two samples.');
  }
  if (!Number.isSafeInteger(overlapSamples) || overlapSamples < 1 || overlapSamples * 2 > segmentSamples) {
    throw new RangeError('Overlap must be positive and no more than half the segment.');
  }

  const window = new Float32Array(segmentSamples);
  window.fill(1);
  if (fadeIn) {
    for (let i = 0; i < overlapSamples; i += 1) window[i] = i / overlapSamples;
  }
  if (fadeOut) {
    const start = segmentSamples - overlapSamples;
    for (let i = 0; i < overlapSamples; i += 1) window[start + i] = 1 - i / overlapSamples;
  }
  return window;
}

export function accumulateDemucsChunk(
  output: Float32Array,
  chunk: Float32Array,
  destinationStart: number,
  validSamples: number,
  window: Float32Array,
): void {
  if (chunk.length !== window.length) throw new RangeError('Chunk and window buffers must have equal lengths.');
  if (!Number.isSafeInteger(destinationStart) || destinationStart < 0 ||
      !Number.isSafeInteger(validSamples) || validSamples < 0 ||
      validSamples > chunk.length || destinationStart + validSamples > output.length) {
    throw new RangeError('Chunk destination is outside the output buffer.');
  }
  for (let i = 0; i < validSamples; i += 1) {
    output[destinationStart + i] += chunk[i] * window[i];
  }
}

export function accumulateDemucsWeights(
  weights: Float32Array,
  destinationStart: number,
  validSamples: number,
  window: Float32Array,
): void {
  if (!Number.isSafeInteger(destinationStart) || destinationStart < 0 ||
      !Number.isSafeInteger(validSamples) || validSamples < 0 ||
      validSamples > window.length || destinationStart + validSamples > weights.length) {
    throw new RangeError('Chunk weight destination is outside the output buffer.');
  }
  for (let i = 0; i < validSamples; i += 1) {
    weights[destinationStart + i] += window[i];
  }
}

export function normalizeDemucsOutput(output: Float32Array, weights: Float32Array): void {
  if (output.length !== weights.length) throw new RangeError('Output and weight buffers must have equal lengths.');
  for (let i = 0; i < output.length; i += 1) {
    output[i] = weights[i] > 1e-8 ? output[i] / weights[i] : 0;
  }
}

/** Normalize only the finalized prefix of a disk-streamed overlap-add buffer. */
export function normalizeDemucsRange(output: Float32Array, weights: Float32Array, count: number): Float32Array {
  if (output.length !== weights.length) throw new RangeError('Output and weight buffers must have equal lengths.');
  if (!Number.isSafeInteger(count) || count < 0 || count > output.length) {
    throw new RangeError('Finalized range is outside the accumulation buffer.');
  }
  const normalized = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    normalized[i] = weights[i] > 1e-8 ? output[i] / weights[i] : 0;
  }
  return normalized;
}

/** Retain only the unfinalized overlap tail after a prefix has been written to temporary storage. */
export function shiftDemucsAccumulator(outputs: Float32Array[], weights: Float32Array, finalizedSamples: number): void {
  if (!Number.isSafeInteger(finalizedSamples) || finalizedSamples < 0 || finalizedSamples > weights.length ||
      outputs.some((output) => output.length !== weights.length)) {
    throw new RangeError('Finalized overlap range is incompatible with the accumulator buffers.');
  }
  for (const output of outputs) {
    output.copyWithin(0, finalizedSamples);
    output.fill(0, output.length - finalizedSamples);
  }
  weights.copyWithin(0, finalizedSamples);
  weights.fill(0, weights.length - finalizedSamples);
}

/** Time offset used for the second ("shifted") inference in High Quality mode. */
export const DEMUCS_SHIFT_SAMPLES = 22_050; // 0.5 s at 44.1 kHz, Demucs' maximum shift

/** Build the input for the shifted pass: the chunk delayed by `shift` samples, zero-filled at the start. */
export function buildShiftedDemucsInput(input: Float32Array, segmentSamples: number, shift: number): Float32Array {
  if (input.length !== 2 * segmentSamples) throw new RangeError('Input must hold two planar channels of one segment.');
  if (!Number.isSafeInteger(shift) || shift < 1 || shift >= segmentSamples) throw new RangeError('Shift must be inside the segment.');
  const shifted = new Float32Array(input.length);
  for (let c = 0; c < 2; c += 1) {
    const base = c * segmentSamples;
    shifted.set(input.subarray(base, base + segmentSamples - shift), base + shift);
  }
  return shifted;
}

/**
 * Average the plain and shifted model outputs (test-time shift augmentation, as in the
 * Demucs reference `--shifts`). `shiftedOutput` was produced from input delayed by `shift`,
 * so its sample j + shift estimates original sample j. Samples the shifted pass cannot
 * cover keep the plain estimate. Layout: [stems][2 channels][segmentSamples], planar.
 */
export function averageShiftedDemucsOutput(
  plainOutput: Float32Array,
  shiftedOutput: Float32Array,
  stemCount: number,
  segmentSamples: number,
  shift: number,
): Float32Array {
  const expected = stemCount * 2 * segmentSamples;
  if (plainOutput.length !== expected || shiftedOutput.length !== expected) {
    throw new RangeError('Model outputs do not match the expected [stems, 2, segment] layout.');
  }
  const out = new Float32Array(plainOutput);
  const covered = segmentSamples - shift;
  for (let row = 0; row < stemCount * 2; row += 1) {
    const base = row * segmentSamples;
    for (let i = 0; i < covered; i += 1) {
      out[base + i] = 0.5 * (plainOutput[base + i] + shiftedOutput[base + i + shift]);
    }
  }
  return out;
}

export interface MixtureConsistencyReport {
  /** Energy of (mix - sum of stems) relative to the mix, before correction, in dB. */
  residualDbBefore: number;
  /** Same measurement after correction (should be at float precision). */
  residualDbAfter: number;
}

/**
 * Mixture consistency: make the stems sum back to the original mix exactly.
 * The separation model, the 44.1 kHz round trip and the model's band limit leave a small
 * residual (including any content above ~20 kHz). That residual is shared out to the stems
 * in proportion to each stem's local energy, with weights interpolated between frames so
 * no frame edge steps are introduced. Stems are modified in place.
 */
export function applyMixtureConsistency(
  mix: [Float32Array, Float32Array],
  stems: Array<[Float32Array, Float32Array]>,
  frameSize = 2048,
): MixtureConsistencyReport {
  if (stems.length === 0) throw new RangeError('At least one stem is required.');
  const length = mix[0].length;
  if (mix[1].length !== length || stems.some((s) => s[0].length !== length || s[1].length !== length)) {
    throw new RangeError('Mix and stems must share one length.');
  }
  if (!Number.isSafeInteger(frameSize) || frameSize < 16) throw new RangeError('Frame size must be at least 16 samples.');
  const k = stems.length;
  const frames = Math.max(1, Math.ceil(length / frameSize));
  let mixEnergy = 0;
  let residualBefore = 0;
  let residualAfter = 0;

  for (let c = 0; c < 2; c += 1) {
    const m = mix[c];
    // Per-frame energy share of each stem.
    const weights = new Float64Array(frames * k);
    for (let f = 0; f < frames; f += 1) {
      const start = f * frameSize;
      const end = Math.min(length, start + frameSize);
      let total = 0;
      for (let s = 0; s < k; s += 1) {
        const x = stems[s][c];
        let e = 0;
        for (let i = start; i < end; i += 1) e += x[i] * x[i];
        weights[f * k + s] = e;
        total += e;
      }
      for (let s = 0; s < k; s += 1) {
        weights[f * k + s] = total > 1e-20 ? weights[f * k + s] / total : 1 / k;
      }
    }
    for (let i = 0; i < length; i += 1) {
      let sum = 0;
      for (let s = 0; s < k; s += 1) sum += stems[s][c][i];
      const residual = m[i] - sum;
      mixEnergy += m[i] * m[i];
      residualBefore += residual * residual;
      // Linear interpolation of weights between frame centres.
      const pos = (i + 0.5) / frameSize - 0.5;
      const f0 = Math.max(0, Math.min(frames - 1, Math.floor(pos)));
      const f1 = Math.min(frames - 1, f0 + 1);
      const t = Math.max(0, Math.min(1, pos - f0));
      for (let s = 0; s < k; s += 1) {
        const w = weights[f0 * k + s] * (1 - t) + weights[f1 * k + s] * t;
        stems[s][c][i] += residual * w;
      }
      let after = m[i];
      for (let s = 0; s < k; s += 1) after -= stems[s][c][i];
      residualAfter += after * after;
    }
  }
  const toDb = (e: number) => (mixEnergy > 0 && e > 0 ? 10 * Math.log10(e / mixEnergy) : -Infinity);
  return { residualDbBefore: toDb(residualBefore), residualDbAfter: toDb(residualAfter) };
}
