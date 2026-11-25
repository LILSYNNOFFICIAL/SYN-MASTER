import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATCH_EQ_GRID_HZ,
  MATCH_EQ_GRID_POINTS,
  applyMatchEq,
  computeMatchEqCurve,
  designMatchEqKernel,
  firMagnitudeDb,
  interpolateCurveDb,
  learnMatchEqSpectrum,
  matchEqRealtimeImpulse,
} from './matchEq';
import { createDefaultParams, createProcessorModule, validateChain, validateProcessorParams } from './chainValidation';
import { processChainOffline } from './offlineDsp';
import type { MatchEqParams, MatchEqSpectrumSet } from '../types/mastering';

const SR = 48000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Paul Kellet's pink-noise filter on seeded white noise. */
function pink(n: number, seed: number): Float32Array {
  const r = rng(seed);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    o[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.05;
    b6 = w * 0.115926;
  }
  return o;
}

const flat = (): MatchEqSpectrumSet => ({
  stereo: new Array(MATCH_EQ_GRID_POINTS).fill(0),
  mid: new Array(MATCH_EQ_GRID_POINTS).fill(0),
  side: new Array(MATCH_EQ_GRID_POINTS).fill(0),
});

/** Imprint a known dB curve on a signal (a learned flat->curve Match EQ at 1/24 oct, no limits). */
function shape(channels: Float32Array[], curve: number[]): void {
  const p: MatchEqParams = {
    amount: 100, smoothing: 24, maxBoostDb: 12, maxCutDb: 12, lowHz: 20, highHz: 20000,
    channel: 'stereo', phase: 'linear', source: flat(), reference: { stereo: curve, mid: curve, side: curve },
  };
  applyMatchEq(channels[0], channels[1], p, SR, 1);
}

const tilt = (dbPerOct: number) => MATCH_EQ_GRID_HZ.map((f) => dbPerOct * Math.max(-5.5, Math.min(4.3, Math.log2(f / 1000))));
const idx = (f: number) => Math.round(Math.log2(f / 20) * 24);
const inBand = (f: number) => f >= 40 && f <= 16000;

function params(source: MatchEqSpectrumSet, reference: MatchEqSpectrumSet, over: Partial<MatchEqParams> = {}): MatchEqParams {
  return {
    ...(createDefaultParams('match-eq') as MatchEqParams),
    amount: 100, smoothing: 3, maxBoostDb: 12, maxCutDb: 12, lowHz: 20, highHz: 20000,
    source, reference, ...over,
  };
}

// Shared fixtures: pink-noise source and a +1 dB/oct tilted pink-noise reference (different noise).
const N = SR * 12;
const srcL = pink(N, 1), srcR = pink(N, 2);
const refCh = [pink(N, 3), pink(N, 4)];
shape(refCh, tilt(1));
const SOURCE = learnMatchEqSpectrum([srcL, srcR], SR)!;
const REFERENCE = learnMatchEqSpectrum(refCh, SR)!;

test('learned LTAS recovers a known tilt between two pink-noise signals', () => {
  assert.ok(SOURCE && REFERENCE);
  for (const view of ['stereo', 'mid', 'side'] as const) {
    assert.equal(SOURCE[view].length, MATCH_EQ_GRID_POINTS);
  }
  const c = computeMatchEqCurve(params(SOURCE, REFERENCE));
  const want = tilt(1);
  // Align the known tilt the same way (zero mean over the active range).
  const mean = want.reduce((a, b) => a + b, 0) / want.length;
  let worst = 0;
  for (let i = 0; i < MATCH_EQ_GRID_POINTS; i++) {
    if (!inBand(MATCH_EQ_GRID_HZ[i])) continue;
    worst = Math.max(worst, Math.abs(c.targetDb[i] - (want[i] - mean)));
  }
  assert.ok(worst < 0.75, `learned target within 0.75 dB of the imposed tilt (worst ${worst.toFixed(2)} dB)`);
});

for (const phase of ['linear', 'minimum'] as const) {
  test(`rendered ${phase}-phase Match EQ brings pink noise onto the tilted reference within tolerance`, () => {
    const l = new Float32Array(srcL), r = new Float32Array(srcR);
    const p = params(SOURCE, REFERENCE, { phase });
    applyMatchEq(l, r, p, SR, 1);
    const after = learnMatchEqSpectrum([l, r], SR)!;
    const residual = computeMatchEqCurve(params(after, REFERENCE)).targetDb;
    let worst = 0;
    for (let i = 0; i < MATCH_EQ_GRID_POINTS; i++) if (inBand(MATCH_EQ_GRID_HZ[i])) worst = Math.max(worst, Math.abs(residual[i]));
    const before = computeMatchEqCurve(params(SOURCE, REFERENCE)).targetDb;
    const beforeWorst = Math.max(...before.filter((_, i) => inBand(MATCH_EQ_GRID_HZ[i])).map(Math.abs));
    assert.ok(beforeWorst > 4, `fixture really differs (${beforeWorst.toFixed(2)} dB)`);
    assert.ok(worst < 0.75, `residual after matching ${worst.toFixed(2)} dB (was ${beforeWorst.toFixed(2)} dB)`);
  });
}

test('amount scales and max boost / max cut clamp the correction curve exactly', () => {
  const full = computeMatchEqCurve(params(SOURCE, REFERENCE)).targetDb;
  const half = computeMatchEqCurve(params(SOURCE, REFERENCE, { amount: 50 })).correctionDb;
  const lim = computeMatchEqCurve(params(SOURCE, REFERENCE, { maxBoostDb: 2, maxCutDb: 1 })).correctionDb;
  let sawBoostClamp = false, sawCutClamp = false;
  for (let i = 0; i < MATCH_EQ_GRID_POINTS; i++) {
    assert.ok(Math.abs(half[i] - full[i] * 0.5) < 1e-9, 'amount 50 % halves the curve');
    assert.ok(lim[i] <= 2 + 1e-12 && lim[i] >= -1 - 1e-12, `curve within [-1, +2] dB at ${MATCH_EQ_GRID_HZ[i].toFixed(0)} Hz`);
    assert.ok(Math.abs(lim[i] - Math.max(-1, Math.min(2, full[i]))) < 1e-9, 'limits are a clamp of the target');
    if (full[i] > 2.5) sawBoostClamp = true;
    if (full[i] < -1.5) sawCutClamp = true;
  }
  assert.ok(sawBoostClamp && sawCutClamp, 'fixture exercises both limits');
});

test('low / high limits fade the correction to 0 dB outside the range', () => {
  const c = computeMatchEqCurve(params(SOURCE, REFERENCE, { lowHz: 100, highHz: 5000 }));
  for (let i = 0; i < MATCH_EQ_GRID_POINTS; i++) {
    const f = MATCH_EQ_GRID_HZ[i];
    if (f < 100 / Math.pow(2, 1 / 3) || f > 5000 * Math.pow(2, 1 / 3)) assert.equal(c.correctionDb[i], 0, `0 dB at ${f.toFixed(0)} Hz`);
  }
  assert.ok(Math.abs(c.correctionDb[idx(1000)]) > 0.1, 'inside the range the curve still acts');
});

test('rendered output change respects the limits (clamping survives FIR design)', () => {
  const l = new Float32Array(srcL), r = new Float32Array(srcR);
  applyMatchEq(l, r, params(SOURCE, REFERENCE, { maxBoostDb: 2, maxCutDb: 1 }), SR, 1);
  const after = learnMatchEqSpectrum([l, r], SR)!;
  // Absolute change per grid point (same signal, so no level alignment needed).
  let maxUp = -Infinity, maxDown = Infinity;
  for (let i = 0; i < MATCH_EQ_GRID_POINTS; i++) {
    if (!inBand(MATCH_EQ_GRID_HZ[i])) continue;
    const d = after.stereo[i] - SOURCE.stereo[i];
    maxUp = Math.max(maxUp, d);
    maxDown = Math.min(maxDown, d);
  }
  assert.ok(maxUp <= 2.3 && maxUp > 1.5, `max boost ≈ 2 dB (got ${maxUp.toFixed(2)})`);
  assert.ok(maxDown >= -1.3 && maxDown < -0.7, `max cut ≈ 1 dB (got ${maxDown.toFixed(2)})`);
});

test('FIR kernels realise the curve in linear and minimum phase; linear phase is latency compensated', () => {
  const curve = computeMatchEqCurve(params(SOURCE, REFERENCE, { maxBoostDb: 4, maxCutDb: 4 })).correctionDb;
  for (const phase of ['linear', 'minimum'] as const) {
    const k = designMatchEqKernel(curve, SR, phase);
    for (const f of [60, 250, 1000, 4000, 12000]) {
      const err = Math.abs(firMagnitudeDb(k.taps, f, SR) - interpolateCurveDb(curve, f));
      assert.ok(err < 0.2, `${phase} FIR at ${f} Hz within 0.2 dB (err ${err.toFixed(3)})`);
    }
  }
  // An impulse stays where it was after linear-phase processing (symmetric response around it).
  const n = SR;
  const l = new Float32Array(n), r = new Float32Array(n);
  l[20000] = 1;
  r[20000] = 1;
  applyMatchEq(l, r, params(SOURCE, REFERENCE, { phase: 'linear' }), SR, 1);
  let peak = 0;
  for (let i = 1; i < n; i++) if (Math.abs(l[i]) > Math.abs(l[peak])) peak = i;
  assert.equal(peak, 20000, 'linear-phase output is time-aligned with the input');
  for (let k = 1; k < 200; k++) assert.ok(Math.abs(l[20000 + k] - l[20000 - k]) < 1e-5, 'symmetric impulse response');
});

test('unlearned, zero-amount, zero-intensity and bypassed Match EQ are bit-identical pass-throughs', () => {
  const src = [srcL.subarray(0, SR), srcR.subarray(0, SR)];
  const variants = [
    createProcessorModule('match-eq'),
    createProcessorModule('match-eq', { params: params(SOURCE, REFERENCE, { amount: 0 }) }),
    createProcessorModule('match-eq', { params: params(SOURCE, REFERENCE), intensity: 0 }),
    createProcessorModule('match-eq', { params: params(SOURCE, REFERENCE), bypassed: true }),
  ];
  for (const m of variants) {
    const out = processChainOffline(src, SR, [m]);
    assert.deepEqual(Array.from(out.channels[0]), Array.from(src[0]));
    assert.deepEqual(Array.from(out.channels[1]), Array.from(src[1]));
  }
});

test('mid mode leaves pure side content untouched and side mode leaves mono untouched', () => {
  const n = SR;
  const side = pink(n, 9);
  const l = new Float32Array(side), r = new Float32Array(side.map((x) => -x));
  applyMatchEq(l, r, params(SOURCE, REFERENCE, { channel: 'mid' }), SR, 1);
  for (let i = 0; i < n; i += 97) {
    assert.ok(Math.abs(l[i] - side[i]) < 1e-5 && Math.abs(r[i] + side[i]) < 1e-5);
  }
  const mono = pink(n, 10);
  const ml = new Float32Array(mono), mr = new Float32Array(mono);
  applyMatchEq(ml, mr, params(SOURCE, REFERENCE, { channel: 'side' }), SR, 1);
  for (let i = 0; i < n; i += 97) assert.ok(Math.abs(ml[i] - mono[i]) < 1e-5 && Math.abs(mr[i] - mono[i]) < 1e-5);
});

test('realtime impulse is minimum phase and encodes stereo / mid / side routing', () => {
  assert.equal(matchEqRealtimeImpulse(createDefaultParams('match-eq') as MatchEqParams, SR), null, 'unlearned = no convolver');
  const st = matchEqRealtimeImpulse(params(SOURCE, REFERENCE), SR)!;
  assert.equal(st.length, 4);
  assert.ok(st[1].every((x) => x === 0) && st[2].every((x) => x === 0), 'stereo: no cross terms');
  const mid = matchEqRealtimeImpulse(params(SOURCE, REFERENCE, { channel: 'mid' }), SR)!;
  // L->L + L->R = h (mid), L->L - L->R = unit impulse (side passes)
  assert.ok(Math.abs(mid[0][0] - mid[1][0] - 1) < 1e-6);
  for (let i = 1; i < 64; i++) assert.ok(Math.abs(mid[0][i] - mid[1][i]) < 1e-7);
});

test('validation clamps settings, keeps complete spectra and drops malformed ones', () => {
  const v = validateProcessorParams('match-eq', {
    amount: 250, smoothing: 5, maxBoostDb: 40, maxCutDb: -9, lowHz: 5, highHz: 99999, channel: 'left', phase: 'weird',
    source: SOURCE, reference: REFERENCE, referenceName: 'Ref.wav',
  }) as MatchEqParams;
  assert.equal(v.amount, 100);
  assert.equal(v.smoothing, 3);
  assert.equal(v.maxBoostDb, 12);
  assert.equal(v.maxCutDb, 9);
  assert.equal(v.lowHz, 20);
  assert.equal(v.highHz, 20000);
  assert.equal(v.channel, 'stereo');
  assert.equal(v.phase, 'linear');
  assert.equal(v.source?.stereo.length, MATCH_EQ_GRID_POINTS);
  assert.equal(v.referenceName, 'Ref.wav');
  const bad = validateProcessorParams('match-eq', { source: { stereo: [1, 2], mid: [], side: [] }, reference: REFERENCE }) as MatchEqParams;
  assert.equal(bad.source, undefined);
  assert.equal(bad.reference, undefined);
  const nan = validateProcessorParams('match-eq', { source: { ...SOURCE, mid: SOURCE.mid.map((x, i) => (i === 3 ? Number.NaN : x)) }, reference: REFERENCE }) as MatchEqParams;
  assert.equal(nan.source, undefined, 'non-finite spectra are rejected');
  assert.deepEqual(Object.keys(validateProcessorParams('match-eq', {})).sort(), ['amount', 'channel', 'highHz', 'lowHz', 'maxBoostDb', 'maxCutDb', 'phase', 'smoothing']);
  assert.equal(validateChain([{ type: 'match-eq', params: { amount: 40 } }])[0].type, 'match-eq');
});
