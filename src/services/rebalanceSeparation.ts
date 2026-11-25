/**
 * Vocal Rebalance stem pipeline (browser only, loaded on demand so it stays out of the
 * initial bundle). Reuses the Stem Studio HT-Demucs worker: source -> 44.1 kHz -> Demucs ->
 * back to the session rate -> length-aligned -> mixture consistency over all four stems
 * (so vocals + bass + drums + other == source, including content above the model's band).
 * Only vocals, bass and drums are kept for the rebalance.
 */
import { applyMixtureConsistency } from '../dsp/stemSeparationMath.ts';
import { fingerprintStereo, type RebalanceStemSet } from '../dsp/vocalRebalance.ts';
import { resampleStereoChannels, separateWithDemucs, type StemSeparationProgress } from './stemSeparation.ts';

export interface RebalanceSeparationProgress {
  stage: 'preparing' | StemSeparationProgress['stage'] | 'aligning';
  /** Overall 0..1 across every stage. */
  overall: number;
  completedChunks?: number;
  totalChunks?: number;
  executionProvider?: string;
}

const MODEL_RATE = 44_100;

function fit(channel: Float32Array, length: number): Float32Array {
  if (channel.length === length) return channel;
  if (channel.length > length) return channel.slice(0, length);
  const out = new Float32Array(length);
  out.set(channel);
  return out;
}

/** Overall progress for a Demucs stage update (model load 0-10 %, separation 10-85 %, resampling 85-97 %). */
export function overallSeparationProgress(update: StemSeparationProgress): number {
  const p = Math.max(0, Math.min(1, update.progress));
  switch (update.stage) {
    case 'loading-model': return 0.1 * p;
    case 'initializing': return 0.1;
    case 'separating': return 0.1 + 0.75 * p;
    case 'resampling': return 0.85 + 0.12 * p;
  }
}

export async function separateForRebalance(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  signal: AbortSignal,
  onProgress: (progress: RebalanceSeparationProgress) => void,
  options: { highQuality?: boolean } = {},
): Promise<RebalanceStemSet> {
  const length = left.length;
  const fingerprint = fingerprintStereo(left, right, sampleRate);
  const abortIfNeeded = () => {
    if (signal.aborted) throw new DOMException('Separation cancelled.', 'AbortError');
  };
  onProgress({ stage: 'preparing', overall: 0 });
  // Copies: the Demucs worker takes ownership of what it is given.
  const atModelRate = await resampleStereoChannels([left.slice(), right.slice()], sampleRate, MODEL_RATE);
  abortIfNeeded();
  const separated = await separateWithDemucs(
    atModelRate,
    signal,
    (update) => onProgress({ ...update, overall: overallSeparationProgress(update) }),
    { highQuality: options.highQuality === true },
  );
  abortIfNeeded();

  const byId = new Map<string, [Float32Array, Float32Array]>();
  for (let i = 0; i < separated.length; i++) {
    const stem = separated[i];
    const back = await resampleStereoChannels(stem.channels, MODEL_RATE, sampleRate);
    abortIfNeeded();
    byId.set(stem.id, [fit(back[0], length), fit(back[1], length)]);
    stem.channels = [new Float32Array(0), new Float32Array(0)];
    onProgress({
      stage: 'resampling',
      overall: overallSeparationProgress({ stage: 'resampling', progress: (i + 1) / separated.length }),
      completedChunks: i + 1,
      totalChunks: separated.length,
    });
  }
  const vocals = byId.get('vocals');
  const bass = byId.get('bass');
  const drums = byId.get('drums');
  const other = byId.get('other');
  if (!vocals || !bass || !drums || !other) throw new Error('Stem separation did not return vocals, bass, drums and other.');

  onProgress({ stage: 'aligning', overall: 0.98 });
  applyMixtureConsistency([left, right], [vocals, bass, drums, other]);
  onProgress({ stage: 'aligning', overall: 1 });
  return { fingerprint, sampleRate, length, stems: { vocals, bass, drums } };
}
