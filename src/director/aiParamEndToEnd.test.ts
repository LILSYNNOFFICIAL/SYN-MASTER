/**
 * End-to-end proof that the AI really drives every tool and every setting.
 *
 * For each processor type and each parameter in PROCESSOR_PARAM_LIMITS (plus the module-level
 * controls and on/off flags) a mocked AI module goes through the real path a Fix All run uses:
 *
 *   AI JSON → parseAiChain (validation/clamping) → mergeAiChainWithRequiredModules →
 *   hydrateMatchEqChain (the Director's Match EQ guard) → processChainOffline (the real render)
 *
 * and the test asserts
 *   (a) the rendered chain carries the AI's value, or the change is a recorded AI parameter
 *       correction / Director override (never silent), and
 *   (b) changing that one value changes the rendered audio, unless the parameter is listed in
 *       INERT_FOR_TEST_SIGNAL with the reason it cannot change this test signal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROCESSOR_PARAM_LIMITS } from '../dsp/chainValidation';
import { processChainOffline } from '../dsp/offlineDsp';
import { learnMatchEqSpectrum } from '../dsp/matchEq';
import { fingerprintStereo, registerRebalanceStems, unregisterRebalanceStems } from '../dsp/vocalRebalance';
import { parseAiChain } from '../ai/masteringPrompt';
import type { DirectorOverride, ProcessorModule, ProcessorType } from '../types/mastering';
import { mergeAiChainWithRequiredModules } from './directorEngine';
import { hydrateMatchEqChain, type MatchEqProfile } from './matchEqDirector';
import { recordStageOverrides } from './directorOverrides';

const SR = 44100;
const N = Math.floor(SR * 0.75);

// ---- Test signal: stems (vocal-ish tones, bass, drums) + independent side noise, hum, DC ----
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}
function buildSignal() {
  const r = rng(7);
  const vocals: [Float32Array, Float32Array] = [new Float32Array(N), new Float32Array(N)];
  const bass: [Float32Array, Float32Array] = [new Float32Array(N), new Float32Array(N)];
  const drums: [Float32Array, Float32Array] = [new Float32Array(N), new Float32Array(N)];
  const other: [Float32Array, Float32Array] = [new Float32Array(N), new Float32Array(N)];
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t);
    const v = env * (0.12 * Math.sin(2 * Math.PI * 1000 * t) + 0.08 * Math.sin(2 * Math.PI * 3100 * t) + 0.04 * Math.sin(2 * Math.PI * 6800 * t));
    vocals[0][i] = v; vocals[1][i] = v;
    const b = 0.22 * Math.sin(2 * Math.PI * 55 * t) + 0.1 * Math.sin(2 * Math.PI * 120 * t);
    bass[0][i] = b; bass[1][i] = b;
    const phase = i % Math.floor(SR * 0.125);
    const d = phase < 400 ? 0.5 * Math.exp(-phase / 80) * (r() * 2) : 0;
    drums[0][i] = d; drums[1][i] = d * 0.9;
    // Hiss, 10-14 kHz shimmer, mains hum and a little DC, decorrelated L/R (side content).
    const hissL = 0.02 * r();
    const hissR = 0.02 * r();
    const hum = 0.01 * Math.sin(2 * Math.PI * 60 * t);
    const shimmer = 0.015 * Math.sin(2 * Math.PI * 11800 * t + 2 * Math.sin(2 * Math.PI * 7 * t));
    other[0][i] = hissL + hum + shimmer + 0.004 + 0.03 * Math.sin(2 * Math.PI * 450 * t);
    other[1][i] = hissR + hum - shimmer + 0.004 - 0.03 * Math.sin(2 * Math.PI * 450 * t);
  }
  const mix: Float32Array[] = [new Float32Array(N), new Float32Array(N)];
  for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) mix[c][i] = vocals[c][i] + bass[c][i] + drums[c][i] + other[c][i];
  // A few clicks for de-click / de-crackle / spike repair.
  for (const at of [0.2, 0.41, 0.6]) {
    const k = Math.floor(at * SR);
    mix[0][k] += 0.6; mix[1][k] -= 0.5; mix[0][k + 1] -= 0.4;
  }
  return { mix, vocals, bass, drums };
}
const SIGNAL = buildSignal();

function reference(): Float32Array[] {
  const r = rng(99);
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const v = 0.05 * Math.sin(2 * Math.PI * 80 * t) + 0.2 * Math.sin(2 * Math.PI * 2500 * t) + 0.08 * r();
    L[i] = v; R[i] = v * 0.95 + 0.02 * r();
  }
  return [L, R];
}
const MATCH_PROFILE: MatchEqProfile = {
  source: learnMatchEqSpectrum(SIGNAL.mix, SR)!,
  reference: learnMatchEqSpectrum(reference(), SR)!,
  referenceName: 'synthetic reference',
};

// ---- Active base settings per processor (so every control has something to act on) ----
type Params = Record<string, unknown>;
const BASE: Record<string, Params> = {
  'parametric-eq': { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, bands: [{ id: 'b1', enabled: true, shape: 'bell', freq: 1000, gain: 6, q: 1 }] },
  'dynamic-eq': { bands: [{ id: 'd1', enabled: true, type: 'bell', freq: 3000, q: 1.5, thresholdDb: -40, maxCutDb: -6, ratio: 4, mode: 'cut', kneeDb: 6, attackMs: 10, releaseMs: 100, lookaheadMs: 0, channel: 'stereo' }] },
  compressor: { mode: 'downward', thresholdDb: -24, ratio: 3, attackMs: 10, releaseMs: 120, kneeDb: 4, makeupDb: 1, scHpfHz: 60 },
  'multiband-comp': {
    lowCrossHz: 200, highCrossHz: 3000,
    low: { thresholdDb: -30, ratio: 3, attackMs: 20, releaseMs: 150, gainDb: 0, bypass: false },
    mid: { thresholdDb: -30, ratio: 3, attackMs: 15, releaseMs: 120, gainDb: 0, bypass: false },
    high: { thresholdDb: -30, ratio: 3, attackMs: 8, releaseMs: 80, gainDb: 0, bypass: false },
  },
  saturation: { flavor: 'tape', drive: 40, tone: 0, harmonics: 'balanced', oversampling: 2 },
  'stereo-imager': { lowWidth: 85, midWidth: 108, highWidth: 118, lowCrossHz: 160, highCrossHz: 3500, monoBassBelowHz: 95, lrBalanceDb: 0, midSideGainDb: 0 },
  restore: { dcOffset: true, humRemovalHz: 0, hissReduction: 20, deEssAmount: 30, deEssFreqHz: 6500, resonanceSuppress: 20, mode: 'conservative', declick: 30, decrackle: 20, spikeRepair: true, deShimmer: 20 },
  'bass-enhancer': { subFreqHz: 55, subGainDb: 2, harmonicDrive: 30, tightness: 55, monoFocus: true },
  limiter: { ceilingDb: -1, thresholdDb: -10, releaseMs: 90, lookaheadMs: 3, truePeak: true, oversampling: 2 },
  maximizer: { character: 'transparent', targetLufs: -12, ceilingDb: -1, transientEmphasis: 25, truePeak: true },
  'transient-shaper': { attackDb: 3, sustainDb: -2, speedMs: 15, lowCutHz: 80 },
  clipper: { ceilingDb: -3, driveDb: 3, softness: 50, oversampling: 2 },
  'multiband-maximizer': {
    lowCrossHz: 150, highCrossHz: 4000,
    // Enough drive that the output limiter (ceilingDb/releaseMs) actually works on this signal.
    low: { preGainDb: 6, thresholdDb: -20, ratio: 3, attackMs: 25, releaseMs: 160, postGainDb: 0, bypass: false },
    mid: { preGainDb: 6, thresholdDb: -20, ratio: 3, attackMs: 12, releaseMs: 120, postGainDb: 0, bypass: false },
    // The test signal's 4 kHz+ band sits near -30 dBFS, so its threshold starts below that.
    high: { preGainDb: 3, thresholdDb: -34, ratio: 3, attackMs: 6, releaseMs: 90, postGainDb: 0, bypass: false },
    ceilingDb: -1, releaseMs: 80,
  },
  dither: { bitDepth: 16, shape: 'tpdf', autoBlank: true },
  'match-eq': { amount: 30, smoothing: 3, maxBoostDb: 1, maxCutDb: 1, lowHz: 30, highHz: 18000, channel: 'stereo', phase: 'linear' },
  'vocal-rebalance': { vocalGainDb: 2, bassEnabled: true, bassGainDb: -2, drumsEnabled: true, drumsGainDb: 1, sensitivity: 30, smoothingMs: 40 },
};

interface Case {
  type: ProcessorType;
  /** Path inside params ("bands[0].thresholdDb") or a module field ("@wetDry"). */
  path: string;
  variant: unknown;
  /** Base-params adjustment so this control has an effect (e.g. a highpass shape for slope). */
  prepare?: (p: Params) => void;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
function setPath(obj: Params, path: string, value: unknown): void {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined || cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function isRange(v: unknown): v is readonly [number, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number';
}
function pickRange([a, b]: readonly [number, number], base: unknown): number {
  const lo = a + 0.25 * (b - a);
  const hi = a + 0.75 * (b - a);
  const v = typeof base === 'number' && Math.abs(base - lo) > Math.abs(base - hi) ? lo : hi;
  return Math.round(v * 100) / 100;
}
function pickEnum(values: readonly unknown[], base: unknown): unknown {
  return values.find((v) => v !== base) ?? values[0];
}

/** Click repair stages share one detector target: switch the others off to see each one alone. */
const isolateRepair = (p: Params) => { p.declick = 0; p.decrackle = 0; p.spikeRepair = false; };

const SKIP_KEYS = new Set(['maxBands', 'highCrossMinOffsetHz', 'highCrossMaxHz', 'band']);

/** Every parameter of PROCESSOR_PARAM_LIMITS, as concrete AI cases. */
function buildCases(): Case[] {
  const cases: Case[] = [];
  const L = PROCESSOR_PARAM_LIMITS as unknown as Record<string, Record<string, unknown>>;
  for (const type of Object.keys(L)) {
    if (type === 'module') continue;
    const t = type as ProcessorType;
    const lim = L[type];
    const base = BASE[type];
    const add = (path: string, spec: unknown, prepare?: Case['prepare']) => {
      const p = structuredClone(base);
      prepare?.(p);
      const cur = getPath(p, path);
      const variant = isRange(spec) ? pickRange(spec, cur) : Array.isArray(spec) ? pickEnum(spec, cur) : spec;
      cases.push({ type: t, path, variant, prepare });
    };
    for (const [key, spec] of Object.entries(lim)) {
      if (SKIP_KEYS.has(key)) continue;
      // De-crackle only acts on clicks De-click left behind: test it with De-click off.
      add(key, spec, type === 'restore' && key === 'decrackle' ? isolateRepair : undefined);
    }
    if ('highCrossMaxHz' in lim) {
      const lowMin = (lim.lowCrossHz as [number, number])[0];
      add('highCrossHz', [lowMin + Number(lim.highCrossMinOffsetHz), Number(lim.highCrossMaxHz)]);
    }
    const band = lim.band as Record<string, unknown> | undefined;
    if (!band) continue;
    if (type === 'parametric-eq') {
      for (const [k, spec] of Object.entries(band)) {
        if (k === 'subtype') {
          // Proportional Q equals a plain bell at exactly 6 dB by design, so test it at +9 dB.
          add('bands[0].subtype', 'proportional', (p) => setPath(p, 'bands[0].gain', 9));
          add('bands[0].subtype', 'band-shelf');
          add('bands[0].subtype', 'vintage', (p) => setPath(p, 'bands[0].shape', 'lowshelf'));
          add('bands[0].subtype', 'resonant', (p) => { setPath(p, 'bands[0].shape', 'highpass'); setPath(p, 'bands[0].freq', 400); });
        } else if (k === 'slope') {
          add('bands[0].slope', 48, (p) => { setPath(p, 'bands[0].shape', 'highpass'); setPath(p, 'bands[0].freq', 400); });
        } else if (k === 'channel') {
          add('bands[0].channel', spec, (p) => setPath(p, 'bands[0].channel', 'stereo'));
        } else {
          add(`bands[0].${k}`, spec);
        }
      }
    } else if (type === 'dynamic-eq') {
      for (const [k, spec] of Object.entries(band)) {
        if (k === 'maxCutDbCut') add('bands[0].maxCutDb', spec);
        else if (k === 'maxCutDbBoost') add('bands[0].maxCutDb', spec, (p) => { setPath(p, 'bands[0].mode', 'boost'); setPath(p, 'bands[0].maxCutDb', 3); });
        else if (k === 'sidechainMode') add('bands[0].sidechain.mode', 'custom', (p) => setPath(p, 'bands[0].sidechain', { mode: 'band', freq: 9000, q: 2 }));
        else if (k === 'sidechainFreq') add('bands[0].sidechain.freq', spec, (p) => setPath(p, 'bands[0].sidechain', { mode: 'custom', freq: 9000, q: 2 }));
        else if (k === 'sidechainQ') add('bands[0].sidechain.q', spec, (p) => setPath(p, 'bands[0].sidechain', { mode: 'custom', freq: 9000, q: 2 }));
        else add(`bands[0].${k}`, spec);
      }
    } else {
      for (const name of ['low', 'mid', 'high']) for (const [k, spec] of Object.entries(band)) add(`${name}.${k}`, spec);
    }
  }
  // Booleans that live in the params but not in the limits table.
  const bools: Array<[ProcessorType, string, Case['prepare']?]> = [
    ['parametric-eq', 'autoGain'], ['parametric-eq', 'bands[0].enabled'], ['dynamic-eq', 'bands[0].enabled'],
    ['multiband-comp', 'low.bypass'], ['multiband-maximizer', 'mid.bypass'], ['restore', 'dcOffset'], ['restore', 'spikeRepair', isolateRepair],
    ['bass-enhancer', 'monoFocus'], ['limiter', 'truePeak'], ['maximizer', 'truePeak'], ['dither', 'autoBlank'],
    ['vocal-rebalance', 'bassEnabled'], ['vocal-rebalance', 'drumsEnabled'],
  ];
  for (const [t, path, prepare] of bools) {
    const p = structuredClone(BASE[t]);
    prepare?.(p);
    const cur = getPath(p, path);
    cases.push({ type: t, path, variant: cur === undefined ? true : !cur, prepare });
  }
  // Module-level controls and the new enabled/bypassed flags.
  const M = PROCESSOR_PARAM_LIMITS.module;
  cases.push({ type: 'compressor', path: '@intensity', variant: pickRange(M.intensity, 100) });
  cases.push({ type: 'compressor', path: '@wetDry', variant: pickRange(M.wetDry, 100) });
  cases.push({ type: 'compressor', path: '@inputGainDb', variant: pickRange(M.inputGainDb, 0) });
  cases.push({ type: 'compressor', path: '@outputGainDb', variant: pickRange(M.outputGainDb, 0) });
  cases.push({ type: 'compressor', path: '@enabled', variant: false });
  cases.push({ type: 'compressor', path: '@bypassed', variant: true });
  return cases;
}

/**
 * Controls that cannot change THIS test render, with the reason. Every entry was checked by
 * hand; anything not listed here must audibly change the rendered audio.
 */
// Empty on purpose: with the active base settings above, every control changes the render.
// (Proportional Q equals a plain bell at exactly 6 dB by design, so that case runs at +9 dB.)
const INERT_FOR_TEST_SIGNAL: Record<string, string> = {};

interface Rendered { chain: ProcessorModule[]; out: Float32Array[]; corrections: string[] }

function runAi(type: ProcessorType, params: Params, moduleFields: Record<string, unknown> = {}): Rendered {
  const raw = {
    type, name: `AI ${type}`, intensity: 100, wetDry: 100, reason: 'mock AI',
    ...moduleFields,
    paramsJson: JSON.stringify(params),
  } as Parameters<typeof parseAiChain>[0][number];
  const parsed = parseAiChain([raw]);
  const aiIds = new Set(parsed.chain.map((m) => m.id));
  const overrides: DirectorOverride[] = [];
  const merged = mergeAiChainWithRequiredModules(parsed.chain, []);
  recordStageOverrides(overrides, { pass: 0, stage: 'required-modules-merge', before: parsed.chain, after: merged, aiIds, reasonFor: () => 'merge' });
  const prepared = hydrateMatchEqChain(merged, MATCH_PROFILE, { dropUnlearned: true, conservative: true });
  recordStageOverrides(overrides, { pass: 0, stage: 'match-eq-guard', before: merged, after: prepared, aiIds, reasonFor: () => 'match-eq guard' });
  const out = processChainOffline(SIGNAL.mix, SR, prepared, null).channels;
  return {
    chain: prepared,
    out,
    corrections: [...parsed.paramCorrections.map((c) => c.parameter), ...overrides.map((o) => o.parameter)],
  };
}

function maxAbsDiff(a: Float32Array[], b: Float32Array[]): number {
  let m = 0;
  for (let c = 0; c < a.length; c++) for (let i = 0; i < a[c].length; i++) m = Math.max(m, Math.abs(a[c][i] - b[c][i]));
  return m;
}

test('E2E: every AI processor type and every PROCESSOR_PARAM_LIMITS parameter reaches the render and changes the audio', () => {
  const stemFingerprint = fingerprintStereo(SIGNAL.mix[0], SIGNAL.mix[1], SR);
  registerRebalanceStems({ fingerprint: stemFingerprint, sampleRate: SR, length: N, stems: { vocals: SIGNAL.vocals, bass: SIGNAL.bass, drums: SIGNAL.drums } });
  try {
    const cases = buildCases();
    const rows: Array<{ id: string; carried: string; effect: string }> = [];
    const silentlyDropped: string[] = [];
    const noEffect: string[] = [];
    const typesCovered = new Set<string>();
    for (const c of cases) {
      const id = `${c.type}:${c.path}`;
      typesCovered.add(c.type);
      const baseParams = structuredClone(BASE[c.type]);
      c.prepare?.(baseParams);
      const variantParams = structuredClone(baseParams);
      const moduleField = c.path.startsWith('@') ? c.path.slice(1) : null;
      if (!moduleField) setPath(variantParams, c.path, c.variant);
      const base = runAi(c.type, baseParams);
      const variant = runAi(c.type, variantParams, moduleField ? { [moduleField]: c.variant } : {});
      const repeat = runAi(c.type, baseParams);
      assert.equal(maxAbsDiff(base.out, repeat.out), 0, `${id}: the render must be deterministic`);

      // (a) the rendered chain carries the AI value, or the change was recorded.
      const mod = variant.chain.find((m) => m.type === c.type);
      const finalValue = !mod ? undefined : moduleField ? (mod as unknown as Record<string, unknown>)[moduleField] : getPath(mod.params, c.path);
      const carried = mod !== undefined && JSON.stringify(finalValue) === JSON.stringify(c.variant);
      const correctionPath = moduleField ?? `params.${c.path}`;
      const logged = variant.corrections.some((p) => p === correctionPath || correctionPath.startsWith(`${p}.`) || correctionPath.startsWith(`${p}[`));
      const carriedText = carried ? 'carried' : logged ? `corrected+logged (final ${JSON.stringify(finalValue)})` : `SILENT (final ${JSON.stringify(finalValue)})`;
      if (!carried && !logged) silentlyDropped.push(`${id} AI ${JSON.stringify(c.variant)} → ${JSON.stringify(finalValue)}`);

      // (b) the value changes the rendered audio.
      const diff = maxAbsDiff(base.out, variant.out);
      const effect = diff > 1e-7 ? `changes audio (max |Δ| ${diff.toExponential(2)})` : INERT_FOR_TEST_SIGNAL[id] ? `inert: ${INERT_FOR_TEST_SIGNAL[id]}` : 'NO EFFECT';
      if (diff <= 1e-7 && !INERT_FOR_TEST_SIGNAL[id]) noEffect.push(`${id} (${JSON.stringify(getPath(baseParams, c.path))} → ${JSON.stringify(c.variant)})`);
      rows.push({ id, carried: carriedText, effect });
    }
    if (process.env.SYN_E2E_TABLE) {
      for (const r of rows) console.log(`${r.id.padEnd(48)} ${r.carried.padEnd(40)} ${r.effect}`);
    }
    const allTypes = Object.keys(PROCESSOR_PARAM_LIMITS).filter((k) => k !== 'module');
    assert.deepEqual([...typesCovered].sort(), allTypes.sort(), 'every processor type is exercised');
    assert.deepEqual(silentlyDropped, [], `AI values silently dropped or changed:\n${silentlyDropped.join('\n')}`);
    assert.deepEqual(noEffect, [], `AI values with no effect on the render:\n${noEffect.join('\n')}`);
    // Every documented inert entry must still be a real case (no stale allowlist).
    for (const id of Object.keys(INERT_FOR_TEST_SIGNAL)) assert.ok(rows.some((r) => r.id === id), `stale INERT entry ${id}`);
  } finally {
    unregisterRebalanceStems(stemFingerprint);
  }
});

test('E2E: a module the AI switches off or bypasses is rendered as a pass-through', () => {
  for (const flag of [{ enabled: false }, { bypassed: true }]) {
    const { chain, out } = runAi('compressor', BASE.compressor, flag);
    assert.equal(chain.length, 1);
    assert.equal(maxAbsDiff(out, SIGNAL.mix), 0, `${JSON.stringify(flag)} renders the source unchanged`);
  }
});
