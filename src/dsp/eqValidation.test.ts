import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultParams, validateChain, validateProcessorParams } from './chainValidation';
import { normalizeStrategyResponse, SYSTEM_PROMPT } from '../ai/masteringPrompt';
import type { DynamicEQParams, ParametricEQParams } from '../types/mastering';

test('legacy EQ bands validate to exactly the original keys (no new fields injected)', () => {
  const v = validateProcessorParams('parametric-eq', createDefaultParams('parametric-eq')) as ParametricEQParams;
  assert.deepEqual(Object.keys(v).sort(), ['bands', 'msMode', 'phaseMode', 'tiltDb']);
  for (const b of v.bands) assert.deepEqual(Object.keys(b).sort(), ['enabled', 'freq', 'gain', 'id', 'q', 'shape']);
  const d = validateProcessorParams('dynamic-eq', createDefaultParams('dynamic-eq')) as DynamicEQParams;
  for (const b of d.bands) {
    assert.deepEqual(Object.keys(b).sort(), ['attackMs', 'enabled', 'freq', 'id', 'maxCutDb', 'mode', 'q', 'ratio', 'releaseMs', 'thresholdDb']);
  }
});

test('EQ validation keeps valid subtypes, slopes and channels and drops invalid ones', () => {
  const v = validateProcessorParams('parametric-eq', {
    phaseMode: 'minimum',
    msMode: 'stereo',
    tiltDb: 0,
    autoGain: true,
    bands: [
      { id: 'a', shape: 'highpass', subtype: 'brickwall', slope: 48, channel: 'side', freq: 120, gain: 0, q: 0.7 },
      { id: 'b', shape: 'lowshelf', subtype: 'baxandall', slope: 24, channel: 'mono', freq: 100, gain: 3, q: 0.7 },
      { id: 'c', shape: 'bell', subtype: 'brickwall', freq: 1000, gain: 40, q: 99, solo: 'yes' },
      { id: 'd', shape: 'lowpass', subtype: 'flat', slope: 96, freq: 99999, gain: 0, q: 0.01 },
      { id: 'e', shape: 'highshelf', subtype: 'analog', slope: 18, freq: 8000, gain: 2, q: 0.7 },
      { id: 'f', shape: 'tilt', freq: 1000, gain: -3, q: 1, channel: 'mid', solo: true },
      { id: 'g', shape: 'warp', freq: 1000, gain: 1, q: 1 },
      { id: 'h', shape: 'bandpass', freq: 500, gain: 0, q: 3, channel: 'left' },
      { id: 'i', shape: 'bell', freq: 500, gain: 1, q: 1 },
    ],
  }) as ParametricEQParams;
  assert.equal(v.autoGain, true);
  assert.equal(v.bands.length, 8, 'max 8 bands');
  const [a, b, c, d, e, f, g, h] = v.bands;
  assert.equal(a.subtype, 'brickwall');
  assert.equal(a.slope, undefined, 'brickwall has a fixed slope');
  assert.equal(a.channel, 'side');
  assert.equal(b.subtype, 'baxandall');
  assert.equal(b.slope, undefined);
  assert.equal(b.channel, undefined, 'unknown channel dropped');
  assert.equal(c.subtype, undefined, 'subtype must belong to its shape');
  assert.equal(c.gain, 12);
  assert.equal(c.q, 12);
  assert.equal(c.solo, undefined);
  assert.equal(d.slope, 96);
  assert.equal(d.freq, 19500);
  assert.equal(d.q, 0.25);
  assert.equal(e.slope, undefined, 'analog shelf supports 6/12/24 only');
  assert.equal(f.shape, 'tilt');
  assert.equal(f.channel, 'mid');
  assert.equal(f.solo, true);
  assert.equal(g.shape, 'bell', 'unknown shape falls back to bell');
  assert.equal(h.shape, 'bandpass');
});

test('Dynamic EQ validation: types, knee, channel, sidechain and lookahead are clamped; 8 bands max', () => {
  const v = validateProcessorParams('dynamic-eq', {
    bands: Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`, enabled: true, freq: 1000, q: 2, thresholdDb: -20, maxCutDb: -3, attackMs: 10, releaseMs: 100,
      type: i === 0 ? 'baxandall-treble' : i === 1 ? 'nope' : 'bell',
      kneeDb: i === 0 ? 99 : undefined,
      channel: i === 0 ? 'side' : i === 1 ? 'centre' : undefined,
      sidechain: i === 0 ? { mode: 'custom', freq: 50000, q: 0 } : undefined,
      lookaheadMs: i === 0 ? 50 : undefined,
    })),
  }) as DynamicEQParams;
  assert.equal(v.bands.length, 8);
  const [a, b] = v.bands;
  assert.equal(a.type, 'baxandall-treble');
  assert.equal(a.kneeDb, 24);
  assert.equal(a.channel, 'side');
  assert.deepEqual(a.sidechain, { mode: 'custom', freq: 20000, q: 0.3 });
  assert.equal(a.lookaheadMs, 10);
  assert.equal(b.type, undefined);
  assert.equal(b.channel, undefined);
  assert.equal(b.kneeDb, undefined);
});

test('AI paramsJson with the new EQ fields parses through the strategy normaliser', () => {
  const eqParams = {
    phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, autoGain: true,
    bands: [
      { id: 'b1', enabled: true, shape: 'highpass', subtype: 'flat', slope: 24, channel: 'side', freq: 120, gain: 0, q: 0.71 },
      { id: 'b2', enabled: true, shape: 'bell', subtype: 'proportional', channel: 'mid', freq: 3200, gain: 1.5, q: 1.1 },
      { id: 'b3', enabled: true, shape: 'highshelf', subtype: 'vintage', freq: 12000, gain: 1, q: 0.7 },
    ],
  };
  const deqParams = { bands: [
    { id: 'd1', enabled: true, type: 'proportional', freq: 3500, q: 3, thresholdDb: -24, maxCutDb: -4, ratio: 3, mode: 'cut', kneeDb: 6, attackMs: 3, releaseMs: 80, channel: 'mid', sidechain: { mode: 'custom', freq: 7000, q: 2 }, lookaheadMs: 2 },
  ] };
  const res = normalizeStrategyResponse({
    genre: 'pop', processors: [
      { type: 'parametric-eq', name: 'EQ', intensity: 100, wetDry: 100, reason: 'tone', paramsJson: JSON.stringify(eqParams) },
      // Some providers return an object instead of a JSON string.
      { type: 'dynamic-eq', name: 'DEQ', intensity: 100, wetDry: 100, reason: 'harsh', paramsJson: deqParams },
      { type: 'limiter', name: 'Lim', intensity: 100, wetDry: 100, reason: 'ceiling', paramsJson: '{}' },
    ],
  }, { mode: 'ai-auto' });
  const eq = res.chain[0].params as ParametricEQParams;
  assert.equal(eq.autoGain, true);
  assert.deepEqual(eq.bands.map((b) => [b.subtype, b.slope, b.channel]), [['flat', 24, 'side'], ['proportional', undefined, 'mid'], ['vintage', undefined, undefined]]);
  const deq = res.chain[1].params as DynamicEQParams;
  assert.equal(deq.bands[0].type, 'proportional');
  assert.equal(deq.bands[0].kneeDb, 6);
  assert.equal(deq.bands[0].channel, 'mid');
  assert.deepEqual(deq.bands[0].sidechain, { mode: 'custom', freq: 7000, q: 2 });
  assert.equal(deq.bands[0].lookaheadMs, 2);
});

test('AI output with non-finite EQ values is still rejected', () => {
  assert.throws(() => normalizeStrategyResponse({ processors: [
    { type: 'parametric-eq', name: 'EQ', intensity: 100, wetDry: 100, reason: 'x', paramsJson: '{"bands":[{"id":"b","shape":"bell","subtype":"proportional","freq":1e999,"gain":1,"q":1}]}' },
  ] }, { mode: 'ai-auto' }));
});

test('the system prompt documents the new EQ and Dynamic EQ fields', () => {
  for (const token of ['"subtype"', 'proportional', 'band-shelf', 'baxandall', 'vintage', 'brickwall', '"slope"', '"channel"', 'autoGain', 'baxandall-treble', 'kneeDb', 'sidechain', 'lookaheadMs']) {
    assert.ok(SYSTEM_PROMPT.includes(token), token);
  }
});

test('validateChain round-trips a saved extended EQ unchanged', () => {
  const saved = [{ type: 'parametric-eq', id: 'eq1', name: 'EQ', enabled: true, bypassed: false, intensity: 100, wetDry: 100, inputGainDb: 0, outputGainDb: -1.5, expanded: false, params: {
    phaseMode: 'linear', msMode: 'mid-side', tiltDb: 0.5, autoGain: true,
    bands: [{ id: 'b1', enabled: true, shape: 'lowpass', subtype: 'resonant', slope: 36, channel: 'right', freq: 15000, gain: 0, q: 1.2 }],
  } }];
  const once = validateChain(saved);
  const twice = validateChain(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
  assert.equal(once[0].outputGainDb, -1.5);
});
