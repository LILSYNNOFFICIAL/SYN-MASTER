import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessorModule, createDefaultParams } from './chainValidation';
import { renderMixedChain } from './mixedChainRenderer';
import type { DynamicEQParams, ParametricEQParams } from '../types/mastering';

// Round 3 · G: the console's Dynamic EQ tab only adds the existing 'dynamic-eq' module to the
// chain. These checks prove that module reaches the export renderer (renderMixedChain is the
// function the Export path calls) and that the default chain is unchanged when it is absent.

function tone(sr: number, sec: number, f: number, amp: number): Float32Array[] {
  const n = Math.floor(sr * sec);
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = amp * Math.sin((2 * Math.PI * f * i) / sr);
  return [l, new Float32Array(l)];
}
const rmsDb = (b: Float32Array) => {
  let s = 0;
  for (let i = 4096; i < b.length; i++) s += b[i] * b[i];
  return 10 * Math.log10(s / (b.length - 4096) + 1e-24);
};

test('Dynamic EQ module cuts a loud band in the export render', async () => {
  const sr = 48000;
  const src = tone(sr, 1, 1000, 0.5);
  const params: DynamicEQParams = { bands: [{ id: 'd1', enabled: true, freq: 1000, q: 2, thresholdDb: -30, maxCutDb: -6, attackMs: 5, releaseMs: 100 }] };
  const deq = createProcessorModule('dynamic-eq', { params });
  const out = await renderMixedChain(src, sr, [deq], undefined);
  const cut = rmsDb(src[0]) - rmsDb(out.channels[0]);
  assert.ok(cut > 2, `expected a cut of a few dB at 1 kHz, got ${cut.toFixed(2)} dB`);
});

test('Default chain without Dynamic EQ is bit-identical (feature is default-off)', async () => {
  const sr = 48000;
  const src = tone(sr, 0.5, 440, 0.3);
  const eq = createProcessorModule('parametric-eq', { params: createDefaultParams('parametric-eq') as ParametricEQParams });
  const a = await renderMixedChain(src, sr, [eq], undefined);
  const b = await renderMixedChain(src, sr, [eq], undefined);
  assert.deepEqual(Array.from(a.channels[0].subarray(0, 2000)), Array.from(b.channels[0].subarray(0, 2000)));
  const bypassed = createProcessorModule('dynamic-eq', { bypassed: true });
  const c = await renderMixedChain(src, sr, [eq, bypassed], undefined);
  assert.deepEqual(Array.from(c.channels[0]), Array.from(a.channels[0]), 'a bypassed Dynamic EQ must not change the output');
});
