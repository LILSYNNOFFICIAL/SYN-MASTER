import test from 'node:test';
import assert from 'node:assert/strict';
import { measureShimmer } from './shimmerDetect';
import { applyRepair } from './repair';
import { analyzeAudioBuffer } from './analyzer';
import { buildExplainableMasterPlan } from '../director/directorEngine';
import type { RestoreParams } from '../types/mastering';

const SR = 48000;
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
}
/** Bass/keys bed with centred noisy hats and snare (natural cymbal-like HF). */
function mix(sec = 6): Float32Array[] {
  const n = SR * sec;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const rnd = rng(7);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const v = 0.2 * Math.sin(2 * Math.PI * 110 * t) + 0.1 * Math.sin(2 * Math.PI * 440 * t);
    const h = 0.12 * Math.exp(-((t + 0.125) % 0.25) * 60) * rnd();
    const sn = 0.3 * Math.exp(-((t + 0.25) % 0.5) * 25) * rnd();
    const air = 0.01 * rnd();
    L[i] = v + h + sn + air;
    R[i] = v + h * 0.95 + sn + air * 0.9;
  }
  return [L, R];
}
/** AI-style shimmer: narrow 10-15 kHz partials, side only, flickering on their own. */
function addShimmer([L, R]: Float32Array[], amp = 0.03): Float32Array[] {
  const rnd = rng(3);
  const fs = [10300, 11700, 12650, 13900, 15100];
  let g = fs.map(() => 0.5);
  for (let i = 0; i < L.length; i++) {
    if (i % 256 === 0) g = g.map((x) => Math.max(0, Math.min(1, x + rnd() * 0.45)));
    let sv = 0;
    fs.forEach((f, k) => { sv += g[k] * Math.sin((2 * Math.PI * f * i) / SR + k); });
    L[i] += sv * amp;
    R[i] -= sv * amp;
  }
  return [L, R];
}

test('Shimmer detector: clean centred cymbals score 0, side-only flickering partials are confident', () => {
  const [cl, cr] = mix();
  assert.ok(measureShimmer(cl, cr, SR).confidence < 0.2);
  const [sl, sr] = addShimmer(mix());
  assert.ok(measureShimmer(sl, sr, SR).confidence >= 0.6);
});

test('Auto engine enables de-shimmer only on a confident detection, and it lowers side HF', () => {
  const clean = buildExplainableMasterPlan({ analysis: analyzeAudioBuffer(mix(), SR), objectiveId: 'streaming' });
  const cleanRestore = clean.chain.find((m) => m.type === 'restore');
  assert.equal((cleanRestore?.params as RestoreParams | undefined)?.deShimmer ?? 0, 0);
  const shimmery = addShimmer(mix());
  const plan = buildExplainableMasterPlan({ analysis: analyzeAudioBuffer(shimmery, SR), objectiveId: 'streaming' });
  const restore = plan.chain.find((m) => m.type === 'restore');
  const amount = (restore?.params as RestoreParams | undefined)?.deShimmer ?? 0;
  assert.ok(amount >= 30, `deShimmer ${amount}`);
  const before = measureShimmer(shimmery[0], shimmery[1], SR).sideHfRatio;
  const out = [new Float32Array(shimmery[0]), new Float32Array(shimmery[1])];
  applyRepair(out[0], out[1], SR, { deShimmer: amount });
  const after = measureShimmer(out[0], out[1], SR).sideHfRatio;
  assert.ok(10 * Math.log10(after / before) <= -1, `side HF ${before} -> ${after}`);
});
