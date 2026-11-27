import assert from 'node:assert/strict';
import test from 'node:test';
import { getDiagnosisThresholds } from './analyzeIntelligence.ts';
import { buildGuardFeedback, formatGuardFeedbackForPrompt, measureGuardBalance } from './guardFeedback.ts';
import type { AudioAnalysis } from '../types/mastering.ts';
function analysis(overrides: Partial<AudioAnalysis> = {}): AudioAnalysis {
  return {
    durationSec: 120, sampleRate: 48000, channels: 2, integratedLufs: -14,
    shortTermLufsMax: -10, momentaryLufsMax: -8, loudnessRangeLu: 6, rmsDb: -16,
    samplePeakDb: -1, truePeakDb: -0.8, dynamicRangeDb: 8, crestFactorDb: 10,
    plrDb: 13, transientDensity: 0.2, spectralCentroidHz: 2400, spectralSlopeDbPerOct: -2,
    zoneEnergyDb: { sub: -32, bass: -24, lowMid: -27, mid: -25, highMid: -28, presence: -33, air: -42 },
    spectrumBinsFreq: [100, 150, 250, 400, 500], spectrumBinsDb: [-40, -30, -28, -31, -35],
    resonances: [], stereoWidth: 0.8, midSideRatioDb: -6, phaseCorrelation: 0.9,
    lowEndCorrelation: 0.95, lrBalanceDb: 0.1, monoCompatibilityScore: 92,
    clippedSamples: 0, interSamplePeaks: 0, thdEstimatePercent: 0.4, noiseFloorDb: -66,
    dcOffset: 0.0001, loudnessHistoryLufs: [-15, -14, -13], ...overrides,
  };
}
test('measures all four low-frequency balance constraints from this track', () => {
  const a = analysis(); const limits = getDiagnosisThresholds('streaming'); const m = measureGuardBalance(a, limits);
  assert.equal(m.bassVsMid.valueDb, 1); assert.equal(m.lowMidVsMid.valueDb, -2);
  assert.equal(m.subVsBass.valueDb, -8); assert.equal(typeof m.region150To400VsMid.valueDb, 'number');
  assert.equal(m.bassVsMid.remainingDb, limits.bassMidDiffLimit - 1);
});
test('uses selected objective limits rather than a song-specific preset', () => {
  const a = analysis();
  assert.equal(measureGuardBalance(a, getDiagnosisThresholds('streaming')).bassVsMid.limitDb, 11.5);
  assert.equal(measureGuardBalance(a, getDiagnosisThresholds('electronic')).bassVsMid.limitDb, 14.5);
});
test('formats rejected-pass evidence without prescribing a processing move', () => {
  const source = analysis();
  const rejected = analysis({ zoneEnergyDb: { ...source.zoneEnergyDb, mid: -31, lowMid: -24, bass: -19, sub: -27 } });
  const feedback = buildGuardFeedback({ pass: 2, reasonCodes: ['regression-guard', 'low-mid-sub-bass-masking'], source, rejected, limits: getDiagnosisThresholds('streaming') });
  const prompt = formatGuardFeedbackForPrompt(feedback);
  assert.equal(feedback.pass, 2); assert.ok(feedback.rejected.bassVsMid.valueDb! > feedback.source.bassVsMid.valueDb!);
  assert.match(prompt, /Original source measurements/); assert.match(prompt, /Rejected render measurements/);
  assert.match(prompt, /150–400 Hz vs Mid/); assert.match(prompt, /Sub vs Bass/);
  assert.match(prompt, /not a prescribed correction/); assert.doesNotMatch(prompt, /cut 500|reduce 150|apply a bell/i);
});
test('does not invent a regional measurement when spectrum bins are absent', () => {
  const m = measureGuardBalance(analysis({ spectrumBinsFreq: [], spectrumBinsDb: [] }), getDiagnosisThresholds('streaming'));
  assert.equal(m.region150To400VsMid.valueDb, null); assert.equal(m.region150To400VsMid.remainingDb, null);
});
