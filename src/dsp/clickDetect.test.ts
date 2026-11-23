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
  const det = detectClicks(makeDrumMix(), SR);
  assert.equal(det.clickCount, 0, `false positives at ${det.clickTimesSec.join(', ')}`);
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
