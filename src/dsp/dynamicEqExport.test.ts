import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessorModule, createDefaultParams } from './chainValidation';
import { renderMixedChain } from './mixedChainRenderer';
import type { DynamicEQParams, ParametricEQParams } from '../types/mastering';
import { DEFAULT_EXPORT_CONFIG } from './exportDefaults';
import { encodeWavBlob } from './wavEncoder';
import { fadeGain, type FadeSettings } from './fades';

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

test('Dynamic EQ ratio 2.9:1 preserves legacy cut behavior and boost is available', async () => {
  const sr = 48000;
  const src = tone(sr, 1, 1000, 0.5);
  const legacy = createProcessorModule('dynamic-eq', {
    params: { bands: [{ id: 'd1', enabled: true, freq: 1000, q: 2, thresholdDb: -30, maxCutDb: -6, attackMs: 5, releaseMs: 100 }] } satisfies DynamicEQParams,
  });
  const explicit = createProcessorModule('dynamic-eq', {
    params: { bands: [{ id: 'd1', enabled: true, freq: 1000, q: 2, thresholdDb: -30, maxCutDb: -6, ratio: 20 / 7, mode: 'cut', attackMs: 5, releaseMs: 100 }] } satisfies DynamicEQParams,
  });
  const legacyOut = await renderMixedChain(src, sr, [legacy], undefined);
  const explicitOut = await renderMixedChain(src, sr, [explicit], undefined);
  assert.deepEqual(Array.from(explicitOut.channels[0]), Array.from(legacyOut.channels[0]), 'explicit default ratio must match legacy cut output');

  const boost = createProcessorModule('dynamic-eq', {
    params: { bands: [{ id: 'd1', enabled: true, freq: 1000, q: 2, thresholdDb: -30, maxCutDb: 6, ratio: 4, mode: 'boost', attackMs: 5, releaseMs: 100 }] } satisfies DynamicEQParams,
  });
  const boosted = await renderMixedChain(src, sr, [boost], undefined);
  assert.ok(rmsDb(boosted.channels[0]) > rmsDb(src[0]), 'boost mode must increase the loud band');
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

test('WAV export render contains Dynamic EQ processing and post-chain timeline fades', async () => {
  const sr = 48000;
  const src = tone(sr, 1, 1000, 0.5);
  const params: DynamicEQParams = {
    bands: [{ id: 'd1', enabled: true, freq: 1000, q: 2, thresholdDb: -30, maxCutDb: -6, ratio: 4, mode: 'cut', attackMs: 5, releaseMs: 100 }],
  };
  const fades: FadeSettings = { inSec: 0.1, outSec: 0.1, inCurve: 'linear', outCurve: 'linear' };
  const rendered = await renderMixedChain(src, sr, [createProcessorModule('dynamic-eq', { params })], undefined, fades);
  const withoutFades = await renderMixedChain(src, sr, [createProcessorModule('dynamic-eq', { params })]);
  const wav = new Uint8Array(await encodeWavBlob(rendered.channels, sr, {
    ...DEFAULT_EXPORT_CONFIG,
    sampleRate: sr,
    wavBitDepth: 32,
    ceilingDb: 0,
  }).arrayBuffer());
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), 'WAVE');

  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const inIndex = Math.floor(sr * 0.05);
  const outIndex = Math.floor(sr) - 1 - Math.floor(sr * 0.05);
  const encodedIn = view.getFloat32(44 + inIndex * 8, true);
  const encodedOut = view.getFloat32(44 + outIndex * 8, true);
  assert.ok(Math.abs(encodedIn - withoutFades.channels[0][inIndex] * fadeGain(0.5, 'linear')) < 1e-6, 'encoded WAV must contain the timeline fade-in');
  assert.ok(Math.abs(encodedOut - withoutFades.channels[0][outIndex] * fadeGain(0.5, 'linear')) < 1e-6, 'encoded WAV must contain the timeline fade-out');

  let sourcePower = 0;
  let renderedPower = 0;
  for (let i = Math.floor(sr * 0.4); i < Math.floor(sr * 0.6); i++) {
    const sample = view.getFloat32(44 + i * 8, true);
    sourcePower += src[0][i] ** 2;
    renderedPower += sample ** 2;
  }
  assert.ok(renderedPower < sourcePower * 0.5, 'encoded WAV must contain Dynamic EQ attenuation');
});

test('timeline fades are rendered even when the mastering rack is empty', async () => {
  const sr = 48000;
  const src = tone(sr, 1, 440, 0.3);
  const fades: FadeSettings = { inSec: 0.1, outSec: 0.1, inCurve: 'linear', outCurve: 'linear' };
  const rendered = await renderMixedChain(src, sr, [], undefined, fades);
  const inIndex = 1000;
  const outIndex = sr - 1 - 1000;
  const fadePosition = inIndex / sr / fades.inSec;

  assert.ok(
    Math.abs(rendered.channels[0][inIndex] - src[0][inIndex] * fadeGain(fadePosition, 'linear')) < 1e-6,
    'empty-rack preview must apply the fade-in',
  );
  assert.ok(
    Math.abs(rendered.channels[0][outIndex] - src[0][outIndex] * fadeGain(fadePosition, 'linear')) < 1e-6,
    'empty-rack preview must apply the fade-out',
  );
});
