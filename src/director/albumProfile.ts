import type { AudioAnalysis, SpectralBandEnergy } from '../types/mastering';

export interface AlbumProfileTrack {
  name: string;
  analysis: AudioAnalysis;
}

export interface AlbumMasteringProfile {
  tracks: AlbumProfileTrack[];
  analysis: AudioAnalysis;
  integratedLufsRange: [number, number];
  dynamicRangeRangeDb: [number, number];
  trackCount: number;
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Build a robust, level-matched album reference from measured track analyses.
 * Median statistics reduce the influence of intentionally quiet/loud songs and
 * per-bin median spectra preserve the album's broad tonal center without averaging
 * phase-sensitive audio samples.
 */
export function buildAlbumMasteringProfile(tracks: AlbumProfileTrack[]): AlbumMasteringProfile | null {
  if (tracks.length < 2) return null;
  const valid = tracks.filter(({ analysis }) =>
    Number.isFinite(analysis.integratedLufs) &&
    Number.isFinite(analysis.dynamicRangeDb) &&
    analysis.spectrumBinsFreq.length > 0 &&
    analysis.spectrumBinsFreq.length === analysis.spectrumBinsDb.length,
  );
  if (valid.length < 2) return null;
  const first = valid[0].analysis;
  const compatible = valid.filter(({ analysis }) =>
    analysis.spectrumBinsFreq.length === first.spectrumBinsFreq.length &&
    analysis.spectrumBinsFreq.every((hz, index) => Math.abs(hz - first.spectrumBinsFreq[index]) <= Math.max(0.01, hz * 1e-5)),
  );
  if (compatible.length < 2) return null;
  const analyses = compatible.map((track) => track.analysis);
  const med = (key: keyof AudioAnalysis) => median(analyses.map((a) => Number(a[key])));
  const zones: SpectralBandEnergy = {
    sub: median(analyses.map((a) => a.zoneEnergyDb.sub)),
    bass: median(analyses.map((a) => a.zoneEnergyDb.bass)),
    lowMid: median(analyses.map((a) => a.zoneEnergyDb.lowMid)),
    mid: median(analyses.map((a) => a.zoneEnergyDb.mid)),
    highMid: median(analyses.map((a) => a.zoneEnergyDb.highMid)),
    presence: median(analyses.map((a) => a.zoneEnergyDb.presence)),
    air: median(analyses.map((a) => a.zoneEnergyDb.air)),
  };
  const analysis: AudioAnalysis = {
    ...first,
    durationSec: med('durationSec'),
    sampleRate: med('sampleRate'),
    channels: Math.round(med('channels')),
    integratedLufs: med('integratedLufs'),
    shortTermLufsMax: med('shortTermLufsMax'),
    momentaryLufsMax: med('momentaryLufsMax'),
    loudnessRangeLu: med('loudnessRangeLu'),
    rmsDb: med('rmsDb'),
    samplePeakDb: med('samplePeakDb'),
    truePeakDb: med('truePeakDb'),
    dynamicRangeDb: med('dynamicRangeDb'),
    crestFactorDb: med('crestFactorDb'),
    plrDb: med('plrDb'),
    transientDensity: med('transientDensity'),
    spectralCentroidHz: med('spectralCentroidHz'),
    spectralSlopeDbPerOct: med('spectralSlopeDbPerOct'),
    zoneEnergyDb: zones,
    spectrumBinsFreq: first.spectrumBinsFreq.slice(),
    spectrumBinsDb: first.spectrumBinsFreq.map((_, index) => median(analyses.map((a) => a.spectrumBinsDb[index]))),
    resonances: [],
    stereoWidth: med('stereoWidth'),
    midSideRatioDb: med('midSideRatioDb'),
    phaseCorrelation: med('phaseCorrelation'),
    lowEndCorrelation: med('lowEndCorrelation'),
    stereoBandCorrelation: first.stereoBandCorrelation ? {
      low: median(analyses.map((a) => a.stereoBandCorrelation?.low ?? a.phaseCorrelation)),
      mid: median(analyses.map((a) => a.stereoBandCorrelation?.mid ?? a.phaseCorrelation)),
      high: median(analyses.map((a) => a.stereoBandCorrelation?.high ?? a.phaseCorrelation)),
    } : undefined,
    lrBalanceDb: med('lrBalanceDb'),
    monoCompatibilityScore: med('monoCompatibilityScore'),
    clippedSamples: Math.round(med('clippedSamples')),
    interSamplePeaks: Math.round(med('interSamplePeaks')),
    thdEstimatePercent: med('thdEstimatePercent'),
    noiseFloorDb: med('noiseFloorDb'),
    dcOffset: median(analyses.map((a) => Math.abs(a.dcOffset))) * Math.sign(median(analyses.map((a) => a.dcOffset))),
    loudnessHistoryLufs: [],
    clickCount: Math.round(median(analyses.map((a) => a.clickCount ?? 0))),
  };
  const lufs = analyses.map((a) => a.integratedLufs).sort((a, b) => a - b);
  const dr = analyses.map((a) => a.dynamicRangeDb).sort((a, b) => a - b);
  return {
    tracks: compatible,
    analysis,
    trackCount: compatible.length,
    integratedLufsRange: [lufs[0], lufs[lufs.length - 1]],
    dynamicRangeRangeDb: [dr[0], dr[dr.length - 1]],
  };
}

export function formatAlbumMasteringContext(profile: AlbumMasteringProfile): string {
  const [minLufs, maxLufs] = profile.integratedLufsRange;
  const [minDr, maxDr] = profile.dynamicRangeRangeDb;
  return [
    `ALBUM REFERENCE PROFILE: robust per-band and metric medians from ${profile.trackCount} user-selected album tracks.`,
    `Track loudness span ${minLufs.toFixed(1)} to ${maxLufs.toFixed(1)} LUFS; median target ${profile.analysis.integratedLufs.toFixed(1)} LUFS. Track dynamic-range span ${minDr.toFixed(1)} to ${maxDr.toFixed(1)} dB; median ${profile.analysis.dynamicRangeDb.toFixed(1)} dB.`,
    'Use this profile to preserve album-wide tonal/dynamic character while making track-specific corrections. Do not force identical settings or loudness on every song; respect the active delivery objective and deliberate track-level contrast.',
  ].join(' ');
}
