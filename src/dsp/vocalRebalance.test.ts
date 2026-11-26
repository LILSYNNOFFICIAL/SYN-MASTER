import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessorModule, validateChain, validateProcessorParams } from './chainValidation';
import { processChainOffline } from './offlineDsp';
import { renderMixedChain } from './mixedChainRenderer';
import { createDspWorkerClient, rebalanceStemsForRender } from './workerClient';
import { encodeWavBlob } from './wavEncoder';
import { DEFAULT_EXPORT_CONFIG } from './exportDefaults';
import {
  applyVocalRebalance,
  fingerprintStereo,
  getRebalanceStems,
  registerRebalanceStems,
  sanitizeVocalRebalanceParams,
  unregisterRebalanceStems,
  type RebalanceStemSet,
} from './vocalRebalance';
import type { ExportConfig, LimiterParams, ProcessorModule, VocalRebalanceParams } from '../types/mastering';

// Vocal Rebalance: 0 dB is bit-exact pass-through, the phase-preserving gain maths
// (out = mix + (g - 1) * stem) is exact on synthetic stems, parameters clamp, and the export
// path renders the same audio as the preview / Fix-All worker path (stems synced to the worker).

const SR = 48000;
const N = Math.floor(SR * 1.2);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

/** Synthetic "stems": vocal (gated 440 Hz + harmonics), bass (55 Hz), drums (noise bursts), other (pad). */
function makeStems(): { mix: [Float32Array, Float32Array]; set: RebalanceStemSet; other: [Float32Array, Float32Array] } {
  const noise = rng(7);
  const mk = () => [new Float32Array(N), new Float32Array(N)] as [Float32Array, Float32Array];
  const vocals = mk();
  const bass = mk();
  const drums = mk();
  const other = mk();
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const vGate = Math.sin(2 * Math.PI * 1.5 * t) > -0.2 ? 1 : 0; // vocal phrases with gaps
    const v = vGate * (0.18 * Math.sin(2 * Math.PI * 440 * t) + 0.06 * Math.sin(2 * Math.PI * 880 * t));
    vocals[0][i] = v;
    vocals[1][i] = 0.97 * v;
    const b = 0.22 * Math.sin(2 * Math.PI * 55 * t);
    bass[0][i] = b;
    bass[1][i] = b;
    const beat = (i % Math.floor(SR / 4)) < 1200 ? 1 : 0;
    drums[0][i] = beat * 0.2 * noise();
    drums[1][i] = beat * 0.2 * noise();
    const o = 0.08 * Math.sin(2 * Math.PI * 330 * t + 0.3);
    other[0][i] = o;
    other[1][i] = -0.9 * o;
  }
  const mix = mk();
  for (let i = 0; i < N; i++) {
    mix[0][i] = vocals[0][i] + bass[0][i] + drums[0][i] + other[0][i];
    mix[1][i] = vocals[1][i] + bass[1][i] + drums[1][i] + other[1][i];
  }
  return {
    mix,
    other,
    set: { fingerprint: fingerprintStereo(mix[0], mix[1], SR), sampleRate: SR, length: N, stems: { vocals, bass, drums } },
  };
}

const rebalance = (params: Partial<VocalRebalanceParams>, extra: Partial<ProcessorModule> = {}) =>
  createProcessorModule('vocal-rebalance', { id: 'vr', params: { ...sanitizeVocalRebalanceParams({}), ...params }, ...extra });

const bitsEqual = (a: Float32Array, b: Float32Array) => {
  assert.equal(a.length, b.length);
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
};

test('0 dB on every stem is bit-identical pass-through, with or without cached stems', () => {
  const { mix, set } = makeStems();
  unregisterRebalanceStems();
  for (const withStems of [false, true]) {
    if (withStems) registerRebalanceStems(set);
    const chains: ProcessorModule[][] = [
      [rebalance({ vocalGainDb: 0 })],
      [rebalance({ vocalGainDb: 0, bassEnabled: true, bassGainDb: 0, drumsEnabled: true, drumsGainDb: 0, sensitivity: 80 })],
      [rebalance({ vocalGainDb: -6, bassEnabled: false, bassGainDb: 6 }, { intensity: 0 })],
      [rebalance({ vocalGainDb: 4 }, { bypassed: true })],
    ];
    for (const chain of chains) {
      const out = processChainOffline(mix, SR, chain).channels;
      assert.ok(bitsEqual(out[0], mix[0]) && bitsEqual(out[1], mix[1]), `pass-through (stems ${withStems})`);
    }
    // A chain followed by a limiter renders identically with a unity rebalance in front.
    const lim = createProcessorModule('limiter', { id: 'lim', params: validateProcessorParams('limiter', {}) as LimiterParams, inputGainDb: 6 });
    const ref = processChainOffline(mix, SR, [lim]).channels;
    const withVr = processChainOffline(mix, SR, [rebalance({ vocalGainDb: 0 }), lim]).channels;
    assert.ok(bitsEqual(ref[0], withVr[0]) && bitsEqual(ref[1], withVr[1]));
  }
  unregisterRebalanceStems();
});

test('gain maths on synthetic stems: out = mix + (g - 1) * stem at sensitivity 0', () => {
  const { mix, set, other } = makeStems();
  registerRebalanceStems(set);
  const cases: Array<Partial<VocalRebalanceParams>> = [
    { vocalGainDb: -6 },
    { vocalGainDb: 6 },
    { vocalGainDb: -12, bassEnabled: true, bassGainDb: 3, drumsEnabled: true, drumsGainDb: -4.5 },
  ];
  for (const c of cases) {
    const p = sanitizeVocalRebalanceParams({ ...c, sensitivity: 0 });
    const out = processChainOffline(mix, SR, [rebalance(p)]).channels;
    const gv = 10 ** (p.vocalGainDb / 20);
    const gb = p.bassEnabled ? 10 ** (p.bassGainDb / 20) : 1;
    const gd = p.drumsEnabled ? 10 ** (p.drumsGainDb / 20) : 1;
    let maxErr = 0;
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < N; i++) {
        // Expected: the stems rebalanced and summed back (the stems are mixture-consistent).
        const expected = gv * set.stems.vocals[ch][i] + gb * set.stems.bass[ch][i] + gd * set.stems.drums[ch][i] + other[ch][i];
        maxErr = Math.max(maxErr, Math.abs(out[ch][i] - expected));
      }
    }
    assert.ok(maxErr < 2e-6, `max error ${maxErr} for ${JSON.stringify(c)}`);
  }
  // Input gain on the module scales the stems with the mix.
  const out = processChainOffline(mix, SR, [rebalance({ vocalGainDb: -6, sensitivity: 0 }, { inputGainDb: -3 })]).channels;
  const gin = 10 ** (-3 / 20);
  const gv = 10 ** (-6 / 20);
  for (const i of [100, 5000, 30000]) {
    const expected = gin * (mix[0][i] + (gv - 1) * set.stems.vocals[0][i]);
    assert.ok(Math.abs(out[0][i] - expected) < 2e-6);
  }
  unregisterRebalanceStems();
});

test('sensitivity weights the move by stem dominance and stays bounded by the full move', () => {
  const { mix, set } = makeStems();
  const l = new Float32Array(mix[0]);
  const r = new Float32Array(mix[1]);
  const tel = applyVocalRebalance(l, r, sanitizeVocalRebalanceParams({ vocalGainDb: -12, sensitivity: 100, smoothingMs: 20 }), set, SR, 1);
  assert.equal(tel.applied, true);
  const k = 10 ** (-12 / 20) - 1;
  for (let i = 0; i < N; i += 97) {
    const delta = l[i] - mix[0][i];
    const full = k * set.stems.vocals[0][i];
    // Weighted delta has the same sign as the full move and never exceeds it.
    assert.ok(Math.abs(delta) <= Math.abs(full) + 1e-6);
    if (Math.abs(full) > 1e-4) assert.ok(delta * full >= 0);
  }
  // Where the vocal is silent nothing moves.
  const silentAt = Math.floor(SR * (0.6)); // sin(2*pi*1.5*0.6) = sin(1.8*pi) < -0.2 -> gated off
  assert.equal(Math.abs(set.stems.vocals[0][silentAt]), 0);
  assert.ok(Math.abs(l[silentAt] - mix[0][silentAt]) < 1e-7);
});

test('no stems, a different track, or a rebalance after other processing is a no-op', () => {
  const { mix, set } = makeStems();
  unregisterRebalanceStems();
  const t1 = processChainOffline(mix, SR, [rebalance({ vocalGainDb: -6 })]);
  assert.ok(bitsEqual(t1.channels[0], mix[0]));
  assert.equal(t1.telemetry[0].rebalance?.reason, 'no-stems');
  registerRebalanceStems(set);
  // Processing before the rebalance changes its input, so the fingerprint no longer matches.
  const eq = createProcessorModule('parametric-eq', { id: 'eq', params: { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 1, bands: [{ id: 'b', enabled: true, shape: 'bell', freq: 1000, gain: 2, q: 1 }] } });
  const ref = processChainOffline(mix, SR, [eq]).channels;
  const t2 = processChainOffline(mix, SR, [eq, rebalance({ vocalGainDb: -6 })]);
  assert.ok(bitsEqual(t2.channels[0], ref[0]));
  assert.equal(t2.telemetry[1].rebalance?.reason, 'no-stems');
  // ...but validation hoists it first, where it applies.
  const hoisted = validateChain([eq, rebalance({ vocalGainDb: -6 })]);
  assert.deepEqual(hoisted.map((m) => m.type), ['vocal-rebalance', 'parametric-eq']);
  assert.equal(processChainOffline(mix, SR, hoisted).telemetry[0].rebalance?.applied, true);
  unregisterRebalanceStems();
});

test('parameters clamp to their documented ranges; validation keeps one instance', () => {
  const p = validateProcessorParams('vocal-rebalance', {
    vocalGainDb: 40, bassEnabled: true, bassGainDb: -99, drumsEnabled: 'yes', drumsGainDb: Number.NaN, sensitivity: 500, smoothingMs: 1,
  }) as VocalRebalanceParams;
  assert.deepEqual(p, { vocalGainDb: 6, bassEnabled: true, bassGainDb: -12, drumsEnabled: false, drumsGainDb: 0, sensitivity: 100, smoothingMs: 5 });
  const d = validateProcessorParams('vocal-rebalance', undefined) as VocalRebalanceParams;
  assert.deepEqual(d, { vocalGainDb: 0, bassEnabled: false, bassGainDb: 0, drumsEnabled: false, drumsGainDb: 0, sensitivity: 30, smoothingMs: 40 });
  const chain = validateChain([
    createProcessorModule('limiter'),
    rebalance({ vocalGainDb: 2 }),
    rebalance({ vocalGainDb: -2 }, { id: 'vr2' }),
  ]);
  assert.deepEqual(chain.map((m) => m.type), ['vocal-rebalance', 'limiter']);
  assert.equal((chain[0].params as VocalRebalanceParams).vocalGainDb, 2);
});

test('export parity: export render == worker preview render, and stems are sent to the worker once', async () => {
  const { mix, set } = makeStems();
  unregisterRebalanceStems();
  registerRebalanceStems(set);
  const chain: ProcessorModule[] = [
    rebalance({ vocalGainDb: -4, drumsEnabled: true, drumsGainDb: 2, sensitivity: 40, smoothingMs: 60 }),
    createProcessorModule('limiter', { id: 'lim', params: validateProcessorParams('limiter', {}) as LimiterParams, inputGainDb: 4 }),
  ];
  assert.ok(rebalanceStemsForRender(chain, mix, SR));

  const exported = await renderMixedChain(mix, SR, chain, undefined, null);
  assert.equal(exported.telemetry[0].rebalance?.applied, true);

  // Real dspWorker module, in-process, behind the same client the app uses.
  const g = globalThis as unknown as { self?: unknown };
  const prevSelf = g.self;
  const fakeSelf: { onmessage: ((ev: { data: unknown }) => void) | null; postMessage: (msg: unknown) => void } = { onmessage: null, postMessage: () => undefined };
  g.self = fakeSelf;
  try {
    await import('./dspWorker');
    const handler = fakeSelf.onmessage!;
    const kinds: string[] = [];
    let putFingerprint = '';
    const client = createDspWorkerClient({
      workerTimeoutMs: 20_000,
      workerFactory: () => {
        const worker = {
          onmessage: null as ((ev: MessageEvent) => void) | null,
          onerror: null,
          onmessageerror: null,
          postMessage(message: { kind: string; set?: RebalanceStemSet }) {
            kinds.push(message.kind);
            if (message.kind === 'put-rebalance-stems') {
              putFingerprint = message.set!.fingerprint;
              // Prove the worker uses what it was sent: drop the main-realm copy first.
              unregisterRebalanceStems();
            }
            fakeSelf.postMessage = (resp) => setTimeout(() => worker.onmessage?.({ data: resp } as MessageEvent), 0);
            setTimeout(() => handler({ data: message }), 0);
          },
          terminate() {},
        };
        return worker as never;
      },
    });
    const preview1 = await client.renderAndAnalyzeOffThread({ sourceChannels: mix, sampleRate: SR, chain });
    registerRebalanceStems(set);
    const preview2 = await client.renderAndAnalyzeOffThread({ sourceChannels: mix, sampleRate: SR, chain });
    assert.deepEqual(kinds, ['put-rebalance-stems', 'render-only', 'render-only'], 'stems sent once, then reused');
    assert.equal(putFingerprint, set.fingerprint);
    for (const preview of [preview1, preview2]) {
      assert.equal(preview.usedWorker, true);
      assert.ok(bitsEqual(preview.channels[0], exported.channels[0]) && bitsEqual(preview.channels[1], exported.channels[1]), 'preview == export');
      assert.deepEqual(preview.telemetry, exported.telemetry);
    }
    client.dispose();
  } finally {
    g.self = prevSelf;
  }

  // The 32-bit export file carries exactly the rendered samples.
  const cfg: ExportConfig = { ...DEFAULT_EXPORT_CONFIG, format: 'wav', wavBitDepth: 32, sampleRate: SR as ExportConfig['sampleRate'], dither: 'none', channels: 'stereo', ceilingDb: 0 };
  const wav = new Uint8Array(await encodeWavBlob(exported.channels, SR, cfg).arrayBuffer());
  const view = new DataView(wav.buffer);
  let off = 12;
  while (String.fromCharCode(...wav.slice(off, off + 4)) !== 'data') off += 8 + view.getUint32(off + 4, true);
  for (const i of [0, 1234, N - 1]) {
    assert.equal(view.getFloat32(off + 8 + i * 8, true), exported.channels[0][i]);
    assert.equal(view.getFloat32(off + 8 + i * 8 + 4, true), exported.channels[1][i]);
  }
  assert.ok(getRebalanceStems(set.fingerprint));
  unregisterRebalanceStems();
});
