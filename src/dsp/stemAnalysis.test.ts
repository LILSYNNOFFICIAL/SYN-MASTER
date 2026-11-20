import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStemSet, type StemInput } from './stemAnalysis';

function sine(freqHz: number, sampleRate = 48000, seconds = 0.5, amplitude = 0.2): Float32Array {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return samples;
}

test('stem analysis aligns offset stems and analyzes the reconstructed sum', () => {
  const sampleRate = 48000;
  const stems: StemInput[] = [
    { id: 'drums', name: 'Drums', role: 'drums', channels: [sine(90, sampleRate)] },
    { id: 'bass', name: 'Bass', role: 'bass', channels: [sine(55, sampleRate, 0.25)], offsetSamples: 12000 },
  ];

  const result = analyzeStemSet(stems, sampleRate);

  assert.equal(result.stems.length, 2);
  assert.equal(result.timelineSamples, 24000);
  assert.equal(result.sampleRate, sampleRate);
  assert.equal(result.mixAnalysis.durationSec, 0.5);
  assert.equal(result.stems[1].offsetSamples, 12000);
  assert.ok(Number.isFinite(result.mixAnalysis.integratedLufs));
  assert.ok(result.mixAnalysis.rmsDb > -50);
});

test('stem analysis reports spectral overlap candidates without claiming audible masking', () => {
  const sampleRate = 48000;
  const result = analyzeStemSet([
    { id: 'bass', name: 'Bass', role: 'bass', channels: [sine(110, sampleRate)] },
    { id: 'instrument', name: 'Instrument', role: 'instruments', channels: [sine(115, sampleRate)] },
    { id: 'air', name: 'Air', role: 'other', channels: [sine(8000, sampleRate)] },
  ], sampleRate);

  assert.ok(result.overlaps.some((item) =>
    item.stemAId === 'bass' && item.stemBId === 'instrument' && item.band === 'bass'
  ));
  assert.ok(result.overlaps.every((item) => item.kind === 'spectral-overlap-candidate'));
  assert.ok(result.overlaps.every((item) => !('maskingConfirmed' in item)));
});

test('stem analysis rejects invalid, mismatched, and duplicate stem inputs', () => {
  assert.throws(() => analyzeStemSet([], 48000), /at least one stem/i);
  assert.throws(() => analyzeStemSet([
    { id: 'a', name: 'A', role: 'other', sampleRate: 48000, channels: [sine(100, 48000)] },
    { id: 'b', name: 'B', role: 'other', sampleRate: 44100, channels: [sine(100, 44100)] },
  ], 48000), /sample rate/i);
  assert.throws(() => analyzeStemSet([
    { id: 'a', name: 'A', role: 'other', channels: [sine(100, 48000)] },
    { id: 'a', name: 'Duplicate', role: 'other', channels: [sine(200, 48000)] },
  ], 48000), /unique/i);
});

test('stem analysis rejects channel shape and non-finite sample errors', () => {
  const malformed = new Float32Array([0, Number.NaN, 0]);
  assert.throws(() => analyzeStemSet([
    { id: 'bad', name: 'Bad', role: 'other', channels: [malformed] },
  ], 48000), /finite/i);
  assert.throws(() => analyzeStemSet([
    { id: 'bad', name: 'Bad', role: 'other', channels: [sine(100), sine(100).subarray(1)] },
  ], 48000), /same length/i);
});
