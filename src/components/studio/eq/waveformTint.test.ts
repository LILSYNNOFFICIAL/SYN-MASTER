import test from 'node:test';
import assert from 'node:assert/strict';
import { loudnessT, tintColor, tintStops, TINT_CEIL_DB, TINT_FLOOR_DB } from './waveformTint';
import { buildEnergyBlocks, rmsFromSamples } from './waveformDetail';
import { fullView } from './waveformView';

test('loudness tint: silence is cool, loud is hot, monotonic and clamped', () => {
  assert.equal(loudnessT(0), 0);
  assert.equal(loudnessT(NaN), 0);
  assert.equal(loudnessT(-1), 0);
  assert.equal(loudnessT(10 ** (TINT_FLOOR_DB / 20)), 0);
  assert.equal(loudnessT(1), 1);
  assert.ok(Math.abs(loudnessT(10 ** (TINT_CEIL_DB / 20)) - 1) < 1e-9);
  let prev = -1;
  for (let db = -60; db <= 0; db += 1) {
    const t = loudnessT(10 ** (db / 20));
    assert.ok(t >= prev, `monotonic at ${db} dB`);
    prev = t;
  }
  assert.equal(tintColor(0), 'rgb(46,120,255)', 'quiet = cool blue');
  assert.equal(tintColor(1), 'rgb(245,196,81)', 'loudest = gold');
  assert.equal(tintColor(0.78), 'rgb(224,64,251)', 'loud = hot magenta');
  assert.equal(tintColor(Infinity), tintColor(0));
});

test('loudness tint stops: bounded count, loudest column wins, silent track stays blue', () => {
  const levels = Array.from({ length: 480 }, (_, i) => (i === 300 ? 0.5 : 0.001));
  const stops = tintStops(levels, 96);
  assert.equal(stops.length, 96);
  assert.equal(stops[0].offset, 0);
  assert.equal(stops[95].offset, 1);
  assert.ok(stops.some((s) => s.color !== 'rgb(46,120,255)'), 'a short loud hit survives downsampling');
  const silent = tintStops(new Array(480).fill(0), 96);
  assert.ok(silent.every((s) => s.color === 'rgb(46,120,255)' && s.opacity === 0.3));
  assert.deepEqual(tintStops([], 96), []);
  for (const s of stops) assert.ok(s.opacity >= 0.3 && s.opacity <= 0.6);
});

test('RMS per column: sine RMS = amplitude/sqrt(2); energy blocks match a raw scan', () => {
  const sr = 8000;
  const n = sr * 4;
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = (i < n / 2 ? 0.1 : 0.8) * Math.sin((2 * Math.PI * 440 * i) / sr);
  const energy = buildEnergyBlocks([l, l]);
  const fast = rmsFromSamples([l, l], sr, fullView(4), 8, energy);
  const raw = rmsFromSamples([l, l], sr, fullView(4), 8, null);
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(fast[i] - raw[i]) < 1e-4, `col ${i}`);
  assert.ok(Math.abs(raw[0] - 0.1 / Math.SQRT2) < 2e-3);
  assert.ok(Math.abs(raw[7] - 0.8 / Math.SQRT2) < 2e-3);
  assert.ok(loudnessT(raw[7]) > loudnessT(raw[0]));
  // Zoomed far in (window smaller than one block) still returns finite values.
  const zoom = rmsFromSamples([l, l], sr, { start: 3, end: 3.01 }, 20, energy);
  assert.equal(zoom.length, 20);
  assert.ok(zoom.every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  assert.deepEqual(rmsFromSamples([new Float32Array(0)], sr, fullView(1), 4, null), [0, 0, 0, 0]);
});

test('lazy layers render: frequency-colored neon fill fading down, loudness tint, fade label hidden without a graph', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { NeonFill, LoudnessTint, FadeLabel } = await import('./waveformLayers');
  const fill = renderToStaticMarkup(React.createElement('svg', null, React.createElement(NeonFill, { uid: 'u', d: 'M0,240 L320,80 L640,240 Z' })));
  assert.match(fill, /data-neon-fill="freq"/);
  assert.match(fill, /#C2189B/i, 'deep magenta lows');
  assert.match(fill, /#3FE0FF/i, 'cyan highs');
  assert.match(fill, /#F5C451/i, 'gold top end');
  assert.match(fill, /mask="url\(#u-nfm\)"/, 'fades to transparent toward the bottom');
  assert.doesNotMatch(fill, /blur|filter=/, 'no blur filter (cheap on phones)');
  const env = Array.from({ length: 200 }, (_, i) => (i < 100 ? 0.02 : 0.95));
  const tint = renderToStaticMarkup(React.createElement('svg', null, React.createElement(LoudnessTint, {
    uid: 'u', d: 'M0,120 Z', env, view: { start: 0, end: 60 }, durationSec: 60, source: null, scaleByFades: false,
  })));
  assert.match(tint, /data-waveform-tint="loudness"/);
  assert.match(tint, /rgb\(46,120,255\)/, 'quiet half is cool blue');
  assert.doesNotMatch(tint, /stop-color="rgb\(46,120,255\)"[^>]*offset="1/, 'loud end is not blue');
  const label = renderToStaticMarkup(React.createElement(FadeLabel, { side: 'in', fades: { inSec: 2, outSec: 0, inCurve: 'linear', outCurve: 'linear' }, durationSec: 60, view: { start: 0, end: 60 }, svg: null }));
  assert.equal(label, '', 'no label without a mounted graph');
});
