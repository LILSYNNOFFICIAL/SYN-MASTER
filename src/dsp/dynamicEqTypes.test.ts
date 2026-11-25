import test from 'node:test';
import assert from 'node:assert/strict';
import { processChainOffline, softKneeOver } from './offlineDsp';
import { createProcessorModule } from './chainValidation';
import type { DynamicEQBand, DynamicEQParams } from '../types/mastering';

const SR = 48000;

function tone(freq: number, amp: number, seconds = 1, side = false): Float32Array[] {
  const n = Math.round(SR * seconds);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = amp * Math.sin((2 * Math.PI * freq * i) / SR);
    L[i] = v;
    R[i] = side ? -v : v;
  }
  return [L, R];
}

const rmsDb = (x: Float32Array, from = 0.5) => {
  const a = Math.floor(x.length * from);
  let p = 0;
  for (let i = a; i < x.length; i++) p += x[i] * x[i];
  return 10 * Math.log10(p / (x.length - a));
};

const band = (patch: Partial<DynamicEQBand>): DynamicEQBand => ({
  id: 'd1', enabled: true, freq: 1000, q: 2, thresholdDb: -12, maxCutDb: -12, ratio: 4, mode: 'cut',
  attackMs: 5, releaseMs: 50, type: 'bell', ...patch,
});

function render(src: Float32Array[], bands: DynamicEQBand[], opts: { audition?: boolean; traces?: boolean } = {}) {
  const params: DynamicEQParams = { bands };
  const mod = { ...createProcessorModule('dynamic-eq', { id: 'deq' }), params };
  return processChainOffline(src, SR, [mod], null, { audition: opts.audition, collectDynamicEqTraces: opts.traces });
}

// A 1 kHz tone at 0.5 peak sits at ~-6 dBFS in the band-pass detector.
const DRY_DB = rmsDb(tone(1000, 0.5)[0]);

test('cut: reduction follows the ratio above threshold (steady state)', () => {
  const at = (ratio: number) => rmsDb(render(tone(1000, 0.5), [band({ ratio })]).channels[0]) - DRY_DB;
  const r2 = at(2);
  const r4 = at(4);
  const r20 = at(20);
  // ~6 dB over threshold -> 6 * (1 - 1/ratio) dB of cut.
  assert.ok(Math.abs(r2 + 3) < 0.6, `2:1 -> ${r2.toFixed(2)}`);
  assert.ok(Math.abs(r4 + 4.5) < 0.6, `4:1 -> ${r4.toFixed(2)}`);
  assert.ok(r20 < r4 && r4 < r2, 'higher ratio = more cut');
});

test('cut: range caps the reduction; below threshold there is no change', () => {
  const capped = rmsDb(render(tone(1000, 0.5), [band({ ratio: 20, thresholdDb: -40, maxCutDb: -3 })]).channels[0]) - DRY_DB;
  assert.ok(Math.abs(capped + 3) < 0.3, `range -3 -> ${capped.toFixed(2)}`);
  const src = tone(1000, 0.5);
  const quiet = render(src, [band({ thresholdDb: 0 })]).channels[0];
  for (let i = 0; i < src[0].length; i++) assert.ok(Math.abs(quiet[i] - src[0][i]) < 1e-6);
});

test('boost mode raises the band above threshold, capped by range', () => {
  const b = rmsDb(render(tone(1000, 0.5), [band({ mode: 'boost', maxCutDb: 4, ratio: 20, thresholdDb: -30 })]).channels[0]) - DRY_DB;
  assert.ok(Math.abs(b - 4) < 0.4, `boost -> ${b.toFixed(2)}`);
});

test('soft knee starts acting below threshold', () => {
  assert.equal(softKneeOver(-1, 0), 0);
  assert.ok(softKneeOver(-1, 6) > 0);
  assert.equal(softKneeOver(5, 6), 5);
  const hard = rmsDb(render(tone(1000, 0.5), [band({ thresholdDb: -5, kneeDb: 0 })]).channels[0]) - DRY_DB;
  const soft = rmsDb(render(tone(1000, 0.5), [band({ thresholdDb: -5, kneeDb: 8 })]).channels[0]) - DRY_DB;
  assert.ok(Math.abs(hard) < 0.05 && soft < -0.2, `hard ${hard.toFixed(2)} soft ${soft.toFixed(2)}`);
});

test('channel: a side band ignores a mono signal; a mid band ignores a pure side signal', () => {
  const mono = tone(1000, 0.5);
  const sideOut = render(mono, [band({ channel: 'side', thresholdDb: -40 })]).channels[0];
  assert.ok(Math.abs(rmsDb(sideOut) - DRY_DB) < 0.01);
  const sideSig = tone(1000, 0.5, 1, true);
  const midOut = render(sideSig, [band({ channel: 'mid', thresholdDb: -40 })]).channels[0];
  assert.ok(Math.abs(rmsDb(midOut) - DRY_DB) < 0.01);
  const midOn = render(mono, [band({ channel: 'mid', thresholdDb: -40 })]).channels[0];
  assert.ok(rmsDb(midOn) - DRY_DB < -2);
  const leftOnly = render(mono, [band({ channel: 'left', thresholdDb: -40 })]).channels;
  assert.ok(rmsDb(leftOnly[0]) - DRY_DB < -2 && Math.abs(rmsDb(leftOnly[1]) - DRY_DB) < 0.01);
});

test('sidechain: a custom detector frequency decouples detection from the band', () => {
  const own = rmsDb(render(tone(1000, 0.5), [band({ thresholdDb: -20 })]).channels[0]) - DRY_DB;
  const elsewhere = rmsDb(render(tone(1000, 0.5), [band({ thresholdDb: -20, sidechain: { mode: 'custom', freq: 80, q: 4 } })]).channels[0]) - DRY_DB;
  assert.ok(own < -3 && elsewhere > own + 2, `own ${own.toFixed(2)} vs sidechain@80Hz ${elsewhere.toFixed(2)}`);
});

test('lookahead: time-aligned output and earlier gain reduction on a burst', () => {
  const src = tone(1000, 0.05, 0.5);
  const still = render(src, [band({ thresholdDb: -6, lookaheadMs: 5 })]).channels[0];
  for (let i = 0; i < src[0].length; i++) assert.ok(Math.abs(still[i] - src[0][i]) < 1e-6, `sample ${i} moved`);
  // Burst: quiet then loud at 0.25 s.
  const burst = tone(1000, 0.6, 0.5);
  const onset = Math.round(SR * 0.25);
  for (let i = 0; i < onset; i++) { burst[0][i] *= 0.02; burst[1][i] *= 0.02; }
  const first = (x: Float32Array) => {
    let p = 0;
    for (let i = onset; i < onset + Math.round(SR * 0.004); i++) p += x[i] * x[i];
    return p;
  };
  const none = render(burst, [band({ thresholdDb: -30, attackMs: 1, lookaheadMs: 0 })]).channels[0];
  const ahead = render(burst, [band({ thresholdDb: -30, attackMs: 1, lookaheadMs: 5 })]).channels[0];
  assert.ok(first(ahead) < first(none) * 0.8, 'lookahead should catch the onset');
});

test('curve types: baxandall bass acts on lows, baxandall treble on highs', () => {
  const lows = tone(80, 0.5);
  const highs = tone(9000, 0.5);
  const bass = (src: Float32Array[]) => rmsDb(render(src, [band({ type: 'baxandall-bass', freq: 150, q: 0.8, thresholdDb: -60, sidechain: { mode: 'custom', freq: 1000, q: 0.3 } })]).channels[0]) - rmsDb(src[0]);
  const treble = (src: Float32Array[]) => rmsDb(render(src, [band({ type: 'baxandall-treble', freq: 5000, q: 0.8, thresholdDb: -60, sidechain: { mode: 'custom', freq: 1000, q: 0.3 } })]).channels[0]) - rmsDb(src[0]);
  assert.ok(bass(lows) < -2 && bass(highs) > -0.5);
  assert.ok(treble(highs) < -2 && treble(lows) > -0.5);
  for (const type of ['proportional', 'band-shelf', 'low-shelf', 'high-shelf'] as const) {
    const out = render(tone(1000, 0.5), [band({ type, thresholdDb: -30 })]).channels[0];
    assert.ok(out.every(Number.isFinite), type);
  }
});

test('traces record detector level and gain for the meter and live curve', () => {
  const res = render(tone(1000, 0.5), [band({ ratio: 20, thresholdDb: -40, maxCutDb: -6 })], { traces: true });
  assert.ok(res.dynamicEqTraces && res.dynamicEqTraces.length === 1);
  const t = res.dynamicEqTraces[0];
  assert.equal(t.moduleId, 'deq');
  assert.equal(t.bands[0].id, 'd1');
  const last = t.bands[0].gainDb.length - 1;
  assert.ok(Math.abs(t.bands[0].gainDb[last] + 6) < 0.2);
  assert.ok(t.bands[0].detectorDb[last] > -9 && t.bands[0].detectorDb[last] < -4);
  // Legacy bands are traced too, without changing their output.
  const legacy = { id: 'L', enabled: true, freq: 1000, q: 2, thresholdDb: -30, maxCutDb: -3, attackMs: 10, releaseMs: 100 };
  const a = render(tone(1000, 0.5), [legacy]).channels[0];
  const b = render(tone(1000, 0.5), [legacy], { traces: true });
  assert.deepEqual(Array.from(a), Array.from(b.channels[0]));
  assert.ok(b.dynamicEqTraces![0].bands.length === 1);
  assert.equal(render(tone(1000, 0.5), [legacy]).dynamicEqTraces, undefined);
});

test('dynamic solo is preview-only', () => {
  const src = tone(100, 0.5);
  const soloBand = band({ solo: true, thresholdDb: 0 });
  const exp = render(src, [soloBand]).channels[0];
  assert.ok(Math.abs(rmsDb(exp) - rmsDb(src[0])) < 0.01);
  const aud = render(src, [soloBand], { audition: true }).channels[0];
  assert.ok(rmsDb(aud) < rmsDb(src[0]) - 10);
});
