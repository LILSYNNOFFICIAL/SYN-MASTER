import test from 'node:test';
import assert from 'node:assert/strict';
import { detectClicks } from './clickDetect';
import { applyRepair } from './repair';

const SR = 48000;

/** Tonal bed + noisy snare/hat hits with instant attack + zero-attack kick, faded at the edges. */
function makeDrumMix(seconds = 4): Float32Array[] {
  const n = SR * seconds;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0.12 * Math.sin(2 * Math.PI * 110 * t) + 0.05 * Math.sin(2 * Math.PI * 660 * t);
    const beat = t % 0.5;
    const half = (t + 0.25) % 0.5;
    v += 0.5 * Math.exp(-beat * 30) * Math.sin(2 * Math.PI * 55 * beat); // zero-attack kick
    v += 0.35 * Math.exp(-half * 40) * rnd(); // snare-like noise hit, instant attack
    v += 0.08 * Math.exp(-((t + 0.125) % 0.25) * 120) * rnd(); // hats
    const edge = Math.min(1, t / 0.01, (seconds - t) / 0.01);
    L[i] = v * edge;
    R[i] = v * edge * 0.97;
  }
  return [L, R];
}

test('Click detector ignores drum, snare and hat onsets in a clean mix', () => {
  const clean = makeDrumMix();
  const original = clean.map((channel) => new Float32Array(channel));
  const det = detectClicks(clean, SR);
  assert.equal(det.clickCount, 0, `false positives at ${det.clickTimesSec.join(', ')}`);
  applyRepair(clean[0], clean[1], SR, { declick: 80 });
  for (let channel = 0; channel < clean.length; channel++) {
    assert.deepEqual(clean[channel], original[channel], 'clean musical transients must not trigger repair');
  }
});

test('Click detector finds inserted single-sample clicks between hits; de-click removes them and leaves onsets alone', () => {
  const [L, R] = makeDrumMix();
  const original = [new Float32Array(L), new Float32Array(R)];
  const at = [0.61, 1.37, 2.83];
  for (const t of at) {
    const i = Math.round(t * SR);
    L[i] += 0.3;
    R[i] += 0.3;
  }
  const det = detectClicks([L, R], SR);
  assert.equal(det.clickCount, at.length, `found ${det.clickTimesSec.join(', ')}`);
  applyRepair(L, R, SR, { declick: 80 });
  assert.equal(detectClicks([L, R], SR).clickCount, 0);
  // Away from the clicks the audio is untouched (onsets were not smoothed).
  let changed = 0;
  for (let i = 0; i < L.length; i++) {
    const nearClick = at.some((t) => Math.abs(i - t * SR) < SR * 0.004);
    if (!nearClick && Math.abs(L[i] - original[0][i]) > 1e-6) changed++;
  }
  assert.equal(changed, 0, `${changed} samples changed away from the clicks`);
});

test('stereo de-click uses a shared repair window and preserves continuity at its boundaries', () => {
  const left = new Float32Array(SR);
  const right = new Float32Array(SR);
  for (let i = 0; i < SR; i++) {
    const sample = 0.12 * Math.sin((2 * Math.PI * 440 * i) / SR);
    left[i] = sample;
    right[i] = sample;
  }
  const original = new Float32Array(left);
  const clickAt = Math.floor(SR * 0.5);
  left[clickAt] += 0.55;
  right[clickAt + 2] += 0.42;
  const before = detectClicks([left, right], SR);
  assert.ok(before.clickCount >= 1);
  const beforeDiscontinuity = Math.max(
    Math.abs(left[clickAt] - 2 * left[clickAt - 1] + left[clickAt - 2]),
    Math.abs(right[clickAt + 2] - 2 * right[clickAt + 1] + right[clickAt]),
  );

  applyRepair(left, right, SR, { declick: 80 });

  const afterDiscontinuity = Math.max(
    Math.abs(left[clickAt] - 2 * left[clickAt - 1] + left[clickAt - 2]),
    Math.abs(right[clickAt + 2] - 2 * right[clickAt + 1] + right[clickAt]),
  );
  assert.ok(afterDiscontinuity < beforeDiscontinuity * 0.1);
  assert.equal(detectClicks([left, right], SR).clickCount, 0);

  let maxBoundaryStep = 0;
  for (let i = clickAt - 80; i <= clickAt + 80; i++) {
    maxBoundaryStep = Math.max(maxBoundaryStep, Math.abs(left[i] - left[i - 1]));
    assert.ok(Math.abs(left[i] - right[i]) < 1e-6, 'same stereo repair window preserves the centered image');
  }
  assert.ok(maxBoundaryStep < 0.04, `repair boundary step ${maxBoundaryStep} should remain continuous`);
  for (let i = 0; i < left.length; i++) {
    if (Math.abs(i - clickAt) > SR * 0.004) assert.equal(left[i], original[i]);
  }
});

test('stereo edge clicks at file start and end are repaired locally without changing the middle', () => {
  const left = new Float32Array(SR);
  const right = new Float32Array(SR);
  for (let i = 0; i < SR; i++) {
    const edge = Math.min(1, i / (SR * 0.01), (SR - 1 - i) / (SR * 0.01));
    const sample = edge * 0.12 * Math.sin((2 * Math.PI * 440 * i) / SR);
    left[i] = sample;
    right[i] = sample;
  }
  left[0] += 0.8;
  right[SR - 1] -= 0.8;
  const unaffected = new Float32Array(left);
  unaffected.set(right.subarray(SR / 2), SR / 2);
  const before = detectClicks([left, right], SR);
  assert.equal(before.startClick, true);
  assert.equal(before.endClick, true);
  assert.ok(before.startStep > 0.5 && before.endStep > 0.5);

  applyRepair(left, right, SR, { declick: 80 });

  const after = detectClicks([left, right], SR);
  assert.equal(after.startClick, false);
  assert.equal(after.endClick, false);
  assert.ok(after.startStep < before.startStep * 0.1);
  assert.ok(after.endStep < before.endStep * 0.1);
  for (let i = SR * 0.02; i < SR * 0.48; i++) {
    assert.equal(left[i], unaffected[i]);
  }
  for (let i = SR * 0.52; i < SR * 0.98; i++) {
    assert.equal(right[i], unaffected[i]);
  }
  for (let i = 0; i < SR; i++) assert.equal(left[i], right[i], 'edge repairs preserve stereo coherence');
});

test('Dither module quantizes to the chosen word length, deterministically, and blanks digital silence', async () => {
  const { processChainOffline } = await import('./offlineDsp');
  const { createProcessorModule } = await import('./chainValidation');
  const n = SR;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = SR / 2; i < n; i++) { L[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR); R[i] = L[i]; }
  const dither = createProcessorModule('dither');
  dither.params = { bitDepth: 16, shape: 'shaped', autoBlank: true };
  const a = processChainOffline([L, R], SR, [dither]).channels;
  const b = processChainOffline([L, R], SR, [dither]).channels;
  const q = 1 / 32768;
  for (let i = 0; i < n; i += 97) {
    assert.ok(Math.abs(a[0][i] / q - Math.round(a[0][i] / q)) < 1e-6, 'sample on the 16-bit grid');
    assert.equal(a[0][i], b[0][i], 'deterministic');
  }
  for (let i = 0; i < SR / 2; i++) assert.equal(a[0][i], 0, 'silence stays silent');
  let errSq = 0;
  for (let i = SR / 2; i < n; i++) errSq += (a[0][i] - L[i]) ** 2;
  const errDb = 10 * Math.log10(errSq / (n / 2));
  assert.ok(errDb < -80 && errDb > -110, `dither/requantization noise ${errDb.toFixed(1)} dBFS`);
});

test('filterIntroducedClicks separates amplified source transients from clicks the master added', async () => {
  const { filterIntroducedClicks } = await import('./clickDetect');
  const src = makeDrumMix(2);
  const out = src.map((ch) => ch.map((v) => v * 2));
  const tOnset = 0.25; // snare-like hit in the source
  const tNew = 1.111;
  const i = Math.round(tNew * SR);
  out[0][i] += 0.5;
  out[1][i] += 0.5;
  const split = filterIntroducedClicks(src, out, SR, [tOnset, tNew], 2);
  assert.deepEqual(split.preexisting, [tOnset]);
  assert.deepEqual(split.introduced, [tNew]);
});


test('shared rendered-click analysis removes amplified source transients without mutating the render report', async () => {
  const { filterSourceTransientClickAnalysis } = await import('./clickDetect');
  const source = makeDrumMix(2);
  const rendered = source.map((channel) => channel.map((sample) => sample * 2));
  const sourceTransient = 0.25;
  const introducedClick = 1.111;
  const index = Math.round(introducedClick * SR);
  rendered[0][index] += 0.5;
  rendered[1][index] += 0.5;

  const clickTimesSec = [sourceTransient, introducedClick];
  const renderedAnalysis = {
    durationSec: 2,
    integratedLufs: -9,
    clickCount: 2,
    clickTimesSec,
    clicksPerMinute: 60,
    clickAtStart: false,
    clickAtEnd: false,
  } as unknown as import('../types/mastering').AudioAnalysis;
  const sourceAnalysis = {
    integratedLufs: -15,
  } as unknown as import('../types/mastering').AudioAnalysis;

  const filtered = filterSourceTransientClickAnalysis(
    source, rendered, SR, sourceAnalysis, renderedAnalysis,
  );

  assert.equal(filtered.clickCount, 1);
  assert.deepEqual(filtered.clickTimesSec, [introducedClick]);
  assert.equal(filtered.clicksPerMinute, 30);
  assert.deepEqual(renderedAnalysis.clickTimesSec, [sourceTransient, introducedClick]);
});

test('shared rendered-click analysis never forgives a file-edge click', async () => {
  const { filterSourceTransientClickAnalysis } = await import('./clickDetect');
  const source = makeDrumMix(2);
  const rendered = source.map((channel) => new Float32Array(channel));
  rendered[0][0] += 0.5;
  const renderedAnalysis = {
    durationSec: 2,
    integratedLufs: -15,
    clickCount: 1,
    clickTimesSec: [0.001],
    clicksPerMinute: 30,
    clickAtStart: true,
    clickAtEnd: false,
  } as unknown as import('../types/mastering').AudioAnalysis;
  const sourceAnalysis = {
    integratedLufs: -15,
  } as unknown as import('../types/mastering').AudioAnalysis;

  const filtered = filterSourceTransientClickAnalysis(
    source, rendered, SR, sourceAnalysis, renderedAnalysis,
  );

  assert.equal(filtered, renderedAnalysis);
  assert.equal(filtered.clickCount, 1);
  assert.equal(filtered.clickAtStart, true);
});
