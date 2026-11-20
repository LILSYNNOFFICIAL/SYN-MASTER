import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer } from '../dsp/analyzer';
import { analyzeStemSet } from '../dsp/stemAnalysis';
import { createProcessorModule } from '../dsp/chainValidation';
import { runQualityControl, QC_TARGET_PROFILES } from '../dsp/qc';
import type { AiChainLifecycleState, MasteringObjectiveId } from '../types/mastering';
import { analyzeTrackIntelligence } from './analyzeIntelligence';
import { applyStructuredChainCommands } from './chainCommands';
import {
  buildExplainableMasterPlan,
  deriveRefinementCommands,
  evaluateMultiObjectiveMetrics,
  resolveObjectiveTarget,
  runAutonomousDirectorLoop,
} from './directorEngine';
import {
  VERIFIED_NATIVE_PROCESSOR_INVENTORY,
  validateChainAgainstInventory,
} from './processorInventory';

const SR = 44100;

function makeBalancedStereo(durationSec = 1.2, gain = 0.22): Float32Array[] {
  const n = Math.floor(SR * durationSec);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = 0.65 + 0.35 * Math.sin(2 * Math.PI * 2.0 * t);
    const body =
      0.48 * Math.sin(2 * Math.PI * 65 * t) +
      0.32 * Math.sin(2 * Math.PI * 220 * t) +
      0.24 * Math.sin(2 * Math.PI * 880 * t) +
      0.16 * Math.sin(2 * Math.PI * 2800 * t) +
      0.08 * Math.sin(2 * Math.PI * 7400 * t);
    const side =
      0.08 * Math.sin(2 * Math.PI * 950 * t + 0.4) +
      0.05 * Math.sin(2 * Math.PI * 4200 * t + 1.1);
    L[i] = gain * env * (body + side);
    R[i] = gain * env * (body - side);
  }
  return [L, R];
}

function makeClippedStereo(durationSec = 1.0): Float32Array[] {
  const [L, R] = makeBalancedStereo(durationSec, 1.35);
  return [L, R];
}

function makeMuddyLowMidStereo(durationSec = 1.2): Float32Array[] {
  const n = Math.floor(SR * durationSec);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const mud =
      0.72 * Math.sin(2 * Math.PI * 165 * t) +
      0.65 * Math.sin(2 * Math.PI * 260 * t) +
      0.35 * Math.sin(2 * Math.PI * 95 * t);
    const midHigh =
      0.05 * Math.sin(2 * Math.PI * 1100 * t) +
      0.03 * Math.sin(2 * Math.PI * 3200 * t);
    L[i] = 0.28 * (mud + midHigh);
    R[i] = 0.28 * (mud + midHigh * 0.96);
  }
  return [L, R];
}

function makeHarshResonantStereo(durationSec = 1.2): Float32Array[] {
  const [L, R] = makeBalancedStereo(durationSec, 0.2);
  for (let i = 0; i < L.length; i++) {
    const t = i / SR;
    const harsh = 0.34 * Math.sin(2 * Math.PI * 3500 * t);
    L[i] += harsh;
    R[i] += harsh * 0.94;
  }
  return [L, R];
}

function makeOutOfPhaseBassStereo(durationSec = 1.2): Float32Array[] {
  const n = Math.floor(SR * durationSec);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const subL = 0.55 * Math.sin(2 * Math.PI * 62 * t);
    const subR = 0.55 * Math.sin(2 * Math.PI * 62 * t + 2.25);
    const mids =
      0.24 * Math.sin(2 * Math.PI * 820 * t) +
      0.14 * Math.sin(2 * Math.PI * 2600 * t);
    // Severe low-end phase offset (~129 deg) causing low-end mono cancellation
    L[i] = 0.32 * (subL + mids);
    R[i] = 0.32 * (subR + mids);
  }
  return [L, R];
}

function makeOverCompressedStereo(durationSec = 1.0): Float32Array[] {
  const n = Math.floor(SR * durationSec);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Dense hard-clipped / brickwalled multi-harmonic wave with minimal crest factor
    const raw =
      0.9 * Math.sin(2 * Math.PI * 110 * t) +
      0.6 * Math.sin(2 * Math.PI * 440 * t) +
      0.4 * Math.sin(2 * Math.PI * 1400 * t);
    const brick = Math.tanh(raw * 3.8) * 0.42;
    L[i] = brick;
    R[i] = brick * 0.98;
  }
  return [L, R];
}

test('Verified Processor Inventory exposes all 10 native processors and rejects invalid payloads', () => {
  const keys = Object.keys(VERIFIED_NATIVE_PROCESSOR_INVENTORY);
  assert.equal(keys.length, 10);

  const invalidType = validateChainAgainstInventory([
    { type: 'magic-maximizer', name: 'Fake', params: {} },
  ]);
  assert.equal(invalidType.valid, false);
  assert.ok(invalidType.errors.some((e) => e.includes('Unsupported processor type')));

  const nonFinite = validateChainAgainstInventory([
    {
      type: 'limiter',
      name: 'Limiter',
      intensity: 100,
      wetDry: 100,
      params: { ceilingDb: Number.NaN, thresholdDb: -2, releaseMs: 90, lookaheadMs: 3, truePeak: true, oversampling: 4 },
    },
  ]);
  assert.equal(nonFinite.valid, false);
  assert.ok(nonFinite.errors.some((e) => e.includes('Non-finite numeric value')));

  assert.equal(validateChainAgainstInventory([]).valid, false);
  assert.equal(validateChainAgainstInventory('not-array').valid, false);

  const valid = validateChainAgainstInventory([
    createProcessorModule('parametric-eq'),
    createProcessorModule('limiter'),
  ]);
  assert.equal(valid.valid, true);
  assert.equal(valid.sanitizedChain.length, 2);
});

test('All 13 mastering objectives resolve distinct calibration targets cleanly', () => {
  const ids: MasteringObjectiveId[] = [
    'streaming',
    'commercial-loudness',
    'dynamic',
    'cinematic',
    'electronic',
    'hip-hop',
    'pop',
    'acoustic',
    'vocal-focused',
    'transparent',
    'punchy',
    'warm',
    'custom',
  ];
  const targets = ids.map((id) => resolveObjectiveTarget(id, id === 'custom' ? { targetLufs: -12.5 } : null));
  assert.equal(targets.length, 13);
  for (const t of targets) {
    assert.ok(Number.isFinite(t.targetLufs));
    assert.ok(t.maxTruePeakDb <= -0.1);
  }
  assert.ok(
    resolveObjectiveTarget('commercial-loudness').targetLufs >
      resolveObjectiveTarget('streaming').targetLufs,
  );
  assert.ok(
    resolveObjectiveTarget('dynamic').minDynamicRangeDb >
      resolveObjectiveTarget('commercial-loudness').minDynamicRangeDb,
  );
});

test('Diagnostic intelligence identifies mud, harshness, over-compression, and phase cancellation', () => {
  const mudAnalysis = analyzeAudioBuffer(makeMuddyLowMidStereo(), SR);
  const mudDiag = analyzeTrackIntelligence(mudAnalysis, 'streaming');
  assert.ok(mudDiag.findings.some((f) => f.id === 'diag-mud'));

  const harshAnalysis = analyzeAudioBuffer(makeHarshResonantStereo(), SR);
  const harshPlan = buildExplainableMasterPlan({
    analysis: harshAnalysis,
    objectiveId: 'streaming',
  });
  assert.ok(
    harshPlan.chain.some((m) => m.type === 'dynamic-eq' || m.type === 'parametric-eq'),
    'Harsh mix should receive Dynamic EQ or surgical Parametric EQ remediation',
  );

  const squashedAnalysis = analyzeAudioBuffer(makeOverCompressedStereo(), SR);
  const squashedDiag = analyzeTrackIntelligence(squashedAnalysis, 'streaming');
  assert.ok(
    squashedDiag.findings.some((f) => f.id === 'diag-overcompressed' || f.category === 'Dynamics'),
  );

  const phaseAnalysis = analyzeAudioBuffer(makeOutOfPhaseBassStereo(), SR);
  const phaseDiag = analyzeTrackIntelligence(phaseAnalysis, 'streaming');
  assert.ok(phaseDiag.findings.some((f) => f.id === 'diag-phase'));
});

test('CHAIN WITH AI fixes clipped source track to zero clipped samples and compliant True Peak', async () => {
  const clipped = makeClippedStereo();
  const lifecycles: AiChainLifecycleState[] = [];
  const report = await runAutonomousDirectorLoop({
    sourceChannels: clipped,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    maxIterations: 2,
    onProgress: (u) => {
      if (u.lifecycle) lifecycles.push(u.lifecycle);
    },
  });

  assert.equal(report.postAnalysis.clippedSamples, 0);
  assert.ok(report.postAnalysis.truePeakDb <= report.objective.maxTruePeakDb + 0.08);
  assert.ok(lifecycles.includes('Analyzing'));
  assert.ok(lifecycles.includes('Processing'));
  assert.ok(lifecycles.includes('Validating'));
  assert.ok(lifecycles.includes('Completed'));
  assert.ok(report.resolvedProblems.length > 0);
});

test('CHAIN WITH AI raises quiet track to distinct streaming vs commercial-loudness targets', async () => {
  const quiet = makeBalancedStereo(1.2, 0.06); // ~ -28 to -24 LUFS
  const streamReport = await runAutonomousDirectorLoop({
    sourceChannels: quiet,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    maxIterations: 3,
  });
  const loudReport = await runAutonomousDirectorLoop({
    sourceChannels: quiet,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'commercial-loudness',
    maxIterations: 3,
  });

  assert.ok(
    streamReport.postAnalysis.integratedLufs > streamReport.preAnalysis.integratedLufs + 6,
    'Quiet track loudness must increase substantially under streaming target',
  );
  assert.ok(
    loudReport.postAnalysis.integratedLufs > streamReport.postAnalysis.integratedLufs + 2,
    'Commercial loudness master must be significantly louder than streaming master',
  );
  assert.ok(loudReport.postAnalysis.truePeakDb <= -0.4);
});

test('CHAIN WITH AI repairs out-of-phase sub-bass using Stereo Imager mono-bass anchor', async () => {
  const outOfPhase = makeOutOfPhaseBassStereo();
  const report = await runAutonomousDirectorLoop({
    sourceChannels: outOfPhase,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'electronic',
    maxIterations: 2,
  });

  assert.ok(report.finalChain.some((m) => m.type === 'stereo-imager'));
  assert.ok(
    report.postAnalysis.lowEndCorrelation > report.preAnalysis.lowEndCorrelation + 0.35,
    `Expected low-end correlation improvement (${report.preAnalysis.lowEndCorrelation} -> ${report.postAnalysis.lowEndCorrelation})`,
  );
});

test('Transparent objective exercises surgical restraint on a balanced track', () => {
  const clean = makeBalancedStereo(1.2, 0.22);
  const analysis = analyzeAudioBuffer(clean, SR);
  const plan = buildExplainableMasterPlan({
    analysis,
    objectiveId: 'transparent',
  });
  assert.ok(
    !plan.chain.some((m) => m.type === 'saturation'),
    'Transparent objective must not insert harmonic saturation',
  );
  assert.ok(
    plan.chain.length <= 4,
    `Transparent objective should stay minimal/surgical, got ${plan.chain.length} stages`,
  );
});

test('Rejects out-of-inventory aiRefineCallback output safely and continues deterministic loop', async () => {
  const quiet = makeBalancedStereo(1.0, 0.14);
  const report = await runAutonomousDirectorLoop({
    sourceChannels: quiet,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    maxIterations: 2,
    // Force the refinement path so this test actually exercises AI-chain rejection.
    qcProfile: { ...QC_TARGET_PROFILES[0], minDynamicRangeDb: 100 },
    aiRefineCallback: async () => {
      return [
        {
          id: 'bad',
          type: 'hallucinated-fx' as never,
          name: 'Bad',
          enabled: true,
          bypassed: false,
          expanded: false,
          wetDry: 100,
          intensity: 100,
          inputGainDb: 0,
          outputGainDb: 0,
          params: {} as never,
        },
      ];
    },
  });

  assert.ok(report.finalChain.length >= 1);
  assert.ok(
    report.activityLog.some((a) => a.message.includes('Rejected out-of-inventory AI refinement')),
  );
});

test('Mid-run cancellation stops cleanly without throwing and returns stopped-by-user state', async () => {
  const quiet = makeBalancedStereo(1.0, 0.18);
  let passesSeen = 0;
  const report = await runAutonomousDirectorLoop({
    sourceChannels: quiet,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    maxIterations: 4,
    shouldStop: () => passesSeen >= 1,
    onProgress: (u) => {
      if (u.checkpoint && u.checkpoint.passNumber >= 1) passesSeen = u.checkpoint.passNumber;
    },
  });

  assert.equal(report.status, 'stopped-by-user');
  assert.ok(report.iterationsExecuted <= 2);
});

test('Anti-oscillation step damping reduces LUFS step magnitude when sign reverses', () => {
  const clean = makeBalancedStereo(1.0, 0.18);
  const pre = analyzeAudioBuffer(clean, SR);
  const post = { ...pre, integratedLufs: -11.5 }; // +2.5 LU over -14.0 target -> lufsDiff = -2.5
  const obj = resolveObjectiveTarget('streaming');
  const qc = runQualityControl(pre, post, QC_TARGET_PROFILES[0]);
  const evalMetrics = evaluateMultiObjectiveMetrics(pre, post, obj, qc);
  const chain = [createProcessorModule('maximizer', { params: { character: 'transparent', targetLufs: -12, ceilingDb: -1.0, transientEmphasis: 25, truePeak: true } })];

  const undamped = deriveRefinementCommands(pre, post, chain, obj, qc, evalMetrics, { prevLufsError: -2.0 });
  const damped = deriveRefinementCommands(pre, post, chain, obj, qc, evalMetrics, { prevLufsError: 2.0 });

  const uCmd = undamped.commands.find((c) => c.op === 'configure' && c.processorType === 'maximizer');
  const dCmd = damped.commands.find((c) => c.op === 'configure' && c.processorType === 'maximizer');
  assert.ok(uCmd && uCmd.op === 'configure' && dCmd && dCmd.op === 'configure');

  const uTarget = Number((uCmd.paramsPatch as { targetLufs: number }).targetLufs);
  const dTarget = Number((dCmd.paramsPatch as { targetLufs: number }).targetLufs);
  assert.ok(
    Math.abs(-12 - dTarget) < Math.abs(-12 - uTarget),
    `Expected damped step magnitude (${Math.abs(-12 - dTarget)}) < undamped (${Math.abs(-12 - uTarget)})`,
  );

  // Command rejection test on non-finite parameter
  const badRes = applyStructuredChainCommands(chain, [
    { op: 'gain-stage', processorType: 'maximizer', outputGainDb: Number.POSITIVE_INFINITY, rationale: 'bad' },
  ]);
  assert.equal(badRes.appliedCount, 0);
  assert.equal(badRes.skippedReasons.length, 1);
});

test('Director consumes stem intelligence, exposes evidence, and keeps stem corrections advisory', async () => {
  const sampleRate = SR;
  const makeTone = (hz: number, seconds = 1) => {
    const data = new Float32Array(Math.floor(sampleRate * seconds));
    for (let i = 0; i < data.length; i++) data[i] = 0.18 * Math.sin((2 * Math.PI * hz * i) / sampleRate);
    return data;
  };
  const stemAnalysis = analyzeStemSet([
    { id: 'bass-stem', name: 'Bass', role: 'bass', sampleRate, channels: [makeTone(110)] },
    { id: 'synth-stem', name: 'Synth', role: 'instruments', sampleRate, channels: [makeTone(115)] },
  ], sampleRate);

  const source = makeBalancedStereo(1, 0.16);
  const report = await runAutonomousDirectorLoop({
    sourceChannels: source,
    sampleRate,
    operatingMode: 'manual',
    objectiveId: 'streaming',
    stemAnalysis,
  });

  assert.equal(report.stemIntelligence?.stemCount, 2);
  assert.equal(report.stemIntelligence?.overlaps.length, stemAnalysis.overlaps.length);
  assert.ok(report.diagnosis.findings.some((finding) => finding.id.startsWith('diag-stem-overlap-')));
  const stemRecommendations = report.recommendations.filter((recommendation) => recommendation.id.startsWith('rec-diag-stem-overlap-'));
  assert.ok(stemRecommendations.length > 0);
  assert.ok(stemRecommendations.every((recommendation) => recommendation.commands.length === 0));
  assert.ok(stemRecommendations.every((recommendation) => /stem-routed processing/i.test(recommendation.proposedParamsSummary)));
  assert.equal(report.finalChain.some((module) => module.name.includes('Stem Interaction')), false);
});

test('Director without stem input preserves the existing report contract', async () => {
  const report = await runAutonomousDirectorLoop({
    sourceChannels: makeBalancedStereo(0.5, 0.16),
    sampleRate: SR,
    operatingMode: 'manual',
    objectiveId: 'streaming',
  });
  assert.equal(report.stemIntelligence, undefined);
  assert.equal(report.diagnosis.findings.some((finding) => finding.id.startsWith('diag-stem-overlap-')), false);
});

test('Director renders isolated stem chains before applying its master-bus refinement pass', async () => {
  const makeTone = (hz: number, seconds = 0.6, amplitude = 0.18) => {
    const data = new Float32Array(Math.floor(SR * seconds));
    for (let i = 0; i < data.length; i++) data[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SR);
    return data;
  };
  const stemBuses = [
    { id: 'bass-bus', name: 'Bass Bus', role: 'bass' as const, channels: [makeTone(110)], sampleRate: SR },
    { id: 'vocal-bus', name: 'Vocal Bus', role: 'vocals' as const, channels: [makeTone(6000)], sampleRate: SR },
  ];
  const eq = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 0,
      bands: [{ id: 'vocal-lowpass', enabled: true, shape: 'lowpass', freq: 1200, gain: 0, q: 0.71 }],
    },
  });
  const dryRender = await (await import('../dsp/stemBusRenderer')).renderStemBusMix(stemBuses, SR);
  const dryAnalysis = dryRender.mixAnalysis;
  let passInputAnalysis: ReturnType<typeof analyzeAudioBuffer> | null = null;

  const report = await runAutonomousDirectorLoop({
    sourceChannels: makeBalancedStereo(0.6, 0.1),
    sampleRate: SR,
    operatingMode: 'assisted',
    objectiveId: 'streaming',
    stemBuses,
    stemChainsById: { 'vocal-bus': [eq] },
    renderPassFn: async (channels, sampleRate) => {
      const analysis = analyzeAudioBuffer(channels, sampleRate);
      passInputAnalysis = analysis;
      return { channels, analysis };
    },
  });

  assert.ok(passInputAnalysis);
  assert.ok(passInputAnalysis!.rmsDb < dryAnalysis.rmsDb - 2, 'stem EQ should change the Director pass input before the master chain');
  assert.equal(report.stemIntelligence?.stemCount, 2);
  assert.deepEqual(report.stemIntelligence?.processingChains['vocal-bus'], ['parametric-eq']);
  assert.equal(report.stemIntelligence?.stems.find((stem) => stem.id === 'vocal-bus')?.processed, true);
  assert.ok(report.postFixVerification?.appliedCorrections.some((correction) => correction.processorTypes.includes('parametric-eq')));
});

test('Manual Director mode reports stem chains without executing them', async () => {
  const tone = new Float32Array(SR);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.2 * Math.sin((2 * Math.PI * 6000 * i) / SR);
  const stemBuses = [{ id: 'vocal-bus', name: 'Vocal', role: 'vocals' as const, channels: [tone], sampleRate: SR }];
  const eq = createProcessorModule('parametric-eq');
  const report = await runAutonomousDirectorLoop({
    sourceChannels: makeBalancedStereo(1, 0.12),
    sampleRate: SR,
    operatingMode: 'manual',
    objectiveId: 'streaming',
    stemBuses,
    stemChainsById: { 'vocal-bus': [eq] },
  });
  assert.equal(report.stemIntelligence?.stems[0].processed, false);
  assert.deepEqual(report.stemIntelligence?.processingChains['vocal-bus'], ['parametric-eq']);
});

