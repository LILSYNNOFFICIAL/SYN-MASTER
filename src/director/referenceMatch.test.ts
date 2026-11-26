import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer } from '../dsp/analyzer';
import { renderMixedChain } from '../dsp/mixedChainRenderer';
import { buildExplainableMasterPlan } from './directorEngine';
import { deriveReferenceMatchBands } from './referenceMatch';

const SAMPLE_RATE = 48_000;

function analysisWithSpectrum(levelAt: (freqHz: number) => number, toneHz = 440) {
  const sampleCount = SAMPLE_RATE;
  const left = new Float32Array(sampleCount);
  const right = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const sample = 0.1 * Math.sin((2 * Math.PI * toneHz * i) / SAMPLE_RATE);
    left[i] = sample;
    right[i] = sample;
  }
  const measured = analyzeAudioBuffer([left, right], SAMPLE_RATE);
  const spectrumBinsFreq = Array.from({ length: 64 }, (_, i) =>
    Math.round(24 * ((20_000 / 24) ** ((i + 0.5) / 64))),
  );
  return {
    ...measured,
    spectrumBinsFreq,
    spectrumBinsDb: spectrumBinsFreq.map(levelAt),
  };
}

function rmsDb(buffer: Float32Array): number {
  let power = 0;
  for (let i = 4096; i < buffer.length; i++) power += buffer[i] * buffer[i];
  return 10 * Math.log10(power / (buffer.length - 4096) + 1e-24);
}

test('reference match derives bounded, level-neutral EQ bands from valid spectra', () => {
  const source = analysisWithSpectrum((freq) => (freq > 2000 && freq < 6000 ? -30 : -24));
  const reference = analysisWithSpectrum((freq) => (freq > 2000 && freq < 6000 ? -23 : -24));
  const bands = deriveReferenceMatchBands(source, reference);
  const presenceBand = bands.find((band) => band.freq === 3500);

  assert.ok(presenceBand, 'reference-relative upper-mid deficit should produce a measured band');
  assert.equal(presenceBand.shape, 'bell');
  assert.ok(presenceBand.gain > 0 && presenceBand.gain <= 2.5);
  assert.ok(bands.every((band) => Math.abs(band.gain) <= 2.5));
});

test('reference match does not invent EQ without a valid measured reference', () => {
  const source = analysisWithSpectrum(() => -24);
  assert.deepEqual(deriveReferenceMatchBands(source, null), []);
  assert.deepEqual(
    deriveReferenceMatchBands(source, { ...source, spectrumBinsDb: [] }),
    [],
  );
});

test('reference-matched EQ bands are present in and execute through the offline render chain', async () => {
  const source = analysisWithSpectrum((freq) => (freq > 2000 && freq < 6000 ? -30 : -24), 3500);
  const reference = analysisWithSpectrum((freq) => (freq > 2000 && freq < 6000 ? -23 : -24));
  const plan = buildExplainableMasterPlan({
    analysis: source,
    objectiveId: 'transparent',
    referenceAnalysis: reference,
  });
  const eq = plan.chain.find((module) => module.type === 'parametric-eq');
  assert.ok(eq, 'reference match should select the existing parametric EQ processor');
  assert.ok(
    (eq.params as { bands: Array<{ id: string }> }).bands.some((band) => band.id === 'match-4'),
    'the selected EQ chain should contain the measured reference-match band',
  );

  const tone = new Float32Array(SAMPLE_RATE);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.1 * Math.sin((2 * Math.PI * 3500 * i) / SAMPLE_RATE);
  const rendered = await renderMixedChain([tone, tone.slice()], SAMPLE_RATE, [eq], undefined);
  assert.ok(rmsDb(rendered.channels[0]) > -23, 'the selected EQ must change the actual rendered signal');
});

test('vocal-focused planning does not add a generic vocal-pocket boost without vocal measurements', () => {
  const source = analysisWithSpectrum(() => -24);
  const plan = buildExplainableMasterPlan({
    analysis: source,
    objectiveId: 'vocal-focused',
  });
  assert.ok(
    plan.recommendations.every((recommendation) =>
      !recommendation.proposedParamsSummary.includes('Vocal pocket articulation'),
    ),
  );
});
