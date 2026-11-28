import test from 'node:test';
import assert from 'node:assert/strict';
import type { AudioAnalysis } from '../types/mastering';
import { buildAlbumMasteringProfile, formatAlbumMasteringContext } from './albumProfile';

function analysis(lufs: number, slope: number): AudioAnalysis {
  return {
    durationSec: 180, sampleRate: 48000, channels: 2,
    integratedLufs: lufs, shortTermLufsMax: lufs + 2, momentaryLufsMax: lufs + 4,
    loudnessRangeLu: 7, rmsDb: -18, samplePeakDb: -1, truePeakDb: -0.8,
    dynamicRangeDb: 9, crestFactorDb: 11, plrDb: 10, transientDensity: 0.3,
    spectralCentroidHz: 3000, spectralSlopeDbPerOct: slope,
    zoneEnergyDb: { sub: -40, bass: -30, lowMid: -28, mid: -27, highMid: -30, presence: -33, air: -40 },
    spectrumBinsFreq: [100, 200, 400], spectrumBinsDb: [-20 + slope, -22 + slope, -24 + slope],
    resonances: [], stereoWidth: 0.5, midSideRatioDb: -6, phaseCorrelation: 0.8,
    lowEndCorrelation: 0.9, stereoBandCorrelation: { low: 0.9, mid: 0.8, high: 0.7 },
    lrBalanceDb: 0, monoCompatibilityScore: 90, clippedSamples: 0, interSamplePeaks: 0,
    thdEstimatePercent: 0.2, noiseFloorDb: -80, dcOffset: 0, loudnessHistoryLufs: [],
  };
}

test('album profile uses robust medians and retains track spread for sequencing decisions', () => {
  const profile = buildAlbumMasteringProfile([
    { name: 'A', analysis: analysis(-14, -2) },
    { name: 'B', analysis: analysis(-12, -4) },
    { name: 'outlier', analysis: analysis(-2, -20) },
  ]);
  assert.ok(profile);
  assert.equal(profile.trackCount, 3);
  assert.equal(profile.analysis.integratedLufs, -12);
  assert.equal(profile.analysis.spectralSlopeDbPerOct, -4);
  assert.deepEqual(profile.integratedLufsRange, [-14, -2]);
  assert.match(formatAlbumMasteringContext(profile), /do not force identical settings or loudness/i);
});

test('album profile requires multiple analyses on a compatible spectral grid', () => {
  assert.equal(buildAlbumMasteringProfile([{ name: 'only', analysis: analysis(-14, -2) }]), null);
  const other = analysis(-12, -4);
  other.spectrumBinsFreq = [80, 190, 390];
  assert.equal(buildAlbumMasteringProfile([
    { name: 'A', analysis: analysis(-14, -2) }, { name: 'B', analysis: other },
  ]), null);
});
