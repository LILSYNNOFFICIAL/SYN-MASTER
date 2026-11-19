import test from 'node:test';
import assert from 'node:assert/strict';
import type { AudioAnalysis } from '../types/mastering.ts';
import { isValidAnalysisPayload, sanitizeAvailablePlugins } from './aiPayloadValidation.ts';

function validAnalysis(): AudioAnalysis {
  return {
    durationSec: 120,
    sampleRate: 48000,
    channels: 2,
    integratedLufs: -14,
    shortTermLufsMax: -10,
    momentaryLufsMax: -8,
    loudnessRangeLu: 6,
    rmsDb: -16,
    samplePeakDb: -1,
    truePeakDb: -0.8,
    dynamicRangeDb: 8,
    crestFactorDb: 10,
    plrDb: 13,
    transientDensity: 0.2,
    spectralCentroidHz: 2400,
    spectralSlopeDbPerOct: -2,
    zoneEnergyDb: { sub: -32, bass: -24, lowMid: -27, mid: -25, highMid: -28, presence: -33, air: -42 },
    spectrumBinsFreq: [20, 40, 80],
    spectrumBinsDb: [-40, -35, -28],
    resonances: [{ freqHz: 4200, excessDb: 3.2 }],
    stereoWidth: 0.8,
    midSideRatioDb: -6,
    phaseCorrelation: 0.9,
    lowEndCorrelation: 0.95,
    lrBalanceDb: 0.1,
    monoCompatibilityScore: 92,
    clippedSamples: 0,
    interSamplePeaks: 0,
    thdEstimatePercent: 0.4,
    noiseFloorDb: -66,
    dcOffset: 0.0001,
    loudnessHistoryLufs: [-15, -14, -13],
  };
}

test('accepts complete finite analysis telemetry', () => {
  assert.equal(isValidAnalysisPayload(validAnalysis()), true);
});

test('rejects missing, non-finite, and malformed nested telemetry', () => {
  const missing = { ...validAnalysis() } as Record<string, unknown>;
  delete missing.phaseCorrelation;
  assert.equal(isValidAnalysisPayload(missing), false);

  const nonFinite = { ...validAnalysis(), zoneEnergyDb: { ...validAnalysis().zoneEnergyDb, bass: Number.POSITIVE_INFINITY } };
  assert.equal(isValidAnalysisPayload(nonFinite), false);

  const mismatched = { ...validAnalysis(), spectrumBinsFreq: [20, 40], spectrumBinsDb: [-30] };
  assert.equal(isValidAnalysisPayload(mismatched), false);
});

test('rejects unreasonable sample rates, channel counts, and oversized arrays', () => {
  assert.equal(isValidAnalysisPayload({ ...validAnalysis(), sampleRate: 0 }), false);
  assert.equal(isValidAnalysisPayload({ ...validAnalysis(), channels: 32 }), false);
  assert.equal(isValidAnalysisPayload({
    ...validAnalysis(),
    spectrumBinsFreq: Array(8193).fill(1),
    spectrumBinsDb: Array(8193).fill(1),
  }), false);
});

test('sanitizes plugin metadata and caps entry count and field lengths', () => {
  const result = sanitizeAvailablePlugins([
    { name: 'N'.repeat(200), role: 'R'.repeat(100), manufacturer: 'M'.repeat(200), ignored: 'secret' },
  ]);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.value?.[0].name.length, 80);
    assert.equal(result.value?.[0].role.length, 40);
    assert.equal(result.value?.[0].manufacturer.length, 80);
    assert.equal('ignored' in result.value![0], false);
  }
  assert.equal(sanitizeAvailablePlugins(Array(129).fill({})).valid, false);
  assert.equal(sanitizeAvailablePlugins([null]).valid, false);
});
