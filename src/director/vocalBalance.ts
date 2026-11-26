import { analyzeAudioBuffer } from '../dsp/analyzer';
import type { SeparatedAudioStem, StemSeparationProgress } from '../services/stemSeparation';
import { DEMUCS_SAMPLE_RATE } from '../dsp/stemSeparationMath';
import type { MasteringObjectiveId, VocalBalanceVerification } from '../types/mastering';
import { isAnalysisMeasurementReliable } from './analyzeIntelligence';

export interface VocalBalanceMeasurement {
  vocalLufs: number;
  nonVocalLufs: number;
  balanceDb: number;
}

export interface SeparatedVocalMaterial {
  vocalChannels: [Float32Array, Float32Array];
  nonVocalChannels: [Float32Array, Float32Array];
  measurement: VocalBalanceMeasurement;
}

export interface VocalBalanceTrackInput {
  channels: Float32Array[];
  sampleRate: number;
  durationSec: number;
  fileSizeBytes: number;
}

export interface VocalBalancePreparation {
  channels: [Float32Array, Float32Array] | null;
  verification: VocalBalanceVerification;
}

export function requiresVocalBalancePreparation(objectiveId: MasteringObjectiveId): boolean {
  return objectiveId === 'vocal-focused';
}

export function getOrCreateVocalBalancePreparation(
  cache: Map<string, Promise<VocalBalancePreparation>>,
  key: string,
  create: () => Promise<VocalBalancePreparation>,
): Promise<VocalBalancePreparation> {
  const cached = cache.get(key);
  if (cached) return cached;
  const preparation = create();
  cache.set(key, preparation);
  return preparation;
}

export function measureVocalBalance(
  vocalChannels: [Float32Array, Float32Array],
  nonVocalChannels: [Float32Array, Float32Array],
  sampleRate: number,
): VocalBalanceMeasurement | null {
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 384000 ||
    vocalChannels[0].length === 0 ||
    vocalChannels[0].length !== vocalChannels[1].length ||
    nonVocalChannels[0].length !== vocalChannels[0].length ||
    nonVocalChannels[1].length !== vocalChannels[0].length
  ) {
    return null;
  }
  const vocalAnalysis = analyzeAudioBuffer(vocalChannels, sampleRate);
  const nonVocalAnalysis = analyzeAudioBuffer(nonVocalChannels, sampleRate);
  if (!isAnalysisMeasurementReliable(vocalAnalysis) || !isAnalysisMeasurementReliable(nonVocalAnalysis)) {
    return null;
  }
  const balanceDb = vocalAnalysis.integratedLufs - nonVocalAnalysis.integratedLufs;
  return Number.isFinite(balanceDb)
    ? {
        vocalLufs: vocalAnalysis.integratedLufs,
        nonVocalLufs: nonVocalAnalysis.integratedLufs,
        balanceDb,
      }
    : null;
}

export function collapseSeparatedVocalStems(
  stems: readonly SeparatedAudioStem[],
  sampleRate: number,
): SeparatedVocalMaterial | null {
  const vocal = stems.find((stem) => stem.id === 'vocals');
  const accompaniment = stems.filter((stem) => stem.id !== 'vocals');
  if (!vocal || accompaniment.length === 0 || !Number.isFinite(sampleRate) || sampleRate < 8000) {
    return null;
  }
  const length = vocal.channels[0]?.length ?? 0;
  if (
    length === 0 ||
    vocal.channels[1]?.length !== length ||
    accompaniment.some((stem) =>
      stem.channels[0]?.length !== length ||
      stem.channels[1]?.length !== length,
    )
  ) {
    return null;
  }

  const nonVocalChannels: [Float32Array, Float32Array] = [
    new Float32Array(length),
    new Float32Array(length),
  ];
  for (const stem of accompaniment) {
    for (let i = 0; i < length; i++) {
      nonVocalChannels[0][i] += stem.channels[0][i];
      nonVocalChannels[1][i] += stem.channels[1][i];
    }
  }
  const vocalChannels: [Float32Array, Float32Array] = vocal.channels;
  const measurement = measureVocalBalance(vocalChannels, nonVocalChannels, sampleRate);
  return measurement ? { vocalChannels, nonVocalChannels, measurement } : null;
}

/** Match the source's measured vocal/non-vocal ratio to the reference, with a +3 dB cap. */
export function recommendVocalRebalanceGain(
  source: VocalBalanceMeasurement,
  reference: VocalBalanceMeasurement,
): number {
  if (!vocalBalanceCorrectionTriggered(source)) return 0;
  return Number(Math.max(0, Math.min(3, reference.balanceDb - source.balanceDb)).toFixed(2));
}

export function vocalBalanceCorrectionTriggered(source: VocalBalanceMeasurement): boolean {
  return Number.isFinite(source.balanceDb) && source.balanceDb < -3;
}

export function renderVocalBalanceMix(
  vocalChannels: [Float32Array, Float32Array],
  nonVocalChannels: [Float32Array, Float32Array],
  gainDb: number,
): [Float32Array, Float32Array] {
  if (
    vocalChannels[0].length !== vocalChannels[1].length ||
    nonVocalChannels[0].length !== vocalChannels[0].length ||
    nonVocalChannels[1].length !== vocalChannels[0].length
  ) {
    throw new RangeError('Vocal rebalance requires aligned stereo vocal and non-vocal stems.');
  }
  const gain = Math.pow(10, Math.max(0, Math.min(3, gainDb)) / 20);
  const left = new Float32Array(vocalChannels[0].length);
  const right = new Float32Array(vocalChannels[0].length);
  for (let i = 0; i < left.length; i++) {
    left[i] = nonVocalChannels[0][i] + vocalChannels[0][i] * gain;
    right[i] = nonVocalChannels[1][i] + vocalChannels[1][i] * gain;
  }
  return [left, right];
}

export function vocalRebalanceVerified(
  before: VocalBalanceMeasurement,
  after: VocalBalanceMeasurement,
  reference: VocalBalanceMeasurement,
): boolean {
  return Math.abs(after.balanceDb - reference.balanceDb) <= 3 &&
    Math.abs(after.balanceDb - reference.balanceDb) < Math.abs(before.balanceDb - reference.balanceDb);
}

function requireStereoChannels(channels: Float32Array[]): [Float32Array, Float32Array] {
  if (channels.length < 1 || channels.length > 2 || channels[0].length === 0) {
    throw new Error('Vocal correction requires non-empty mono or stereo source and reference audio.');
  }
  const left = channels[0];
  const right = channels.length === 2 ? channels[1] : channels[0];
  if (left.length !== right.length) throw new Error('Source and reference channels must be aligned stereo pairs.');
  return [left.slice(), right.slice()];
}

async function prepareDemucsInput(track: VocalBalanceTrackInput): Promise<[Float32Array, Float32Array]> {
  const { resampleStereoChannels } = await import('../services/stemSeparation');
  const owned = requireStereoChannels(track.channels);
  return resampleStereoChannels(owned, track.sampleRate, 44_100);
}

async function separateAndMeasure(
  track: VocalBalanceTrackInput,
  signal: AbortSignal,
  label: string,
  onProgress?: (label: string, progress: StemSeparationProgress) => void,
): Promise<SeparatedVocalMaterial | null> {
  const modelInput = await prepareDemucsInput(track);
  const { requestSharedStemSeparation } = await import('../services/stemSeparation');
  const { stems } = await requestSharedStemSeparation({
    channels: modelInput,
    sampleRate: DEMUCS_SAMPLE_RATE,
    resource: {
      durationSec: track.durationSec,
      sampleRate: track.sampleRate,
      fileSizeBytes: track.fileSizeBytes,
    },
    signal,
    onProgress: (progress) => onProgress?.(label, progress),
  });
  if (stems.length === 0) return null;
  const length = Math.min(modelInput[0].length, ...stems.map((stem) => stem.channels[0].length));
  if (length === 0 || stems.some((stem) => stem.channels[1].length < length)) return null;
  return collapseSeparatedVocalStems(stems, DEMUCS_SAMPLE_RATE);
}

function unverified(summary: string, sourceBalanceDb: number | null = null, referenceBalanceDb: number | null = null): VocalBalancePreparation {
  return {
    channels: null,
    verification: {
      status: 'unverified',
      sourceBalanceDb,
      referenceBalanceDb,
      postRenderBalanceDb: null,
      appliedGainDb: 0,
      summary,
    },
  };
}

export async function prepareVocalBalanceAgainstReference(input: {
  source: VocalBalanceTrackInput;
  reference?: VocalBalanceTrackInput | null;
  signal: AbortSignal;
  onProgress?: (label: string, progress: StemSeparationProgress) => void;
}): Promise<VocalBalancePreparation> {
  const sourceMaterial = await separateAndMeasure(input.source, input.signal, 'source', input.onProgress);
  if (!sourceMaterial) {
    return unverified('Source separation did not produce reliable, non-silent vocal and accompaniment stems.');
  }

  const before = sourceMaterial.measurement;
  if (!vocalBalanceCorrectionTriggered(before)) {
    return {
      channels: null,
      verification: {
        status: 'not-needed',
        sourceBalanceDb: before.balanceDb,
        referenceBalanceDb: null,
        postRenderBalanceDb: before.balanceDb,
        appliedGainDb: 0,
        summary: `No vocal adjustment: source vocal balance is ${before.balanceDb.toFixed(1)} dB relative to non-vocals; the -3 dB trigger was not crossed.`,
      },
    };
  }
  if (!input.reference) {
    return unverified(
      'Source vocal balance crossed the -3 dB trigger, but no reference track is available for a measured correction.',
      before.balanceDb,
    );
  }
  const referenceMaterial = await separateAndMeasure(input.reference, input.signal, 'reference', input.onProgress);
  if (!referenceMaterial) {
    return unverified(
      'Reference separation did not produce reliable, non-silent vocal and accompaniment stems.',
      before.balanceDb,
    );
  }

  const reference = referenceMaterial.measurement;
  const gainDb = recommendVocalRebalanceGain(before, reference);
  if (gainDb <= 0) {
    return {
      channels: null,
      verification: {
        status: 'unresolved',
        sourceBalanceDb: before.balanceDb,
        referenceBalanceDb: reference.balanceDb,
        postRenderBalanceDb: before.balanceDb,
        appliedGainDb: 0,
        summary: `Vocal balance is ${before.balanceDb.toFixed(1)} dB (below the -3 dB trigger), but the reference balance (${reference.balanceDb.toFixed(1)} dB) does not support a safe positive correction.`,
      },
    };
  }

  const { resampleStereoChannels } = await import('../services/stemSeparation');
  const [vocalAtSessionRate, nonVocalAtSessionRate] = await Promise.all([
    resampleStereoChannels(sourceMaterial.vocalChannels, DEMUCS_SAMPLE_RATE, input.source.sampleRate),
    resampleStereoChannels(sourceMaterial.nonVocalChannels, DEMUCS_SAMPLE_RATE, input.source.sampleRate),
  ]);
  const mix = renderVocalBalanceMix(vocalAtSessionRate, nonVocalAtSessionRate, gainDb);
  const scale = 10 ** (gainDb / 20);
  for (let i = 0; i < vocalAtSessionRate[0].length; i++) {
    vocalAtSessionRate[0][i] *= scale;
    vocalAtSessionRate[1][i] *= scale;
  }
  const postRenderBalance = measureVocalBalance(
    vocalAtSessionRate,
    nonVocalAtSessionRate,
    input.source.sampleRate,
  );
  if (!postRenderBalance || !vocalRebalanceVerified(before, postRenderBalance, reference)) {
    return {
      channels: null,
      verification: {
        status: 'unverified',
        sourceBalanceDb: before.balanceDb,
        referenceBalanceDb: reference.balanceDb,
        postRenderBalanceDb: postRenderBalance?.balanceDb ?? null,
        appliedGainDb: 0,
        summary: `A candidate +${gainDb.toFixed(1)} dB vocal adjustment failed independent post-render balance verification; the correction was not applied.`,
      },
    };
  }

  const mixAnalysis = analyzeAudioBuffer(mix, input.source.sampleRate);
  if (!isAnalysisMeasurementReliable(mixAnalysis)) {
    return unverified(
      'The vocal-balanced mix failed independent audio-analysis reliability checks; no adjustment was applied.',
      before.balanceDb,
      reference.balanceDb,
    );
  }

  return {
    channels: mix,
    verification: {
      status: 'verified',
      sourceBalanceDb: before.balanceDb,
      referenceBalanceDb: reference.balanceDb,
      postRenderBalanceDb: postRenderBalance.balanceDb,
      appliedGainDb: gainDb,
      summary: `Verified +${gainDb.toFixed(1)} dB vocal-bus gain: source balance ${before.balanceDb.toFixed(1)} dB, reference ${reference.balanceDb.toFixed(1)} dB, rendered ${postRenderBalance.balanceDb.toFixed(1)} dB.`,
    },
  };
}
