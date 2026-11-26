import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer } from '../dsp/analyzer';
import { createProcessorModule } from '../dsp/chainValidation';
import { processChainOffline, lastLimiterClampCount } from '../dsp/offlineDsp';
import { runQualityControl, QC_TARGET_PROFILES } from '../dsp/qc';
import { MUD_CORRECTION_HZ, MUD_REGION_HZ } from '../dsp/bandMap';
import type { EQBand, ProcessorModule } from '../types/mastering';
import { analyzeTrackIntelligence, computeRegionEnergyDb, getDiagnosisThresholds } from './analyzeIntelligence';
import { applyStructuredChainCommands } from './chainCommands';
import {
  buildExplainableMasterPlan,
  deriveRefinementCommands,
  evaluateMultiObjectiveMetrics,
  resolveObjectiveTarget,
  runAutonomousDirectorLoop,
} from './directorEngine';
import { verifyPostFixAnalysis } from './postFixVerification';

const SR = 44100;

function makeVocalMix(durationSec = 1.2, mudGain = 0.5): Float32Array[] {
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

function shifted(base: ReturnType<typeof analyzeAudioBuffer>, lowMidVsMid: number) {
  return { ...base, zoneEnergyDb: { ...base.zoneEnergyDb, lowMid: base.zoneEnergyDb.mid + lowMidVsMid } };
}

function eqBands(module: ProcessorModule | undefined): EQBand[] {
  return ((module?.params as { bands?: EQBand[] } | undefined)?.bands) ?? [];
}

test('Refinement adds a low-mid bell when the mud reading stays above its limit', () => {
  const base = analyzeAudioBuffer(makeVocalMix(1.0, 0.2), SR);
  const objective = resolveObjectiveTarget('streaming');
  const limit = getDiagnosisThresholds(objective).lowMidBuildupLimit;
  const pre = shifted(base, limit + 1.6);
  const post = shifted(base, limit + 1.2);
  const qc = runQualityControl(pre, post, QC_TARGET_PROFILES[0]);
  const evaluation = evaluateMultiObjectiveMetrics(pre, post, objective, qc);
  const eq = createProcessorModule('parametric-eq');

  const { commands } = deriveRefinementCommands(pre, post, [eq], objective, qc, evaluation);
  const eqCommand = commands.find((c) => c.op === 'configure' && c.processorType === 'parametric-eq');
  assert.ok(eqCommand && eqCommand.op === 'configure', 'Low-mid excess must produce an EQ refinement');
  const bell = ((eqCommand.paramsPatch as { bands: EQBand[] }).bands).find(
    (b) => b.shape === 'bell' && b.freq >= MUD_CORRECTION_HZ.min && b.freq <= MUD_CORRECTION_HZ.max,
  );
  assert.ok(bell, 'Refinement must target the 200-360 Hz mud region');
  assert.ok(bell.gain <= -0.5 && bell.gain >= -1.0, `Step must be restrained, got ${bell.gain} dB`);
});

test('Repeated low-mid refinement never digs past -4 dB', () => {
  const base = analyzeAudioBuffer(makeVocalMix(1.0, 0.2), SR);
  const objective = resolveObjectiveTarget('streaming');
  const limit = getDiagnosisThresholds(objective).lowMidBuildupLimit;
  const pre = shifted(base, limit + 6);
  const post = shifted(base, limit + 6);
  const qc = runQualityControl(pre, post, QC_TARGET_PROFILES[0]);
  const evaluation = evaluateMultiObjectiveMetrics(pre, post, objective, qc);
  let chain: ProcessorModule[] = [createProcessorModule('parametric-eq')];
  for (let pass = 0; pass < 10; pass++) {
    const { commands } = deriveRefinementCommands(pre, post, chain, objective, qc, evaluation);
    const eqCommands = commands.filter((c) => 'processorType' in c && c.processorType === 'parametric-eq');
    assert.ok(eqCommands.length <= 1, 'Bass and low-mid steps must share one EQ command');
    chain = applyStructuredChainCommands(chain, eqCommands).chain;
  }
  const bells = eqBands(chain.find((m) => m.type === 'parametric-eq')).filter(
    (b) => b.shape === 'bell' && b.freq >= MUD_CORRECTION_HZ.min && b.freq <= MUD_CORRECTION_HZ.max,
  );
  assert.equal(bells.length, 1, 'Refinement must deepen one bell, not stack new ones');
  assert.ok(bells[0].gain >= -4 && bells[0].gain <= -3.5, `Expected the -4 dB cap to be reached, got ${bells[0].gain}`);
});

test('Low-mid refinement stays off when the midrange is already hollow', () => {
  const base = analyzeAudioBuffer(makeVocalMix(1.0, 0.0), SR);
  const objective = resolveObjectiveTarget('streaming');
  const post = shifted(base, -5);
  const qc = runQualityControl(post, post, QC_TARGET_PROFILES[0]);
  const evaluation = evaluateMultiObjectiveMetrics(post, post, objective, qc);
  const { commands } = deriveRefinementCommands(post, post, [createProcessorModule('parametric-eq')], objective, qc, evaluation);
  const bands = commands.flatMap((c) => (c.op === 'configure' ? ((c.paramsPatch as { bands?: EQBand[] }).bands ?? []) : []));
  assert.ok(!bands.some((b) => b.id === 'refine-low-mid'), 'No low-mid cut on a hollow mix');
});

test('Initial plan uses a dynamic 250 Hz band for low-mid masking', () => {
  const analysis = analyzeAudioBuffer(makeVocalMix(1.2, 0.6), SR);
  const plan = buildExplainableMasterPlan({ analysis, objectiveId: 'streaming' });
  const dyn = plan.chain.find((m) => m.type === 'dynamic-eq' && (m.params as { bands: Array<{ id: string }> }).bands.some((b) => b.id === 'd-mud'));
  assert.ok(dyn, 'Muddy mix must get Dynamic Low-Mid Control');
  const band = (dyn!.params as { bands: Array<{ freq: number; q: number; maxCutDb: number }> }).bands[0];
  assert.equal(band.freq, 250);
  assert.ok(band.maxCutDb >= -3 && band.maxCutDb < 0, `Max cut must be capped at -3 dB, got ${band.maxCutDb}`);
});

test('Reference track calibrates mud thresholds upward, never below defaults', () => {
  const objective = resolveObjectiveTarget('streaming');
  const defaults = getDiagnosisThresholds(objective);
  const darkRef = analyzeAudioBuffer(makeVocalMix(1.0, 0.8), SR);
  const calibrated = getDiagnosisThresholds(objective, darkRef);
  const refRegion = computeRegionEnergyDb(darkRef, MUD_REGION_HZ[0], MUD_REGION_HZ[1])! - darkRef.zoneEnergyDb.mid;
  assert.ok(calibrated.region150To400VsMidLimit >= defaults.region150To400VsMidLimit);
  assert.ok(Math.abs(calibrated.region150To400VsMidLimit - Math.max(defaults.region150To400VsMidLimit, refRegion + 1)) < 1e-9);
  const brightRef = analyzeAudioBuffer(makeVocalMix(1.0, 0.0), SR);
  assert.equal(getDiagnosisThresholds(objective, brightRef).lowMidBuildupLimit, defaults.lowMidBuildupLimit);
});

test('Mud verification reports absolute band changes and warns when Mid fell', () => {
  const objective = resolveObjectiveTarget('streaming');
  const baseline = analyzeAudioBuffer(makeVocalMix(1.2, 0.6), SR);
  const post = { ...baseline, zoneEnergyDb: { ...baseline.zoneEnergyDb, mid: baseline.zoneEnergyDb.mid - 2.5 } };
  const report = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    postAnalysis: post,
    objective,
    baselineAnalysisId: 'baseline-mud',
    postAnalysisId: 'post-mud',
    currentChainFingerprint: 'mud-fingerprint',
    postChainFingerprint: 'mud-fingerprint',
    postProcessingStatus: 'ready',
  });
  const mud = [...report.activeFindings, ...report.resolvedFindings].find((f) => f.findingId === 'diag-mud');
  assert.ok(mud, 'Baseline mud finding must be verified');
  const summary = JSON.stringify(mud);
  assert.match(summary, /Level-matched band change/);
  assert.match(summary, /Mid fell 2\.5 dB/);
});

test('Limiter ramps into transients instead of stepping, and holds the true-peak ceiling', () => {
  const sr = 48000;
  const n = sr * 2;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const level = t % 0.5 < 0.25 ? 0.25 : 1.0;
    l[i] = level * (0.9 * Math.sin(2 * Math.PI * 90 * t) + 0.6 * Math.sin(2 * Math.PI * 1300 * t));
    r[i] = l[i] * 0.95;
  }
  const limiter = createProcessorModule('limiter', {
    params: { ceilingDb: -1, thresholdDb: -6, releaseMs: 80, lookaheadMs: 3, truePeak: true, oversampling: 4 },
  } as Partial<ProcessorModule>);
  const out = processChainOffline([l, r], sr, [limiter]).channels[0];
  const ceiling = Math.pow(10, -1 / 20);
  let peak = 0;
  let maxJump = 0;
  let prev = Number.NaN;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, Math.abs(out[i]));
    if (Math.abs(l[i]) > 0.2) {
      const g = out[i] / l[i];
      if (!Number.isNaN(prev)) maxJump = Math.max(maxJump, Math.abs(g - prev));
      prev = g;
    } else prev = Number.NaN;
  }
  assert.ok(peak <= ceiling * 1.000001, `Sample peak ${peak} over ceiling ${ceiling}`);
  assert.ok(maxJump < 0.03, `Gain must ramp smoothly; largest per-sample change ${maxJump.toFixed(4)}`);
  assert.equal(lastLimiterClampCount, 0, 'The safety clamp should not be needed');
});

test('Fix All reduces 150-400 Hz masking on a muddy vocal mix without hollowing it', async () => {
  const source = makeVocalMix(1.2, 0.6);
  const baseline = analyzeAudioBuffer(source, SR);
  const report = await runAutonomousDirectorLoop({
    sourceChannels: source,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    maxIterations: 4,
  });
  const post = report.postAnalysis;
  const preRegion = computeRegionEnergyDb(baseline, MUD_REGION_HZ[0], MUD_REGION_HZ[1])! - baseline.zoneEnergyDb.mid;
  const postRegion = computeRegionEnergyDb(post, MUD_REGION_HZ[0], MUD_REGION_HZ[1])! - post.zoneEnergyDb.mid;
  console.log(`# Fix All mud: 150-400 vs Mid ${preRegion.toFixed(1)} -> ${postRegion.toFixed(1)} dB, Low-Mid vs Mid ${(baseline.zoneEnergyDb.lowMid - baseline.zoneEnergyDb.mid).toFixed(1)} -> ${(post.zoneEnergyDb.lowMid - post.zoneEnergyDb.mid).toFixed(1)} dB, Mid ${(post.zoneEnergyDb.mid - baseline.zoneEnergyDb.mid).toFixed(1)} dB, TP ${post.truePeakDb.toFixed(2)}, passes ${report.iterationsExecuted ?? ''}`);
  assert.ok(postRegion <= preRegion - 1.0, `150-400 Hz vs Mid must drop by at least 1 dB (${preRegion.toFixed(1)} -> ${postRegion.toFixed(1)})`);
  assert.ok(post.truePeakDb <= report.objective.maxTruePeakDb + 0.08, `True peak ${post.truePeakDb}`);
  const diag = analyzeTrackIntelligence(post, report.objective);
  assert.ok(!diag.findings.some((f) => f.id === 'diag-hollow-lowmid'), 'Must not over-cut into a hollow midrange');
});
