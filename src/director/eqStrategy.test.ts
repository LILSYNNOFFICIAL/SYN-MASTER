import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer } from '../dsp/analyzer';
import { processChainOffline } from '../dsp/offlineDsp';
import { validateChain } from '../dsp/chainValidation';
import type { AudioAnalysis, DynamicEQBand, EQBand, ProcessorModule } from '../types/mastering';
import { buildExplainableMasterPlan, deriveRefinementCommands, evaluateMultiObjectiveMetrics, resolveObjectiveTarget } from './directorEngine';
import { runQualityControl, QC_TARGET_PROFILES } from '../dsp/qc';
import { createProcessorModule } from '../dsp/chainValidation';
import { measureRumble, planDynamicHighBand, planRumbleHighPass, planSideLowCut } from './eqStrategy';

const SR = 44100;

/** Seeded broadband noise plus optional partials per channel. */
function makeStereo(opts: {
  seconds?: number;
  partials?: Array<{ hz: number; amp: number; rightPhase?: number; rightAmp?: number }>;
  noise?: number;
}): Float32Array[] {
  const n = Math.floor(SR * (opts.seconds ?? 1.5));
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const nz = ((seed / 4294967296) * 2 - 1) * (opts.noise ?? 0.01);
    let l = nz;
    let r = nz;
    for (const p of opts.partials ?? []) {
      l += p.amp * Math.sin(2 * Math.PI * p.hz * t);
      r += (p.rightAmp ?? p.amp) * Math.sin(2 * Math.PI * p.hz * t + (p.rightPhase ?? 0));
    }
    L[i] = l;
    R[i] = r;
  }
  return [L, R];
}

/** Musical-ish centred mix: kick/bass, low-mid, vocal band, some air. */
const BASE_PARTIALS = [
  { hz: 60, amp: 0.18 },
  { hz: 120, amp: 0.1 },
  { hz: 300, amp: 0.05 },
  { hz: 900, amp: 0.08 },
  { hz: 1800, amp: 0.05 },
  { hz: 4000, amp: 0.02 },
  { hz: 9000, amp: 0.008 },
];

/** Same fixture as lowMidRefinement.test.ts (known to read as low-mid masking). */
function makeVocalMix(durationSec: number, mudGain: number): Float32Array[] {
  const n = Math.floor(SR * durationSec);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = 0.7 + 0.3 * Math.sin(2 * Math.PI * 1.5 * t);
    const low = 0.4 * Math.sin(2 * Math.PI * 70 * t);
    const mud = mudGain * (Math.sin(2 * Math.PI * 190 * t) + 0.9 * Math.sin(2 * Math.PI * 270 * t) + 0.7 * Math.sin(2 * Math.PI * 340 * t));
    const vocal = 0.12 * Math.sin(2 * Math.PI * 820 * t) + 0.09 * Math.sin(2 * Math.PI * 1500 * t) + 0.05 * Math.sin(2 * Math.PI * 3100 * t);
    const air = 0.02 * Math.sin(2 * Math.PI * 8200 * t);
    const s = 0.04 * Math.sin(2 * Math.PI * 1200 * t + 0.6);
    L[i] = 0.3 * env * (low + mud + vocal + air + s);
    R[i] = 0.3 * env * (low + mud + vocal + air - s);
  }
  return [L, R];
}

function eqOf(chain: ProcessorModule[]): EQBand[] {
  const eq = chain.find((m) => m.type === 'parametric-eq');
  return ((eq?.params as { bands?: EQBand[] } | undefined)?.bands) ?? [];
}
function dynOf(chain: ProcessorModule[], name?: string): DynamicEQBand[] {
  const dyn = chain.find((m) => m.type === 'dynamic-eq' && (!name || m.name === name));
  return ((dyn?.params as { bands?: DynamicEQBand[] } | undefined)?.bands) ?? [];
}

test('rumble high-pass stays legacy Flat 12 without measured rumble', () => {
  const analysis = analyzeAudioBuffer(makeStereo({ partials: BASE_PARTIALS }), SR);
  assert.equal(measureRumble(analysis).measured, false, 'clean fixture must not read as rumble');
  const plan = buildExplainableMasterPlan({ analysis, objectiveId: 'hip-hop' });
  const hpf = eqOf(plan.chain).find((b) => b.shape === 'highpass' && b.channel === undefined);
  assert.ok(hpf, 'hip-hop objective keeps its headroom high-pass');
  assert.equal(hpf.subtype, undefined, 'no evidence -> legacy band, renders bit-identically');
  assert.equal(hpf.slope, undefined);
});

test('measured rumble gets a Flat 24 dB/oct high-pass (18 for gentle objectives)', () => {
  const rumbly = analyzeAudioBuffer(makeStereo({ partials: [...BASE_PARTIALS, { hz: 22, amp: 0.2 }] }), SR);
  const evidence = measureRumble(rumbly);
  assert.ok(evidence.measured, `22 Hz rumble must be measured: ${JSON.stringify(evidence)}`);

  const streaming = buildExplainableMasterPlan({ analysis: rumbly, objectiveId: 'streaming' });
  const hpf = eqOf(streaming.chain).find((b) => b.shape === 'highpass' && b.channel === undefined);
  assert.ok(hpf, 'measured rumble must add a high-pass even on the streaming objective');
  assert.equal(hpf.subtype, 'flat');
  assert.equal(hpf.slope, 24);

  const transparent = planRumbleHighPass(rumbly, resolveObjectiveTarget('transparent'));
  assert.equal(transparent.band.slope, 18);
  assert.equal(transparent.band.freq, 24);
});

test('decorrelated low end gets a Side-channel low cut and the imager does not stack mono bass', () => {
  const wideBass = makeStereo({
    partials: [
      { hz: 55, amp: 0.2, rightPhase: Math.PI * 0.85 },
      ...BASE_PARTIALS.filter((p) => p.hz > 100),
    ],
  });
  const analysis = analyzeAudioBuffer(wideBass, SR);
  assert.ok(analysis.lowEndCorrelation < 0.5, `fixture low-end correlation ${analysis.lowEndCorrelation}`);
  const plan = buildExplainableMasterPlan({ analysis, objectiveId: 'streaming' });
  const side = eqOf(plan.chain).find((b) => b.channel === 'side');
  assert.ok(side, 'Side-channel low cut expected');
  assert.equal(side.shape, 'highpass');
  assert.equal(side.subtype, 'flat');
  assert.equal(side.slope, 24);
  assert.equal(side.freq, 115);
  const imager = plan.chain.find((m) => m.type === 'stereo-imager');
  if (imager) assert.equal((imager.params as { monoBassBelowHz: number }).monoBassBelowHz, 0);

  // Measured result: the rendered EQ alone makes the low end far more mono.
  const eqOnly = plan.chain.filter((m) => m.type === 'parametric-eq');
  const rendered = processChainOffline(wideBass, SR, eqOnly).channels;
  const after = analyzeAudioBuffer(rendered, SR);
  assert.ok(after.lowEndCorrelation > analysis.lowEndCorrelation + 0.4,
    `low-end correlation ${analysis.lowEndCorrelation.toFixed(2)} -> ${after.lowEndCorrelation.toFixed(2)}`);

  // Correlated low end: no side cut.
  const centred = analyzeAudioBuffer(makeStereo({ partials: BASE_PARTIALS }), SR);
  assert.equal(planSideLowCut(centred), null);
});

test('mud bells use Proportional Q and the dynamic mud band uses a proportional soft-knee curve', () => {
  const muddy = analyzeAudioBuffer(makeVocalMix(1.2, 0.6), SR);
  const plan = buildExplainableMasterPlan({ analysis: muddy, objectiveId: 'streaming' });
  const dMud = dynOf(plan.chain).find((b) => b.id === 'd-mud');
  assert.ok(dMud, 'muddy fixture must get dynamic low-mid control');
  assert.equal(dMud.type, 'proportional');
  assert.equal(dMud.kneeDb, 6);
  for (const bell of eqOf(plan.chain).filter((b) => b.shape === 'bell' && b.freq >= 150 && b.freq <= 400)) {
    assert.equal(bell.subtype, 'proportional');
  }

  // A refinement low-mid bell is Proportional Q too.
  const objective = resolveObjectiveTarget('streaming');
  const post = { ...muddy, zoneEnergyDb: { ...muddy.zoneEnergyDb, lowMid: muddy.zoneEnergyDb.mid + 8 } };
  const qc = runQualityControl(post, post, QC_TARGET_PROFILES[0]);
  const evaluation = evaluateMultiObjectiveMetrics(post, post, objective, qc);
  const emptyEq = createProcessorModule('parametric-eq');
  emptyEq.params = { ...(emptyEq.params as object), bands: [] } as ProcessorModule['params'];
  const { commands } = deriveRefinementCommands(post, post, [emptyEq], objective, qc, evaluation);
  const refineBands = commands.flatMap((c) => (c.op === 'configure' ? ((c.paramsPatch as { bands?: EQBand[] }).bands ?? []) : []));
  const refineBell = refineBands.find((b) => b.id === 'refine-low-mid');
  assert.ok(refineBell);
  assert.equal(refineBell.subtype, 'proportional');
});

test('broad tilt moves use Baxandall shelves; corrective and reference shelves stay Analog', () => {
  const analysis = analyzeAudioBuffer(makeStereo({ partials: BASE_PARTIALS }), SR);
  const dark: AudioAnalysis = { ...analysis, spectralSlopeDbPerOct: -4.5 };
  const darkPlan = buildExplainableMasterPlan({ analysis: dark, objectiveId: 'streaming' });
  const air = eqOf(darkPlan.chain).find((b) => b.id === 'b4');
  assert.ok(air, 'measured dark slope must add an air shelf');
  assert.equal(air.subtype, 'baxandall');
  assert.equal(air.freq, 8000);

  const lean: AudioAnalysis = { ...analysis, zoneEnergyDb: { ...analysis.zoneEnergyDb, bass: analysis.zoneEnergyDb.mid + 1 } };
  const leanPlan = buildExplainableMasterPlan({ analysis: lean, objectiveId: 'electronic' });
  const bass = eqOf(leanPlan.chain).find((b) => b.id === 'b2');
  assert.ok(bass);
  assert.equal(bass.subtype, 'baxandall');
  assert.ok(bass.gain > 0);

  // Reference-matched shelves keep the legacy (Analog) band.
  const reference: AudioAnalysis = {
    ...analysis,
    zoneEnergyDb: { ...analysis.zoneEnergyDb, bass: analysis.zoneEnergyDb.bass + 3, air: analysis.zoneEnergyDb.air - 3 },
  };
  const refPlan = buildExplainableMasterPlan({ analysis, objectiveId: 'streaming', referenceAnalysis: reference });
  for (const band of eqOf(refPlan.chain).filter((b) => b.id === 'b2' || b.id === 'b4')) {
    assert.equal(band.subtype, undefined, `${band.id} must stay legacy Analog when matching a reference`);
  }
});

test('harsh upper-mid resonance gets a soft-knee dynamic bell on the Mid channel for centred material', () => {
  // Same construction as the director's isolated-resonance fixture: broadband noise + one partial.
  const harsh = analyzeAudioBuffer(makeStereo({ seconds: 2, partials: [{ hz: 3100, amp: 0.24 }], noise: 0.018 }), SR);
  const top = harsh.resonances.find((r) => r.freqHz >= 2000 && r.freqHz <= 12000 && r.excessDb >= 6);
  assert.ok(top, 'fixture needs an isolated resonance');
  const plan = buildExplainableMasterPlan({ analysis: harsh, objectiveId: 'streaming' });
  const band = dynOf(plan.chain, 'Dynamic Resonance Control')[0];
  assert.ok(band, 'resonance band expected');
  assert.equal(band.type, 'bell');
  assert.equal(band.kneeDb, 3);
  assert.equal(band.channel, 'mid', `centred fixture (corr ${harsh.phaseCorrelation.toFixed(2)}) -> Mid`);
  assert.ok(band.freq >= 2500 && band.freq <= 3700);

  // Same resonance on a wide image stays Stereo.
  const wide: AudioAnalysis = { ...harsh, phaseCorrelation: 0.4 };
  assert.equal(planDynamicHighBand(wide, top).band.channel, 'stereo');
});

test('sibilance becomes a keyed dynamic high shelf with lookahead, and Restore drops its static de-esser', () => {
  const sibilant = analyzeAudioBuffer(makeStereo({ seconds: 2, partials: [{ hz: 7000, amp: 0.24 }], noise: 0.018 }), SR);
  const top = sibilant.resonances.find((r) => r.freqHz >= 2000 && r.freqHz <= 12000 && r.excessDb >= 6);
  assert.ok(top && top.freqHz >= 4500 && top.freqHz <= 10000, `fixture needs a sibilant resonance: ${JSON.stringify(sibilant.resonances.slice(0, 3))}`);
  const plan = buildExplainableMasterPlan({ analysis: sibilant, objectiveId: 'streaming' });
  const band = dynOf(plan.chain, 'Dynamic De-Esser')[0];
  assert.ok(band, 'de-esser band expected');
  assert.equal(band.type, 'high-shelf');
  assert.equal(band.sidechain?.mode, 'custom');
  assert.ok(Math.abs((band.sidechain?.freq ?? 0) - top.freqHz) < 1);
  assert.equal(band.lookaheadMs, 2);
  assert.equal(band.kneeDb, 4);
  assert.ok(band.attackMs <= 3);
  assert.ok(band.maxCutDb < 0 && band.maxCutDb >= -4.5);
  const restore = plan.chain.find((m) => m.type === 'restore');
  if (restore) assert.equal((restore.params as { deEssAmount: number }).deEssAmount, 8, 'no second de-esser stacked');
});

test('new EQ fields survive chain validation and the planned chain renders finite audio', () => {
  const source = makeStereo({
    partials: [
      { hz: 22, amp: 0.15 },
      { hz: 55, amp: 0.2, rightPhase: Math.PI * 0.85 },
      ...BASE_PARTIALS.filter((p) => p.hz > 100),
      { hz: 7000, amp: 0.18 },
    ],
  });
  const analysis = analyzeAudioBuffer(source, SR);
  const plan = buildExplainableMasterPlan({ analysis, objectiveId: 'streaming' });
  const validated = validateChain(plan.chain);
  assert.deepEqual(eqOf(validated), eqOf(plan.chain), 'validation must keep subtype/slope/channel');
  assert.deepEqual(dynOf(validated), dynOf(plan.chain), 'validation must keep Dynamic EQ type/knee/channel/sidechain');
  const out = processChainOffline(source, SR, plan.chain).channels;
  assert.ok(out.every((ch) => ch.every(Number.isFinite)));
});
