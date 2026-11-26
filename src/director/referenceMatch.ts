import type { AudioAnalysis, EQBand } from '../types/mastering';
import { isAnalysisMeasurementReliable } from './analyzeIntelligence';

const MATCH_REGIONS: Array<{
  lowHz: number;
  highHz: number;
  freq: number;
  shape: EQBand['shape'];
  q: number;
}> = [
  { lowHz: 35, highHz: 100, freq: 70, shape: 'lowshelf', q: 0.8 },
  { lowHz: 100, highHz: 300, freq: 180, shape: 'bell', q: 0.8 },
  { lowHz: 300, highHz: 700, freq: 470, shape: 'bell', q: 0.8 },
  { lowHz: 2000, highHz: 6000, freq: 3500, shape: 'bell', q: 0.8 },
  { lowHz: 6000, highHz: 15000, freq: 9500, shape: 'highshelf', q: 0.8 },
];

function meanBandDb(analysis: AudioAnalysis, lowHz: number, highHz: number): number | null {
  const powers: number[] = [];
  for (let i = 0; i < analysis.spectrumBinsFreq.length; i++) {
    const freq = analysis.spectrumBinsFreq[i];
    const level = analysis.spectrumBinsDb[i];
    if (freq >= lowHz && freq <= highHz && Number.isFinite(level) && level > -100) {
      powers.push(10 ** (level / 10));
    }
  }
  if (powers.length < 2) return null;
  const mean = powers.reduce((sum, power) => sum + power, 0) / powers.length;
  return mean > 0 ? 10 * Math.log10(mean) : null;
}

/**
 * Derives broad, level-neutral EQ corrections from measured source/reference
 * spectra. Empty output means the reference did not provide enough reliable data.
 */
export function deriveReferenceMatchBands(
  source: AudioAnalysis,
  reference: AudioAnalysis | null | undefined,
): EQBand[] {
  if (
    !isAnalysisMeasurementReliable(source) ||
    !isAnalysisMeasurementReliable(reference) ||
    source.spectrumBinsFreq.length !== source.spectrumBinsDb.length ||
    reference.spectrumBinsFreq.length !== reference.spectrumBinsDb.length
  ) {
    return [];
  }

  const sourceMid = meanBandDb(source, 500, 2000);
  const referenceMid = meanBandDb(reference, 500, 2000);
  if (sourceMid === null || referenceMid === null) return [];

  const bands: EQBand[] = [];
  for (const [index, region] of MATCH_REGIONS.entries()) {
    const sourceLevel = meanBandDb(source, region.lowHz, region.highHz);
    const referenceLevel = meanBandDb(reference, region.lowHz, region.highHz);
    if (sourceLevel === null || referenceLevel === null) continue;

    const relativeDelta = (referenceLevel - referenceMid) - (sourceLevel - sourceMid);
    if (!Number.isFinite(relativeDelta) || Math.abs(relativeDelta) < 1.2) continue;
    const gain = Math.max(-2.5, Math.min(2.5, relativeDelta * 0.45));
    bands.push({
      id: `match-${index + 1}`,
      enabled: true,
      shape: region.shape,
      freq: region.freq,
      gain: Number(gain.toFixed(1)),
      q: region.q,
    });
  }
  return bands;
}
