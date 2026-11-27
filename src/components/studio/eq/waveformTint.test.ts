import test from 'node:test';
import assert from 'node:assert/strict';
import { loudnessT, meshBlobs, meshColor, meshGlowStops, meshHueStops, meshRate, MESH_PALETTE, MESH_MIN_VISIBLE_CYCLES, tintColor, tintStops, TINT_CEIL_DB, TINT_FLOOR_DB } from './waveformTint';
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
  assert.match(tint, /data-waveform-mesh="neon"/);
  assert.match(tint, /clip-path="url\(#u-mclip\)"/, 'mesh is clipped to the waveform shape');
  assert.match(tint, /mask="url\(#u-mglowm\)"/, 'loudness glow mask applied');
  assert.match(tint, /mask="url\(#u-medgem\)"/, 'center-to-peak hue layer');
  assert.doesNotMatch(tint, /blur|filter=|<animate/, 'no blur, no animation (phones, reduced motion)');
  const hues = new Set([...tint.matchAll(/id="u-mcore"[\s\S]*?<\/linearGradient>/g)][0][0].match(/rgb\(\d+,\d+,\d+\)/g));
  assert.ok(hues.size >= 12, `many neon hues along time (got ${hues.size})`);
  const glow = [...[...tint.matchAll(/id="u-mglow"[\s\S]*?<\/linearGradient>/g)][0][0].matchAll(/stop-opacity="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(glow[0] < glow[glow.length - 1], 'quiet half is dimmer than the loud half');
  assert.match(tint, /data-mesh-blob="0"/, 'glow blob on the loud part');
  const silent = renderToStaticMarkup(React.createElement('svg', null, React.createElement(LoudnessTint, {
    uid: 's', d: 'M0,120 Z', env: new Array(200).fill(0), view: { start: 0, end: 60 }, durationSec: 60, source: null, scaleByFades: false,
  })));
  assert.doesNotMatch(silent, /data-mesh-blob/, 'silent track: no glow blobs');
  const noEnv = renderToStaticMarkup(React.createElement('svg', null, React.createElement(LoudnessTint, {
    uid: 'n', d: 'M0,120 Z', env: [], view: { start: 0, end: 1 }, durationSec: 0, source: null, scaleByFades: false,
  })));
  assert.equal(noEnv, '<svg></svg>', 'no track loaded: nothing drawn, no crash');
  const label = renderToStaticMarkup(React.createElement(FadeLabel, { side: 'in', fades: { inSec: 2, outSec: 0, inCurve: 'linear', outCurve: 'linear' }, durationSec: 60, view: { start: 0, end: 60 }, svg: null }));
  assert.equal(label, '', 'no label without a mounted graph');
});

test('neon mesh: smooth cyclic palette, hues pinned to time, zoom keeps several hues, glow/blobs follow loudness', () => {
  const rgb = (c: string) => c.match(/\d+/g)!.map(Number);
  assert.equal(meshColor(0), `rgb(${MESH_PALETTE[0].join(',')})`, 'starts on hot pink');
  assert.equal(meshColor(1), meshColor(0), 'cyclic');
  assert.equal(meshColor(-0.25), meshColor(0.75), 'negative phases wrap');
  assert.equal(meshColor(NaN), meshColor(0));
  // Smooth: no jump bigger than a small step anywhere around the cycle (no banding).
  let prev = rgb(meshColor(0));
  for (let i = 1; i <= 600; i++) {
    const c = rgb(meshColor(i / 600));
    assert.ok(Math.max(...c.map((v, j) => Math.abs(v - prev[j]))) <= 12, `smooth at ${i}`);
    prev = c;
  }
  // Pinned to time: the same second gets the same color in different windows (same zoom).
  const a = meshHueStops({ start: 10, end: 40 }, 120, 31);
  const b = meshHueStops({ start: 20, end: 50 }, 120, 31);
  assert.equal(a[10].color, b[0].color, 'panning moves colors with the audio');
  assert.equal(a.length, 31);
  assert.equal(a[0].offset, 0);
  assert.equal(a[30].offset, 1);
  // Deep zoom still spans at least MESH_MIN_VISIBLE_CYCLES of the palette.
  assert.ok(meshRate(0.5, 300) * 0.5 >= MESH_MIN_VISIBLE_CYCLES - 1e-9);
  assert.ok(new Set(meshHueStops({ start: 100, end: 100.5 }, 300, 32).map((s) => s.color)).size >= 20, 'zoomed window keeps many hues');
  // Edge layer differs from the core layer (2D mesh, not a 1D strip).
  const core = meshHueStops({ start: 0, end: 60 }, 60, 16, 0);
  const edge = meshHueStops({ start: 0, end: 60 }, 60, 16, 0.5);
  assert.ok(core.every((s, i) => s.color !== edge[i].color));
  // No duration (no track): finite, valid stops.
  assert.ok(meshHueStops({ start: NaN, end: NaN }, 0, 8).every((s) => /^rgb\(\d+,\d+,\d+\)$/.test(s.color)));
  // Glow: quiet dim, loud bright, bounded.
  const lv = Array.from({ length: 400 }, (_, i) => (i < 200 ? 0.003 : 0.4));
  const g = meshGlowStops(lv, 64);
  assert.equal(g.length, 64);
  assert.ok(g.every((s) => s.opacity >= 0.38 && s.opacity <= 1));
  assert.equal(g[0].opacity, 0.38);
  assert.ok(g[63].opacity > 0.9);
  assert.deepEqual(meshGlowStops([], 64), []);
  // Blobs: on loud, separated moments; none for silence.
  const bl = meshBlobs(Array.from({ length: 300 }, (_, i) => (i === 50 || i === 250 ? 0.5 : i === 52 ? 0.49 : 0.001)), 3);
  assert.equal(bl.length, 2, 'a near-duplicate peak does not get its own blob');
  assert.ok(bl[0].x < 0.2 && bl[1].x > 0.8);
  assert.deepEqual(meshBlobs(new Array(100).fill(0), 3), []);
  assert.deepEqual(meshBlobs([], 3), []);
});
