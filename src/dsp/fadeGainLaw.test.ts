import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFades, fadeGain, type FadeCurve } from './fades';
import { processChainOffline } from './offlineDsp';
import { renderMixedChain } from './mixedChainRenderer';
import { createDefaultParams, createProcessorModule } from './chainValidation';
import type { LimiterParams } from '../types/mastering';

const SR = 48000;
const CURVES: FadeCurve[] = ['linear', 'exp', 'scurve'];
const MID: Record<FadeCurve, number> = { linear: 0.5, exp: 0.125, scurve: 0.5 };
const QUARTER: Record<FadeCurve, number> = { linear: 0.25, exp: 0.015625, scurve: 0.103515625 };

for (const curve of CURVES) {
  test(`${curve} fade: constant signal hits true silence, exact midpoints and sample-accurate edges`, () => {
    const n = 9600;
    const inN = 2400; // 0.05 s
    const outN = 1200; // 0.025 s
    const src = new Float32Array(n).fill(0.5);
    const [out] = applyFades([src], SR, { inSec: inN / SR, outSec: outN / SR, inCurve: curve, outCurve: curve });
    // Fade-in
    assert.equal(out[0], 0, 'fade-in starts at exactly 0 (silence)');
    assert.ok(Math.abs(out[inN / 2] - 0.5 * MID[curve]) < 1e-7, 'fade-in midpoint follows the gain law');
    assert.ok(Math.abs(out[inN / 4] - 0.5 * QUARTER[curve]) < 1e-7, 'fade-in quarter point follows the gain law');
    assert.ok(out[inN - 1] <= 0.5 && fadeGain((inN - 1) / inN, curve) < 1, 'last fade-in sample is still inside the fade (S-curve may round to full scale in float32)');
    assert.equal(out[inN], 0.5, 'first sample after the fade-in is untouched (sample-accurate)');
    // Fade-out (mirror image)
    assert.equal(out[n - 1], 0, 'fade-out ends at exactly 0 (silence)');
    assert.ok(Math.abs(out[n - 1 - outN / 2] - 0.5 * MID[curve]) < 1e-7, 'fade-out midpoint follows the gain law');
    assert.ok(Math.abs(out[n - 1 - outN / 4] - 0.5 * QUARTER[curve]) < 1e-7, 'fade-out quarter point follows the gain law');
    assert.ok(out[n - outN] <= 0.5 && fadeGain((outN - 1) / outN, curve) < 1, 'first fade-out sample is inside the fade');
    assert.equal(out[n - outN - 1], 0.5, 'last sample before the fade-out is untouched (sample-accurate)');
    for (let i = 1; i < inN; i++) assert.ok(out[i] >= out[i - 1], 'fade-in is monotonic');
    for (let i = n - outN; i < n; i++) assert.ok(out[i] <= out[i - 1], 'fade-out is monotonic');
  });
}

test('fades land after the limiter and the export renderer matches the preview renderer exactly', async () => {
  const n = SR; // 1 s of a hot tone the limiter must work on
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = r[i] = 0.95 * Math.sin(2 * Math.PI * 220 * (i / SR));
  const limiter = createDefaultParams('limiter') as LimiterParams;
  const chain = [createProcessorModule('limiter', { id: 'lim', params: limiter, inputGainDb: 6 })];
  for (const curve of CURVES) {
    const fades = { inSec: 0.2, outSec: 0.3, inCurve: curve, outCurve: curve };
    const preview = processChainOffline([l, r], SR, chain, fades);
    const unfaded = processChainOffline([l, r], SR, chain, null);
    const expected = applyFades(unfaded.channels, SR, fades);
    const exported = await renderMixedChain([l, r], SR, chain, undefined, fades);
    for (let c = 0; c < 2; c++) {
      assert.deepEqual(Array.from(preview.channels[c]), Array.from(expected[c]), `${curve}: fade = gain law on the limited signal (ch ${c})`);
      assert.deepEqual(Array.from(exported.channels[c]), Array.from(preview.channels[c]), `${curve}: export render == preview render (ch ${c})`);
    }
    assert.equal(Math.abs(preview.channels[0][0]), 0, 'true silence at the fade-in start');
    assert.equal(Math.abs(preview.channels[0][n - 1]), 0, 'true silence at the fade-out end');
    const inN = Math.round(0.2 * SR);
    const k = Math.round(inN / 2);
    assert.ok(Math.abs(preview.channels[0][k] - unfaded.channels[0][k] * fadeGain(0.5, curve)) < 1e-7);
  }
});
