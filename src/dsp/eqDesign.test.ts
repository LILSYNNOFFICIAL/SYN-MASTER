import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { processChainOffline } from './offlineDsp';
import { createProcessorModule, validateChain } from './chainValidation';
import {
  allowedSlopes,
  bandShelfRatio,
  computeAutoGainDb,
  designBandSections,
  eqDisplayCurves,
  freqToNote,
  isLegacyEq,
  proportionalQ,
  qEdgeRatio,
  qFromEdgeRatio,
  sectionsMagnitudeDb,
} from './eqDesign';
import { designHighPass, designHighShelf, designLowPass, designLowShelf, designNotch, designPeakingEQ } from './biquad';
import { designEQBand } from './offlineDsp';
import { measureIntegratedLufs } from './analyzer';
import type { EQBand, ParametricEQParams, ProcessorModule } from '../types/mastering';

const SR = 48000;
const mag = (band: Partial<EQBand> & Pick<EQBand, 'shape' | 'freq'>, f: number) =>
  sectionsMagnitudeDb(designBandSections({ gain: 0, q: 0.71, ...band }, SR, 1), f, SR);

// ---------------------------------------------------------------------------
// Backward compatibility: chains saved before subtypes render bit-identically.
// Golden hashes were produced by the pre-overhaul renderer (commit eb48f52).
// ---------------------------------------------------------------------------

function goldenSource(n = 24000, sr = 48000): Float32Array[] {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    L[i] = 0.3 * Math.sin(2 * Math.PI * 60 * t) + 0.2 * Math.sin(2 * Math.PI * 1000 * t) + 0.1 * rnd();
    R[i] = 0.25 * Math.sin(2 * Math.PI * 90 * t + 0.3) + 0.2 * Math.sin(2 * Math.PI * 3500 * t) + 0.1 * rnd();
    if (i % 6000 < 300) {
      L[i] *= 2.5;
      R[i] *= 2.5;
    }
  }
  return [L, R];
}

const hashRender = (chain: ProcessorModule[]) => {
  const r = processChainOffline(goldenSource(), 48000, chain);
  const h = createHash('sha256');
  for (const c of r.channels) h.update(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
  return h.digest('hex').slice(0, 32);
};

const SAVED_EQ_BANDS = [
  { id: 'b1', enabled: true, shape: 'highpass', freq: 35, gain: 0, q: 0.9 },
  { id: 'b2', enabled: true, shape: 'lowshelf', freq: 120, gain: 2.5, q: 0.8 },
  { id: 'b3', enabled: true, shape: 'bell', freq: 400, gain: -3, q: 1.6 },
  { id: 'b4', enabled: true, shape: 'notch', freq: 2500, gain: 0, q: 6 },
  { id: 'b5', enabled: true, shape: 'highshelf', freq: 9000, gain: 1.5, q: 0.7 },
  { id: 'b6', enabled: true, shape: 'lowpass', freq: 18000, gain: 0, q: 0.71 },
];

const GOLDEN: Array<[string, () => ProcessorModule[], string]> = [
  ['default parametric EQ', () => [createProcessorModule('parametric-eq', { id: 'e' })], '0f6882862fa2e314701acac45da4f225'],
  ['default dynamic EQ', () => [createProcessorModule('dynamic-eq', { id: 'd' })], 'a10f5685327e7c929d11de4312c8718d'],
  [
    'saved six-shape EQ with tilt',
    () => validateChain([{ type: 'parametric-eq', id: 'e', params: { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 1.5, bands: SAVED_EQ_BANDS } }]),
    '97df45a32b1b3e3b0dac4ce6eb7e0863',
  ],
  [
    'saved linear-phase mid-side EQ at 70% intensity',
    () => validateChain([{ type: 'parametric-eq', id: 'e', intensity: 70, params: { phaseMode: 'linear', msMode: 'mid-side', tiltDb: -1, bands: SAVED_EQ_BANDS.slice(1, 3) } }]),
    '4d29fd54c5a54511c4a66403a11d3f4f',
  ],
  [
    'saved minimum-phase mid-side EQ',
    () => validateChain([{ type: 'parametric-eq', id: 'e', params: { phaseMode: 'minimum', msMode: 'mid-side', tiltDb: 0, bands: [{ id: 'b3', enabled: true, shape: 'bell', freq: 400, gain: 4, q: 1.6 }] } }]),
    'cd15e4290b4819e49b9d7c5ef37032eb',
  ],
  [
    'saved dynamic EQ (cut, boost, legacy ratio)',
    () => validateChain([{ type: 'dynamic-eq', id: 'd', params: { bands: [
      { id: 'd1', enabled: true, freq: 300, q: 2, thresholdDb: -30, maxCutDb: -6, ratio: 4, mode: 'cut', attackMs: 5, releaseMs: 80 },
      { id: 'd2', enabled: true, freq: 3500, q: 3, thresholdDb: -35, maxCutDb: 4, ratio: 3, mode: 'boost', attackMs: 10, releaseMs: 120 },
      { id: 'd3', enabled: true, freq: 60, q: 1, thresholdDb: -25, maxCutDb: -3, attackMs: 10, releaseMs: 100 },
    ] } }]),
    '543da39cba1089290fec5d5baac16e79',
  ],
];

for (const [name, chain, hash] of GOLDEN) {
  test(`legacy render is bit-identical: ${name}`, () => {
    assert.equal(hashRender(chain()), hash);
  });
}

test('legacy shapes map to the subtypes that reproduce their exact coefficients', () => {
  const cases: Array<[EQBand, ReturnType<typeof designPeakingEQ>]> = [
    [{ id: 'a', enabled: true, shape: 'bell', freq: 400, gain: -3, q: 1.6, subtype: 'bell' }, designPeakingEQ(400, -3, 1.6, SR)],
    [{ id: 'a', enabled: true, shape: 'lowshelf', freq: 120, gain: 2.5, q: 0.8, subtype: 'analog', slope: 12 }, designLowShelf(120, 2.5, 0.8, SR)],
    [{ id: 'a', enabled: true, shape: 'highshelf', freq: 9000, gain: 1.5, q: 0.7, subtype: 'analog' }, designHighShelf(9000, 1.5, 0.7, SR)],
    [{ id: 'a', enabled: true, shape: 'highpass', freq: 35, gain: 0, q: 0.9, subtype: 'flat', slope: 12 }, designHighPass(35, 0.9, SR)],
    [{ id: 'a', enabled: true, shape: 'lowpass', freq: 18000, gain: 0, q: 0.71, subtype: 'flat' }, designLowPass(18000, 0.71, SR)],
    [{ id: 'a', enabled: true, shape: 'notch', freq: 2500, gain: 0, q: 6 }, designNotch(2500, 6, SR)],
  ];
  for (const [band, expected] of cases) {
    const sections = designBandSections(band, SR, 1);
    assert.equal(sections.length, 1, band.shape);
    assert.deepEqual(sections[0], expected, `${band.shape}/${band.subtype}`);
    // And the original designEQBand (legacy path) agrees.
    const { subtype: _s, slope: _sl, ...legacy } = band;
    assert.deepEqual(designEQBand(legacy, SR, 1), expected);
  }
});

test('explicit default subtypes render the same samples as the legacy bands', () => {
  const legacy = validateChain([{ type: 'parametric-eq', id: 'e', params: { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 1.5, bands: SAVED_EQ_BANDS } }]);
  const explicit = validateChain([{ type: 'parametric-eq', id: 'e', params: { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 1.5, bands: SAVED_EQ_BANDS.map((b) => ({
    ...b,
    subtype: b.shape === 'bell' ? 'bell' : b.shape.endsWith('shelf') ? 'analog' : b.shape.endsWith('pass') ? 'flat' : undefined,
    channel: 'stereo',
  })) } }]);
  assert.equal(isLegacyEq(legacy[0].params as ParametricEQParams), true);
  assert.equal(isLegacyEq(explicit[0].params as ParametricEQParams), false);
  const a = processChainOffline(goldenSource(), SR, legacy).channels;
  const b = processChainOffline(goldenSource(), SR, explicit).channels;
  let maxDiff = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < a[c].length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[c][i] - b[c][i]));
  assert.ok(maxDiff < 1e-6, `explicit defaults must match legacy (max diff ${maxDiff})`);
});

// ---------------------------------------------------------------------------
// Frequency response of every subtype
// ---------------------------------------------------------------------------

test('bell: exact gain at centre, symmetric skirts', () => {
  assert.ok(Math.abs(mag({ shape: 'bell', subtype: 'bell', freq: 1000, gain: 6, q: 1 }, 1000) - 6) < 0.01);
  const lo = mag({ shape: 'bell', freq: 1000, gain: 6, q: 1 }, 500);
  const hi = mag({ shape: 'bell', freq: 1000, gain: 6, q: 1 }, 2000);
  assert.ok(Math.abs(lo - hi) < 0.3);
});

test('proportional Q: bandwidth narrows as gain rises', () => {
  assert.ok(proportionalQ(1, 18) > proportionalQ(1, 6));
  assert.ok(proportionalQ(1, 6) > proportionalQ(1, 2));
  // Relative width: response at one octave away as a fraction of the peak gain.
  const rel = (g: number) => mag({ shape: 'bell', subtype: 'proportional', freq: 1000, gain: g, q: 1 }, 2000) / g;
  assert.ok(rel(18) < rel(6) && rel(6) < rel(2), `relative skirt should shrink with gain: ${rel(2)}, ${rel(6)}, ${rel(18)}`);
  for (const g of [2, 6, 18, -12]) {
    assert.ok(Math.abs(mag({ shape: 'bell', subtype: 'proportional', freq: 1000, gain: g, q: 1 }, 1000) - g) < 0.01);
  }
});

test('band shelf: flat top at the set gain, returns to 0 dB outside', () => {
  const b = { shape: 'bell' as const, subtype: 'band-shelf' as const, freq: 1000, gain: 6, q: 1 };
  assert.ok(Math.abs(mag(b, 1000) - 6) < 0.05);
  const k = bandShelfRatio(1);
  // Flat top: within 0.5 dB across +/- a fifth of an octave of the centre (a bell drops ~1.5 dB).
  for (const f of [870, 1150]) assert.ok(Math.abs(mag(b, f) - 6) < 0.5, `plateau at ${f}: ${mag(b, f)}`);
  const bellAt = mag({ shape: 'bell', freq: 1000, gain: 6, q: 1 }, 1150);
  assert.ok(mag(b, 1150) > bellAt, 'band shelf must be flatter than a bell');
  assert.ok(Math.abs(mag(b, 1000 / (k * 4))) < 0.5);
  assert.ok(Math.abs(mag(b, 1000 * k * 4)) < 0.5);
});

test('analog shelves: full gain beyond the corner, half gain at it; 6/12/24 dB slopes', () => {
  assert.ok(Math.abs(mag({ shape: 'lowshelf', freq: 400, gain: 6, q: 0.71 }, 20) - 6) < 0.05);
  assert.ok(Math.abs(mag({ shape: 'lowshelf', freq: 400, gain: 6, q: 0.71 }, 400) - 3) < 0.05);
  // Steeper slope = less gain an octave above the corner.
  const above = (slope: 6 | 12 | 24) => mag({ shape: 'lowshelf', subtype: 'analog', slope, freq: 400, gain: 6, q: 0.71 }, 1600);
  assert.ok(above(6) > above(12) && above(12) > above(24) - 0.05);
  assert.deepEqual(allowedSlopes('lowshelf', 'analog'), [6, 12, 24]);
});

test('baxandall: gentler and wider than the analog shelf, still reaching full gain', () => {
  const bax = (f: number) => mag({ shape: 'lowshelf', subtype: 'baxandall', freq: 400, gain: 6 }, f);
  const ana = (f: number) => mag({ shape: 'lowshelf', subtype: 'analog', freq: 400, gain: 6 }, f);
  assert.ok(bax(100) < ana(100), 'baxandall keeps rising below the corner');
  assert.ok(bax(5) > 5.5, 'baxandall reaches full gain at the extreme');
  const treble = (f: number) => mag({ shape: 'highshelf', subtype: 'baxandall', freq: 3000, gain: 6 }, f);
  assert.ok(treble(23000) > 5 && treble(3000) < 3.1);
});

test('vintage shelf: Pultec-style dip of opposite sign past the corner', () => {
  const v = (f: number) => mag({ shape: 'lowshelf', subtype: 'vintage', freq: 100, gain: 8, q: 0.71 }, f);
  assert.ok(v(25) > 7);
  const dip = Math.min(...[150, 200, 250, 300, 400].map(v));
  assert.ok(dip < -1, `vintage low shelf should dip below 0 dB above the corner (got ${dip.toFixed(2)})`);
  const h = (f: number) => mag({ shape: 'highshelf', subtype: 'vintage', freq: 10000, gain: 6, q: 0.71 }, f);
  assert.ok(Math.min(...[3000, 4000, 5000, 6000].map(h)) < -0.8);
});

test('resonant shelf: overshoots the set gain and undershoots on the other side', () => {
  const r = [50, 100, 200, 300, 400, 600, 800, 1000].map((f) => mag({ shape: 'lowshelf', subtype: 'resonant', freq: 400, gain: 6, q: 0.71 }, f));
  assert.ok(Math.max(...r) > 6.5, `overshoot ${Math.max(...r)}`);
  assert.ok(Math.min(...r) < -0.5, `undershoot ${Math.min(...r)}`);
});

test('flat pass filters: -3 dB at cutoff and the selected slope', () => {
  for (const slope of [6, 12, 18, 24, 36, 48, 72, 96] as const) {
    const b = { shape: 'highpass' as const, subtype: 'flat' as const, slope, freq: 1000, q: Math.SQRT1_2 };
    assert.ok(Math.abs(mag(b, 1000) + 3.01) < 0.1, `${slope} dB/oct at cutoff: ${mag(b, 1000)}`);
    // Two octaves below the cutoff the attenuation per octave approaches the slope.
    const perOct = mag(b, 250) - mag(b, 125);
    assert.ok(Math.abs(perOct - slope) < Math.max(1, slope * 0.06), `${slope} dB/oct measured ${perOct.toFixed(2)}`);
    assert.ok(Math.abs(mag(b, 16000)) < 0.1);
  }
  const lp = { shape: 'lowpass' as const, subtype: 'flat' as const, slope: 24 as const, freq: 1000, q: Math.SQRT1_2 };
  assert.ok(Math.abs(mag(lp, 1000) + 3.01) < 0.1 && Math.abs(mag(lp, 50)) < 0.01);
});

test('resonant pass filters: a peak at the cutoff', () => {
  for (const slope of [12, 24, 48] as const) {
    const hp = mag({ shape: 'highpass', subtype: 'resonant', slope, freq: 1000, q: 0.71 }, 1000);
    const lp = mag({ shape: 'lowpass', subtype: 'resonant', slope, freq: 1000, q: 0.71 }, 1000);
    assert.ok(hp > 3 && lp > 3, `${slope}: hp ${hp.toFixed(2)} lp ${lp.toFixed(2)}`);
  }
  assert.deepEqual(allowedSlopes('highpass', 'resonant').includes(6), false);
});

test('brickwall: <= 0.1 dB passband, >= 40 dB down a fifth of an octave past the cutoff', () => {
  for (const f of [100, 500, 900, 990]) {
    const v = mag({ shape: 'lowpass', subtype: 'brickwall', freq: 1000 }, f);
    assert.ok(v <= 0.12 && v >= -0.12, `lowpass passband ${f}: ${v}`);
  }
  assert.ok(mag({ shape: 'lowpass', subtype: 'brickwall', freq: 1000 }, 1150) < -30);
  assert.ok(mag({ shape: 'lowpass', subtype: 'brickwall', freq: 1000 }, 1200) < -40);
  assert.ok(mag({ shape: 'highpass', subtype: 'brickwall', freq: 1000 }, 830) < -40);
  assert.ok(Math.abs(mag({ shape: 'highpass', subtype: 'brickwall', freq: 30 }, 60)) < 0.12);
  assert.deepEqual(allowedSlopes('lowpass', 'brickwall'), []);
});

test('notch, band-pass and tilt', () => {
  assert.ok(mag({ shape: 'notch', freq: 1000, q: 4 }, 1000) < -60);
  assert.ok(Math.abs(mag({ shape: 'bandpass', freq: 1000, q: 2 }, 1000)) < 0.01);
  assert.ok(mag({ shape: 'bandpass', freq: 1000, q: 2 }, 250) < -15);
  const t = (f: number) => mag({ shape: 'tilt', freq: 1000, gain: 6 }, f);
  assert.ok(Math.abs(t(1000)) < 0.05 && t(20) < -2.5 && t(20000) > 2.5);
});

// ---------------------------------------------------------------------------
// Drawn curve == rendered response
// ---------------------------------------------------------------------------

function measuredResponseDb(params: ParametricEQParams, freqs: number[], channel: 'mid' | 'side' | 'left' = 'mid'): number[] {
  const n = 96000;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  // Impulse away from the start so a linear-phase kernel's pre-ringing is kept.
  const at = 8192;
  if (channel === 'mid') { L[at] = 0.5; R[at] = 0.5; }
  else if (channel === 'side') { L[at] = 0.5; R[at] = -0.5; }
  else L[at] = 0.5;
  const chain = [{ ...createProcessorModule('parametric-eq', { id: 'eq' }), params }];
  const out = processChainOffline([L, R], SR, chain).channels;
  return freqs.map((f) => {
    const w = (2 * Math.PI * f) / SR;
    let re = 0;
    let im = 0;
    const x = channel === 'side' ? (i: number) => (out[0][i] - out[1][i]) : channel === 'left' ? (i: number) => out[0][i] * 2 : (i: number) => (out[0][i] + out[1][i]);
    for (let i = 0; i < n; i++) {
      const v = x(i);
      if (v === 0) continue;
      re += v * Math.cos(w * i);
      im -= v * Math.sin(w * i);
    }
    return 20 * Math.log10(Math.max(1e-9, Math.hypot(re, im)));
  });
}

const PROBE_FREQS = [40, 80, 160, 320, 640, 1000, 1500, 2500, 5000, 9000, 15000];

test('rendered response matches the drawn curve for every subtype', () => {
  const variants: EQBand[] = [
    { id: '1', enabled: true, shape: 'bell', subtype: 'proportional', freq: 700, gain: 9, q: 1.2 },
    { id: '2', enabled: true, shape: 'bell', subtype: 'band-shelf', freq: 2500, gain: -5, q: 1 },
    { id: '3', enabled: true, shape: 'lowshelf', subtype: 'baxandall', freq: 200, gain: 4 , q: 0.71 },
    { id: '4', enabled: true, shape: 'highshelf', subtype: 'vintage', freq: 8000, gain: 5, q: 0.71 },
    { id: '5', enabled: true, shape: 'lowshelf', subtype: 'resonant', slope: 24, freq: 120, gain: -4, q: 0.71 },
    { id: '6', enabled: true, shape: 'highpass', subtype: 'resonant', slope: 36, freq: 50, gain: 0, q: 0.71 },
    { id: '7', enabled: true, shape: 'lowpass', subtype: 'flat', slope: 18, freq: 12000, gain: 0, q: 0.71 },
    { id: '8', enabled: true, shape: 'tilt', freq: 1000, gain: 2, q: 1 },
  ];
  const params: ParametricEQParams = { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, bands: variants };
  const drawn = eqDisplayCurves(params, SR, PROBE_FREQS).main;
  const measured = measuredResponseDb(params, PROBE_FREQS);
  PROBE_FREQS.forEach((f, i) => {
    assert.ok(Math.abs(drawn[i] - measured[i]) < 0.1, `${f} Hz: drawn ${drawn[i].toFixed(2)} vs rendered ${measured[i].toFixed(2)}`);
  });
});

test('brickwall render matches its drawn curve', () => {
  const params: ParametricEQParams = { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, bands: [
    { id: 'hp', enabled: true, shape: 'highpass', subtype: 'brickwall', freq: 1000, gain: 0, q: 0.71 },
  ] };
  const freqs = [1100, 2000, 5000, 900];
  const drawn = eqDisplayCurves(params, SR, freqs).main;
  const measured = measuredResponseDb(params, freqs);
  freqs.forEach((f, i) => assert.ok(Math.abs(drawn[i] - measured[i]) < 0.2 || (drawn[i] < -60 && measured[i] < -60), `${f}: ${drawn[i]} vs ${measured[i]}`));
});

test('linear-phase mode keeps the drawn magnitude (within FIR resolution) for new subtypes', () => {
  const params: ParametricEQParams = { phaseMode: 'linear', msMode: 'stereo', tiltDb: 0, bands: [
    { id: '1', enabled: true, shape: 'bell', subtype: 'proportional', freq: 2000, gain: 6, q: 1 },
    { id: '2', enabled: true, shape: 'highshelf', subtype: 'baxandall', freq: 6000, gain: -3, q: 0.71 },
  ] };
  const freqs = [500, 1000, 2000, 4000, 8000, 12000];
  const drawn = eqDisplayCurves(params, SR, freqs).main;
  const measured = measuredResponseDb(params, freqs);
  freqs.forEach((f, i) => assert.ok(Math.abs(drawn[i] - measured[i]) < 0.35, `${f}: ${drawn[i]} vs ${measured[i]}`));
});

// ---------------------------------------------------------------------------
// Channels, auto-gain, solo
// ---------------------------------------------------------------------------

test('per-band channel: mid, side and left bands touch only their component', () => {
  const band = (channel: EQBand['channel']): ParametricEQParams => ({ phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, bands: [
    { id: 'x', enabled: true, shape: 'bell', subtype: 'bell', freq: 1000, gain: 6, q: 1, channel },
  ] });
  // Side band: the mid (mono) component is untouched, the side component gets +6 dB.
  assert.ok(Math.abs(measuredResponseDb(band('side'), [1000], 'mid')[0] - 0) < 0.01);
  assert.ok(Math.abs(measuredResponseDb(band('side'), [1000], 'side')[0] - 6) < 0.05);
  // Mid band: the opposite.
  assert.ok(Math.abs(measuredResponseDb(band('mid'), [1000], 'mid')[0] - 6) < 0.05);
  assert.ok(Math.abs(measuredResponseDb(band('mid'), [1000], 'side')[0]) < 0.01);
  // Left band leaves the right channel bit-exact.
  const n = 4096;
  const L = new Float32Array(n).map((_, i) => Math.sin(i * 0.13) * 0.3);
  const R = new Float32Array(n).map((_, i) => Math.sin(i * 0.07) * 0.3);
  const out = processChainOffline([L, R], SR, [{ ...createProcessorModule('parametric-eq'), params: band('left') }]).channels;
  assert.deepEqual(Array.from(out[1]), Array.from(R));
  assert.notDeepEqual(Array.from(out[0]), Array.from(L));
  const curves = eqDisplayCurves(band('left'), SR, [1000]);
  assert.ok(curves.left && Math.abs(curves.left[0] - 6) < 0.01 && Math.abs(curves.main[0]) < 0.01);
});

function pinkish(n: number, seedInit = 7): Float32Array[] {
  // Voss-style pink approximation (sum of octave-held random rows).
  let seed = seedInit;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  const rows = new Float64Array(16);
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < 16; r++) if (i % (1 << r) === 0) rows[r] = rnd();
    let s = 0;
    for (let r = 0; r < 16; r++) s += rows[r];
    L[i] = (s / 16) * 0.5;
  }
  return [L, new Float32Array(L)];
}

test('auto-gain cancels most of the loudness change of a broad boost', () => {
  const src = pinkish(SR * 4);
  const base: ParametricEQParams = { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, bands: [
    { id: 's', enabled: true, shape: 'highshelf', subtype: 'analog', freq: 2000, gain: 6, q: 0.71 },
    { id: 'b', enabled: true, shape: 'bell', subtype: 'bell', freq: 200, gain: 4, q: 0.8 },
  ] };
  const lufs = (p: ParametricEQParams) => measureIntegratedLufs(processChainOffline(src, SR, [{ ...createProcessorModule('parametric-eq'), params: p }]).channels, SR);
  const dry = measureIntegratedLufs(src, SR);
  const off = lufs(base) - dry;
  const on = lufs({ ...base, autoGain: true }) - dry;
  assert.ok(off > 2, `boost without auto-gain should be louder (${off.toFixed(2)} LU)`);
  assert.ok(Math.abs(on) < Math.abs(off) / 2 && Math.abs(on) < 1.5, `auto-gain residual ${on.toFixed(2)} LU vs ${off.toFixed(2)}`);
  assert.ok(computeAutoGainDb({ ...base, autoGain: true }, SR) < 0);
  // The drawn curve includes the trim.
  const c = eqDisplayCurves({ ...base, autoGain: true }, SR, [20000]);
  assert.ok(Math.abs(c.autoGainDb - computeAutoGainDb(base, SR)) < 1e-9);
});

test('solo / listen is honoured only for preview audition renders', () => {
  const src = goldenSource();
  const params: ParametricEQParams = { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, bands: [
    { id: 'a', enabled: true, shape: 'bell', subtype: 'bell', freq: 1000, gain: 3, q: 4, solo: true },
  ] };
  const chain = [{ ...createProcessorModule('parametric-eq'), params }];
  const exportRender = processChainOffline(src, SR, chain).channels;
  const noSolo = processChainOffline(src, SR, [{ ...chain[0], params: { ...params, bands: [{ ...params.bands[0], solo: false }] } }]).channels;
  assert.deepEqual(Array.from(exportRender[0]), Array.from(noSolo[0]), 'export must ignore solo');
  const audition = processChainOffline(src, SR, chain, null, { audition: true }).channels;
  // The 60 Hz component is removed in audition: low-frequency energy collapses.
  const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
  assert.ok(rms(audition[0]) < rms(exportRender[0]) * 0.6);
});

// ---------------------------------------------------------------------------
// Readouts and Q handles
// ---------------------------------------------------------------------------

test('note readout and Q edge helpers', () => {
  assert.deepEqual(freqToNote(440), { note: 'A4', cents: 0 });
  assert.equal(freqToNote(261.63).note, 'C4');
  assert.equal(freqToNote(27.5).note, 'A0');
  for (const q of [0.3, 0.71, 1, 2.5, 8]) assert.ok(Math.abs(qFromEdgeRatio(qEdgeRatio(q)) - q) < 1e-9);
});
