import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer } from './analyzer';
import { createProcessorModule } from './chainValidation';
import { renderStemBusMix } from './stemBusRenderer';

const SR = 44100;

function tone(freq: number, seconds = 0.25, amplitude = 0.2): Float32Array {
  const samples = new Float32Array(Math.floor(SR * seconds));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  }
  return samples;
}

test('stem bus renderer processes only the targeted stem and preserves the other bus', async () => {
  const bass = tone(110);
  const vocal = tone(6000);
  const eq = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 0,
      bands: [{ id: 'lp', enabled: true, shape: 'lowpass', freq: 1200, gain: 0, q: 0.71 }],
    },
  });

  const result = await renderStemBusMix([
    { id: 'bass', name: 'Bass', role: 'bass', channels: [bass], sampleRate: SR },
    { id: 'vocal', name: 'Vocal', role: 'vocals', channels: [vocal], sampleRate: SR },
  ], SR, { chainsByStemId: { vocal: [eq] } });

  assert.equal(result.stems.length, 2);
  assert.equal(result.stems[0].chain.length, 0);
  assert.equal(result.stems[1].chain.length, 1);

  const originalBass = analyzeAudioBuffer([bass, bass], SR);
  const renderedBass = result.stems[0].analysis;
  assert.ok(Math.abs(renderedBass.rmsDb - originalBass.rmsDb) < 0.02, 'untargeted bass bus should remain unchanged');

  const originalVocal = analyzeAudioBuffer([vocal, vocal], SR);
  assert.ok(result.stems[1].analysis.rmsDb < originalVocal.rmsDb - 10, 'low-pass must reduce only the targeted 6 kHz vocal fixture');
});

test('stem bus renderer honors timeline offsets and never silently normalizes the sum', async () => {
  const a = tone(220, 0.25, 0.35);
  const b = tone(220, 0.25, 0.35);
  const result = await renderStemBusMix([
    { id: 'a', name: 'A', role: 'instruments', channels: [a], sampleRate: SR },
    { id: 'b', name: 'B', role: 'other', channels: [b], sampleRate: SR, offsetSamples: 4000 },
  ], SR);

  assert.equal(result.timelineSamples, a.length + 4000);
  assert.equal(result.durationSec, result.timelineSamples / SR);
  assert.equal(result.stems[1].offsetSamples, 4000);
  assert.ok(result.mixAnalysis.samplePeakDb > result.stems[0].analysis.samplePeakDb);
  assert.ok(result.warnings.some((warning) => /overlap candidates/i.test(warning)));
});

test('stem bus renderer rejects unknown chain IDs and malformed processor chains', async () => {
  const input = [{ id: 'bass', name: 'Bass', role: 'bass' as const, channels: [tone(90)], sampleRate: SR }];
  await assert.rejects(
    renderStemBusMix(input, SR, { chainsByStemId: { ghost: [] } }),
    /unknown stem/i,
  );
  await assert.rejects(
    renderStemBusMix(input, SR, {
      chainsByStemId: {
        bass: [{ type: 'not-a-processor' } as never],
      },
    }),
    /invalid processor module/i,
  );
});

test('stem bus renderer reports sum clipping instead of applying hidden gain control', async () => {
  const loud = tone(440, 0.25, 0.8);
  const result = await renderStemBusMix([
    { id: 'a', name: 'A', role: 'instruments', channels: [loud], sampleRate: SR },
    { id: 'b', name: 'B', role: 'other', channels: [loud], sampleRate: SR },
  ], SR);

  assert.ok(result.mixAnalysis.clippedSamples > 0);
  assert.ok(result.warnings.some((warning) => /sum clips/i.test(warning)));
  assert.ok(result.mixAnalysis.samplePeakDb >= 0);
});
