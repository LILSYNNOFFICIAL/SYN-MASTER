import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFades, fadeGain, type FadeSettings } from './fades';

test('S-curve fade has zero-slope endpoints and a monotonic midpoint', () => {
  assert.equal(fadeGain(0, 'scurve'), 0);
  assert.equal(fadeGain(1, 'scurve'), 1);
  assert.ok(Math.abs(fadeGain(0.5, 'scurve') - 0.5) < 1e-12);
  assert.ok(fadeGain(0.01, 'scurve') < 0.001);
  assert.ok(fadeGain(0.99, 'scurve') > 0.999);
  let previous = 0;
  for (let i = 1; i <= 100; i++) {
    const current = fadeGain(i / 100, 'scurve');
    assert.ok(current >= previous, 'fade gain must be monotonic');
    previous = current;
  }
});

test('track fades smoothly attenuate only the configured start and end regions', () => {
  const source = new Float32Array(4800).fill(0.5);
  const fades: FadeSettings = { inSec: 0.01, outSec: 0.01, inCurve: 'scurve', outCurve: 'scurve' };
  const [rendered] = applyFades([source], 48000, fades);
  assert.equal(rendered[0], 0);
  assert.equal(rendered[rendered.length - 1], 0);
  assert.ok(Math.abs(rendered[2400] - 0.5) < 1e-6, 'middle of the track must remain untouched');
  assert.ok(rendered[1] < rendered[120], 'fade-in must rise smoothly');
  assert.ok(rendered[rendered.length - 2] < rendered[rendered.length - 120], 'fade-out must fall smoothly');
  assert.equal(source[0], 0.5, 'copy-based fade must not mutate the source audio');
});
