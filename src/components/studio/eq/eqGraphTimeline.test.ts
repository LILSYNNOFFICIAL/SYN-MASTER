import assert from 'node:assert/strict';
import test from 'node:test';
import { timelineSecondsFromPointer } from './EqGraph';

test('maps the shared waveform canvas horizontal position to linear track time', () => {
  assert.equal(timelineSecondsFromPointer(150, 100, 200, 120), 30);
  assert.equal(timelineSecondsFromPointer(200, 100, 200, 120), 60);
});

test('clamps waveform seeking to the start and end of the track', () => {
  assert.equal(timelineSecondsFromPointer(50, 100, 200, 120), 0);
  assert.equal(timelineSecondsFromPointer(400, 100, 200, 120), 120);
});

test('returns zero for invalid canvas geometry or track duration', () => {
  assert.equal(timelineSecondsFromPointer(100, 0, 0, 120), 0);
  assert.equal(timelineSecondsFromPointer(100, 0, 100, 0), 0);
  assert.equal(timelineSecondsFromPointer(Number.NaN, 0, 100, 120), 0);
});
