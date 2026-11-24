import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWaveformOverlayPoints } from './waveformOverlay';

test('maps normalized audio peaks into a centered waveform envelope', () => {
  assert.deepEqual(buildWaveformOverlayPoints([0, 0.5, 1], 100, 50, 20), [
    { x: 0, top: 50, bottom: 50 },
    { x: 50, top: 40, bottom: 60 },
    { x: 100, top: 30, bottom: 70 },
  ]);
});

test('bounds invalid amplitudes and returns no points for invalid geometry', () => {
  const points = buildWaveformOverlayPoints([-2, Number.NaN, 2], 3, 10, 5);
  assert.deepEqual(points, [
    { x: 0, top: 5, bottom: 15 },
    { x: 1.5, top: 10, bottom: 10 },
    { x: 3, top: 5, bottom: 15 },
  ]);
  assert.deepEqual(buildWaveformOverlayPoints([1], 0, 10, 5), []);
  assert.deepEqual(buildWaveformOverlayPoints([], 10, 10, 5), []);
});
