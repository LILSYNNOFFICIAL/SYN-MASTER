import { analyzeAudioBuffer } from './analyzer';
import type { AudioAnalysis, SpectralBandEnergy } from '../types/mastering';

export type StemRole = 'vocals' | 'bass' | 'drums' | 'instruments' | 'other';

export interface StemInput {
  id: string;
  name: string;
  role: StemRole;
  channels: Float32Array[];
  /** Optional source metadata. When present it must match the session sample rate. */
  sampleRate?: number;
  /** Explicit timeline placement in samples. No automatic alignment is inferred. */
  offsetSamples?: number;
}

export interface StemAnalysis {
  id: string;
  name: string;
  role: StemRole;
  offsetSamples: number;
  durationSec: number;
  analysis: AudioAnalysis;
}

export interface StemSpectralOverlap {
  stemAId: string;
  stemBId: string;
  stemARole: StemRole;
  stemBRole: StemRole;
  band: keyof SpectralBandEnergy;
  stemALevelDb: number;
  stemBLevelDb: number;
  differenceDb: number;
  kind: 'spectral-overlap-candidate';
  confidence: 'low' | 'moderate';
}

export interface StemSetAnalysis {
  sampleRate: number;
  timelineSamples: number;
  durationSec: number;
  stems: StemAnalysis[];
  overlaps: StemSpectralOverlap[];
  mixAnalysis: AudioAnalysis;
  warnings: string[];
}

const SPECTRAL_BANDS: Array<keyof SpectralBandEnergy> = [
  'sub',
  'bass',
  'lowMid',
  'mid',
  'highMid',
  'presence',
  'air',
];

/**
 * Analyze imported stems on a shared sample timeline.
 *
 * This function does not perform source separation or guess timing. Every
 * stem's offset is explicit, and all sample-rate conversion/alignment must
 * happen before calling this API.
 */
export function analyzeStemSet(stems: StemInput[], sampleRate: number): StemSetAnalysis {
  if (!Array.isArray(stems) || stems.length === 0) {
    throw new RangeError('At least one stem is required');
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000) {
    throw new RangeError('Session sample rate must be between 8000 and 384000 Hz');
  }

  const ids = new Set<string>();
  let timelineSamples = 0;
  const prepared = stems.map((stem) => {
    if (!stem || typeof stem !== 'object') throw new TypeError('Each stem must be an object');
    if (typeof stem.id !== 'string' || stem.id.trim().length === 0) {
      throw new TypeError('Every stem must have a non-empty id');
    }
    if (ids.has(stem.id)) throw new RangeError('Stem ids must be unique');
    ids.add(stem.id);
    if (typeof stem.name !== 'string' || stem.name.trim().length === 0) {
      throw new TypeError(`Stem "${stem.id}" must have a non-empty name`);
    }
    if (!['vocals', 'bass', 'drums', 'instruments', 'other'].includes(stem.role)) {
      throw new TypeError(`Stem "${stem.id}" has an unsupported role`);
    }
    if (stem.sampleRate !== undefined && stem.sampleRate !== sampleRate) {
      throw new RangeError(`Stem "${stem.id}" sample rate does not match the session sample rate`);
    }
    if (!Array.isArray(stem.channels) || stem.channels.length < 1 || stem.channels.length > 2) {
      throw new RangeError(`Stem "${stem.id}" must contain one or two channels`);
    }

    const length = stem.channels[0]?.length ?? 0;
    if (length === 0) throw new RangeError(`Stem "${stem.id}" cannot be empty`);
    for (const channel of stem.channels) {
      if (!(channel instanceof Float32Array) || channel.length !== length) {
        throw new RangeError(`All channels in stem "${stem.id}" must have the same length`);
      }
      for (let i = 0; i < channel.length; i++) {
        if (!Number.isFinite(channel[i])) {
          throw new RangeError(`Stem "${stem.id}" contains a non-finite sample at index ${i}`);
        }
      }
    }

    const offsetSamples = stem.offsetSamples ?? 0;
    if (!Number.isSafeInteger(offsetSamples) || offsetSamples < 0) {
      throw new RangeError(`Stem "${stem.id}" offsetSamples must be a non-negative safe integer`);
    }
    const end = offsetSamples + length;
    if (!Number.isSafeInteger(end)) {
      throw new RangeError(`Stem "${stem.id}" timeline position exceeds the safe sample range`);
    }
    timelineSamples = Math.max(timelineSamples, end);
    return { stem, length, offsetSamples };
  });

  const analyses: StemAnalysis[] = prepared.map(({ stem, offsetSamples }) => ({
    id: stem.id,
    name: stem.name,
    role: stem.role,
    offsetSamples,
    durationSec: stem.channels[0].length / sampleRate,
    analysis: analyzeAudioBuffer(stem.channels, sampleRate),
  }));

  const overlaps: StemSpectralOverlap[] = [];
  for (let a = 0; a < analyses.length; a++) {
    for (let b = a + 1; b < analyses.length; b++) {
      const stemA = analyses[a];
      const stemB = analyses[b];
      for (const band of SPECTRAL_BANDS) {
        const levelA = stemA.analysis.zoneEnergyDb[band];
        const levelB = stemB.analysis.zoneEnergyDb[band];
        // Ignore near-silence. Similar energy in a band is evidence of
        // spectral coexistence only, not proof of audible masking.
        if (levelA <= -85 || levelB <= -85) continue;
        const differenceDb = Math.abs(levelA - levelB);
        if (differenceDb <= 9) {
          overlaps.push({
            stemAId: stemA.id,
            stemBId: stemB.id,
            stemARole: stemA.role,
            stemBRole: stemB.role,
            band,
            stemALevelDb: levelA,
            stemBLevelDb: levelB,
            differenceDb: Number(differenceDb.toFixed(2)),
            kind: 'spectral-overlap-candidate',
            confidence: differenceDb <= 4 ? 'moderate' : 'low',
          });
        }
      }
    }
  }

  // Reconstruct a stereo timeline. Mono stems are centered by feeding the
  // same sample to L/R; stereo stems retain their channel placement.
  const mixL = new Float32Array(timelineSamples);
  const mixR = new Float32Array(timelineSamples);
  for (const { stem, length, offsetSamples } of prepared) {
    const left = stem.channels[0];
    const right = stem.channels.length > 1 ? stem.channels[1] : left;
    for (let i = 0; i < length; i++) {
      mixL[offsetSamples + i] += left[i];
      mixR[offsetSamples + i] += right[i];
    }
  }

  const warnings: string[] = [];
  const mixAnalysis = analyzeAudioBuffer([mixL, mixR], sampleRate);
  if (mixAnalysis.clippedSamples > 0) {
    warnings.push('The reconstructed stem sum contains clipped samples. Check stem gain and alignment.');
  }
  if (overlaps.length > 0) {
    warnings.push('Spectral overlap candidates are present. Audition the stems together before applying corrective processing.');
  }

  return {
    sampleRate,
    timelineSamples,
    durationSec: timelineSamples / sampleRate,
    stems: analyses,
    overlaps,
    mixAnalysis,
    warnings,
  };
}
