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
