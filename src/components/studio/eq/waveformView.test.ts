import test from 'node:test';
import assert from 'node:assert/strict';
import { fadeGain } from '../../../dsp/fades';
import {
  blanketPathFromEnvelope, buildPeakBlocks, clampView, envelopeFromGlobalPeaks, envelopeFromSamples, fadeGainAt,
  fadeGeometry, fullView, minViewSpan, panBy, secToX, wheelZoomFactor, xToSec, zoomAround,
} from './waveformView';
import { timelineSecondsFromPointer } from './EqGraph';

const FADES = { inSec: 2, outSec: 4, inCurve: 'scurve' as const, outCurve: 'exp' as const };

test('fade geometry follows the exact render gain law and spans the fade region', () => {
  const g = fadeGeometry('in', FADES, 100, fullView(100), 640, 240, 160)!;
  assert.ok(g, 'fade-in geometry exists');
  assert.equal(g.x0, 0);
  assert.ok(Math.abs(g.x1 - secToX(2, fullView(100), 640)) < 1e-9);
  const pts = g.line.split(' ').map((p) => p.slice(1).split(',').map(Number));
  assert.equal(pts.length, 161, 'smooth: 161 samples of the gain law');
  assert.equal(pts[0][1], 240, 'starts at silence (bottom)');
  assert.ok(Math.abs(pts[160][1] - 0) < 1e-6, 'ends at unity (top)');
  assert.ok(Math.abs(pts[80][1] - (240 - fadeGain(0.5, 'scurve') * 240)) < 0.01, 'midpoint matches the S-curve');
  assert.equal(g.stops[0].attenuation, 1, 'fully attenuated (darkest) where silent');
  assert.equal(g.stops[g.stops.length - 1].attenuation, 0, 'no shading where the fade is done');
  const o = fadeGeometry('out', FADES, 100, fullView(100), 640, 240, 160)!;
  const op = o.line.split(' ').map((p) => p.slice(1).split(',').map(Number));
  assert.ok(Math.abs(op[op.length - 1][1] - 240) < 1e-6, 'fade-out ends at silence');
  assert.ok(Math.abs(op[80][1] - (240 - fadeGain(0.5, 'exp') * 240)) < 0.01, 'fade-out midpoint matches the exp law');
});

test('fade geometry is clipped to the zoomed view and hidden when off-screen', () => {
  const v = { start: 1, end: 3 };
  const g = fadeGeometry('in', FADES, 100, v, 640, 240)!;
  assert.equal(g.x0, 0, 'visible part starts at the left edge');
  assert.ok(Math.abs(g.x1 - 320) < 1e-9, 'fade end (2 s) sits mid-screen in a 1..3 s view');
  assert.equal(fadeGeometry('out', FADES, 100, v, 640, 240), null, 'fade-out is off-screen');
});

test('fadeGainAt matches the render law at boundaries and midpoints', () => {
  assert.equal(fadeGainAt(0, 100, FADES), 0);
  assert.equal(fadeGainAt(1, 100, FADES), fadeGain(0.5, 'scurve'));
  assert.equal(fadeGainAt(50, 100, FADES), 1);
  assert.equal(fadeGainAt(98, 100, FADES), fadeGain(0.5, 'exp'));
  assert.equal(fadeGainAt(100, 100, FADES), 0);
});

test('zoom keeps the anchor under the cursor, clamps to the track and round-trips', () => {
  const full = fullView(120);
  const z = zoomAround(full, 30, 4, 120);
  assert.ok(Math.abs((z.end - z.start) - 30) < 1e-9, '4x zoom shows a quarter of the track');
  assert.ok(Math.abs((30 - z.start) / (z.end - z.start) - 0.25) < 1e-9, 'anchor stays at the same screen fraction');
  const back = zoomAround(z, 30, 1 / 4, 120);
  assert.ok(Math.abs(back.start) < 1e-9 && Math.abs(back.end - 120) < 1e-9, 'zooming back out restores the full view');
  const deep = zoomAround(full, 60, 1e9, 120);
  assert.ok(Math.abs(deep.end - deep.start - minViewSpan(120)) < 1e-9, 'zoom stops at the minimum span');
  const f = wheelZoomFactor(-120) * wheelZoomFactor(120);
  assert.ok(Math.abs(f - 1) < 1e-12, 'wheel in then out is symmetric');
  assert.deepEqual(panBy({ start: 100, end: 110 }, 50, 120), { start: 110, end: 120 }, 'pan clamps at the end');
  assert.deepEqual(clampView({ start: -5, end: 5 }, 120), { start: 0, end: 10 });
  assert.ok(Math.abs(xToSec(secToX(17, z, 640), z, 640) - 17) < 1e-9);
});

test('seeking maps the pointer through the zoomed view', () => {
  assert.equal(timelineSecondsFromPointer(150, 100, 200, 120, { start: 40, end: 60 }), 45);
  assert.equal(timelineSecondsFromPointer(150, 100, 200, 120), 30, 'no view = whole track (unchanged)');
});

test('zoomed envelope recomputes at higher resolution from the audio', () => {
  const sr = 1000;
  const n = sr * 10;
  const ch = new Float32Array(n);
  ch[5000] = 0.9; // one spike at 5.000 s
  const blocks = buildPeakBlocks([ch]);
  const coarse = envelopeFromGlobalPeaks(Array.from({ length: 10 }, (_, i) => (i === 5 ? 0.9 : 0)), 10, { start: 4.9, end: 5.1 }, 20);
  const fine = envelopeFromSamples([ch], sr, { start: 4.9, end: 5.1 }, 20, blocks);
  assert.ok(coarse.filter((v) => v > 0.5).length >= 10, 'whole-track peaks smear the spike across the zoomed window');
  assert.equal(fine.filter((v) => v > 0.5).length, 1, 'zoomed detail pins the spike to one column');
  const wide = envelopeFromSamples([ch], sr, fullView(10), 10, blocks);
  const direct = envelopeFromSamples([ch], sr, fullView(10), 10, null);
  assert.deepEqual(wide, direct, 'block pyramid gives the same peaks as a raw scan');
  assert.ok(blanketPathFromEnvelope(fine, 640, 240)?.endsWith('Z'));
});
