import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer } from '../dsp/analyzer';
import { analyzeStemSet } from '../dsp/stemAnalysis';
import { processChainOffline } from '../dsp/offlineDsp';
import { createProcessorModule } from '../dsp/chainValidation';
import { runQualityControl, QC_TARGET_PROFILES } from '../dsp/qc';
import type { AiChainLifecycleState, MasteringObjectiveId } from '../types/mastering';
import { analyzeTrackIntelligence, isAnalysisMeasurementReliable } from './analyzeIntelligence';
import { applyStructuredChainCommands } from './chainCommands';
import {
  buildExplainableMasterPlan,
  compareReferenceIntelligent,
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

test('CHAIN WITH AI restores output headroom but does not claim clipped source waveform reconstruction', async () => {
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

  const clippingState = report.postFixVerification?.activeFindings.find(
    (finding) => finding.findingId === 'diag-clipping',
  );
  assert.ok(clippingState, 'Original source clipping must remain visible after output attenuation');
  assert.equal(clippingState.status, 'UNRESOLVED');
  assert.equal(
    report.postFixVerification?.resolvedFindings.some((finding) => finding.findingId === 'diag-clipping'),
    false,
    'Zero clipped samples after attenuation does not prove the flattened source peaks were reconstructed',
  );
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

test('Bass-vs-mid residual drives a targeted, proportionate low-shelf refinement', () => {
  const source = makeBalancedStereo(1.0, 0.18);
  const base = analyzeAudioBuffer(source, SR);
  const pre = { ...base, zoneEnergyDb: { ...base.zoneEnergyDb, bass: base.zoneEnergyDb.mid + 12.3 } };
  const post = { ...base, zoneEnergyDb: { ...base.zoneEnergyDb, bass: base.zoneEnergyDb.mid + 11.7 } };
  const objective = resolveObjectiveTarget('streaming');
  const qc = runQualityControl(pre, post, QC_TARGET_PROFILES[0]);
  const evaluation = evaluateMultiObjectiveMetrics(pre, post, objective, qc);
  const eq = createProcessorModule('parametric-eq');

  const refinement = deriveRefinementCommands(pre, post, [eq], objective, qc, evaluation);
  const eqCommand = refinement.commands.find((command) => command.op === 'configure' && command.processorType === 'parametric-eq');
  assert.ok(eqCommand && eqCommand.op === 'configure', 'Bass excess must produce an EQ refinement command');
  const bands = (eqCommand.paramsPatch as { bands?: Array<{ shape: string; freq: number; gain: number }> }).bands;
  assert.ok(bands?.some((band) => band.shape === 'lowshelf' && band.freq >= 70 && band.freq <= 140 && band.gain < 0),
    'Bass-vs-mid excess must target the bass band with a negative low shelf, not a 220-340 Hz mud bell');
  const bassCut = bands!.find((band) => band.shape === 'lowshelf')!;
  assert.ok(bassCut.gain >= -0.5 && bassCut.gain <= -0.25,
    `A 0.2 dB miss must trigger a restrained correction, got ${bassCut.gain} dB`);
  const applied = applyStructuredChainCommands([eq], [eqCommand]);
  assert.equal(applied.appliedCount, 1, applied.skippedReasons.join('; '));
  const appliedEq = applied.chain.find((module) => module.type === 'parametric-eq');
  assert.ok(appliedEq);
  assert.ok((appliedEq.params as { bands: Array<{ shape: string; gain: number }> }).bands.some((band) => band.shape === 'lowshelf' && band.gain === bassCut.gain));

  const withoutEq = deriveRefinementCommands(pre, post, [], objective, qc, evaluation);
  assert.ok(withoutEq.commands.some((command) => command.op === 'add' && command.processorType === 'parametric-eq'),
    'The Director must add a bass-targeted EQ when no parametric EQ exists');
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
  const passInputChannels: Float32Array[][] = [];

  const report = await runAutonomousDirectorLoop({
    sourceChannels: makeBalancedStereo(0.6, 0.1),
    sampleRate: SR,
    operatingMode: 'assisted',
    objectiveId: 'streaming',
    stemBuses,
    stemChainsById: { 'vocal-bus': [eq] },
    renderPassFn: async (channels, sampleRate) => {
      const analysis = analyzeAudioBuffer(channels, sampleRate);
      passInputChannels.push(channels);
      return { channels, analysis };
    },
  });

  assert.equal(passInputChannels.length, 1);
  const passInputAnalysis = analyzeAudioBuffer(passInputChannels[0], SR);
  assert.ok(passInputAnalysis.rmsDb < dryAnalysis.rmsDb - 2, 'stem EQ should change the Director pass input before the master chain');
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



test('Stereo Imager corrects either direction of measured left/right channel imbalance', () => {
  for (const louderChannel of ['left', 'right'] as const) {
    const source = makeBalancedStereo(1.2, 0.18);
    const gain = Math.pow(10, 3 / 20);
    const target = louderChannel === 'left' ? source[0] : source[1];
    for (let i = 0; i < target.length; i++) target[i] *= gain;

    const baseline = analyzeAudioBuffer(source, SR);
    assert.ok(
      Math.abs(baseline.lrBalanceDb) > 2.8,
      'Fixture must contain a clear channel energy imbalance',
    );
    assert.equal(baseline.lrBalanceDb > 0, louderChannel === 'right');

    const plan = buildExplainableMasterPlan({
      analysis: baseline,
      objectiveId: 'streaming',
    });
    const imager = plan.chain.find((module) => module.type === 'stereo-imager');
    assert.ok(imager, 'Measured channel imbalance must insert the Stereo Imager');
    const lrTrim = (imager!.params as { lrBalanceDb: number }).lrBalanceDb;
    assert.equal(
      lrTrim < 0,
      louderChannel === 'right',
      'A louder right channel must be attenuated with a negative imager balance value, and vice versa',
    );

    const rendered = processChainOffline(source, SR, plan.chain);
    const post = analyzeAudioBuffer(rendered.channels, SR);
    assert.ok(
      Math.abs(post.lrBalanceDb) < Math.abs(baseline.lrBalanceDb) * 0.4,
      'Rendered correction must materially reduce measured L/R energy skew: ' +
        baseline.lrBalanceDb.toFixed(2) + ' -> ' + post.lrBalanceDb.toFixed(2) + ' dB',
    );
  }
});

test('Reference EQ matching removes overall loudness bias and responds only to relative tonal differences', () => {
  const source = makeBalancedStereo(1.2, 0.18);
  // Add repeatable high-air content so both the bass and air bands remain measurable.
  for (let i = 0; i < source[0].length; i++) {
    const air = 0.025 * Math.sin((2 * Math.PI * 14000 * i) / SR);
    source[0][i] += air;
    source[1][i] += air;
  }

  const sourceAnalysis = analyzeAudioBuffer(source, SR);
  const louderReference = analyzeAudioBuffer(
    source.map((channel) => Float32Array.from(channel, (sample) => sample * 2)),
    SR,
  );

  assert.ok(louderReference.integratedLufs - sourceAnalysis.integratedLufs > 5.5);
  assert.ok(louderReference.zoneEnergyDb.bass - sourceAnalysis.zoneEnergyDb.bass > 5.5);
  assert.ok(louderReference.zoneEnergyDb.air - sourceAnalysis.zoneEnergyDb.air > 5.5);

  const levelOnlyPlan = buildExplainableMasterPlan({
    analysis: sourceAnalysis,
    objectiveId: 'streaming',
    referenceAnalysis: louderReference,
  });
  const levelOnlyEq = levelOnlyPlan.chain.find((module) => module.type === 'parametric-eq');
  const levelOnlyBands = ((levelOnlyEq?.params as { bands?: Array<{ id: string; gain: number }> } | undefined)?.bands) ?? [];
  assert.equal(
    levelOnlyBands.some((band) => band.id === 'b2' || band.id === 'b4'),
    false,
    'A level-only reference difference must not create bass or air EQ boosts/cuts',
  );

  const shapedReference = {
    ...louderReference,
    zoneEnergyDb: {
      ...louderReference.zoneEnergyDb,
      bass: louderReference.zoneEnergyDb.bass + 2.0,
      air: louderReference.zoneEnergyDb.air - 1.5,
    },
  };
  const shapedPlan = buildExplainableMasterPlan({
    analysis: sourceAnalysis,
    objectiveId: 'streaming',
    referenceAnalysis: shapedReference,
  });
  const shapedEq = shapedPlan.chain.find((module) => module.type === 'parametric-eq');
  const shapedBands = ((shapedEq?.params as { bands?: Array<{ id: string; gain: number }> } | undefined)?.bands) ?? [];
  const bassMatch = shapedBands.find((band) => band.id === 'b2');
  const airMatch = shapedBands.find((band) => band.id === 'b4');

  assert.ok(bassMatch, 'A genuine +2 dB relative bass difference should produce a restrained lowshelf adjustment');
  assert.ok(airMatch, 'A genuine -1.5 dB relative air difference should produce a restrained highshelf adjustment');
  assert.ok(Math.abs(bassMatch.gain - 0.9) <= 0.11, 'Expected +0.9 dB relative bass trim, got ' + bassMatch.gain + ' dB');
  assert.ok(Math.abs(airMatch.gain + 0.6) <= 0.11, 'Expected -0.6 dB relative air trim, got ' + airMatch.gain + ' dB');
});

test('Reference comparison preserves raw band deltas but bases EQ guidance on level-matched tonal balance', () => {
  const source = makeBalancedStereo(1.2, 0.18);
  for (let i = 0; i < source[0].length; i++) {
    const air = 0.025 * Math.sin((2 * Math.PI * 14000 * i) / SR);
    source[0][i] += air;
    source[1][i] += air;
  }
  const sourceAnalysis = analyzeAudioBuffer(source, SR);
  const louderReference = analyzeAudioBuffer(
    source.map((channel) => Float32Array.from(channel, (sample) => sample * 2)),
    SR,
  );

  const levelOnlyComparison = compareReferenceIntelligent(
    sourceAnalysis,
    sourceAnalysis,
    louderReference,
  );
  assert.ok(
    levelOnlyComparison.zoneDeltasDb.bass > 5.5,
    'Raw band-level telemetry should remain available to explain the loudness difference',
  );
  assert.equal(
    levelOnlyComparison.suggestedActions.some((action) => /low-shelf|high-shelf/i.test(action)),
    false,
    'A level-only reference difference must not generate tonal EQ recommendations',
  );

  const shapedReference = {
    ...louderReference,
    zoneEnergyDb: {
      ...louderReference.zoneEnergyDb,
      bass: louderReference.zoneEnergyDb.bass + 2.5,
      air: louderReference.zoneEnergyDb.air - 3.0,
    },
  };
  const shapedComparison = compareReferenceIntelligent(
    sourceAnalysis,
    sourceAnalysis,
    shapedReference,
  );
  assert.ok(
    shapedComparison.suggestedActions.some((action) => /warmer bass weight/.test(action) && /\+2\.5 dB/.test(action)),
    'Genuine relative bass difference should produce a restrained bass recommendation',
  );
  assert.ok(
    shapedComparison.suggestedActions.some((action) => /darker in the top octave relative to the midrange by 3\.0 dB/.test(action)),
    'Genuine relative air difference should remain visible in reference guidance',
  );
});

test('Reference alignment score is invariant to uniform reference gain while loudness compliance remains objective-based', () => {
  const source = makeBalancedStereo(1.2, 0.18);
  const sourceAnalysis = analyzeAudioBuffer(source, SR);
  const louderReference = analyzeAudioBuffer(
    source.map((channel) => Float32Array.from(channel, (sample) => sample * 2)),
    SR,
  );
  assert.ok(
    Math.abs(louderReference.integratedLufs - sourceAnalysis.integratedLufs) > 5.5,
    'Reference fixture must have a substantial loudness offset',
  );

  const objective = resolveObjectiveTarget('streaming');
  const qc = runQualityControl(sourceAnalysis, sourceAnalysis, QC_TARGET_PROFILES[0]);
  const sourceEvaluation = evaluateMultiObjectiveMetrics(
    sourceAnalysis,
    sourceAnalysis,
    objective,
    qc,
    sourceAnalysis,
  );
  const louderReferenceEvaluation = evaluateMultiObjectiveMetrics(
    sourceAnalysis,
    sourceAnalysis,
    objective,
    qc,
    louderReference,
  );
  const sourceReferenceScore = sourceEvaluation.dimensions.find((dimension) => dimension.key === 'referenceSimilarity');
  const louderReferenceScore = louderReferenceEvaluation.dimensions.find((dimension) => dimension.key === 'referenceSimilarity');
  const sourceLoudnessScore = sourceEvaluation.dimensions.find((dimension) => dimension.key === 'loudness');
  const louderReferenceLoudnessScore = louderReferenceEvaluation.dimensions.find((dimension) => dimension.key === 'loudness');

  assert.ok(sourceReferenceScore && louderReferenceScore);
  assert.equal(
    louderReferenceScore.score,
    sourceReferenceScore.score,
    'Uniform gain applied to the reference must not reduce tonal/stereo reference alignment',
  );
  assert.ok(sourceReferenceScore.measuredSummary.includes('LUFS'));
  assert.ok(louderReferenceScore.measuredSummary.includes('LUFS'));
  assert.equal(
    louderReferenceLoudnessScore?.score,
    sourceLoudnessScore?.score,
    'Reference loudness must not change the objective loudness compliance score',
  );
});


test('Explainable plan does not insert dynamic EQ for a coherent harmonic instrument series', () => {
  const n = Math.floor(SR * 2);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let seed = 19;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let pitched = 0;
    for (let harmonic = 1; harmonic <= 9; harmonic++) {
      pitched += (0.20 / Math.pow(harmonic, 1.1)) *
        Math.sin(2 * Math.PI * 196 * harmonic * t);
    }
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = ((seed / 4294967296) * 2 - 1) * 0.004;
    left[i] = pitched + noise;
    right[i] = pitched * 0.98 + noise;
  }

  const analysis = analyzeAudioBuffer([left, right], SR);
  const plan = buildExplainableMasterPlan({ analysis, objectiveId: 'streaming' });
  assert.equal(
    plan.chain.some((module) => module.type === 'dynamic-eq'),
    false,
    'Harmonic instrument partials alone must not trigger dynamic resonance cuts',
  );
});


test('Director narrows only the frequency band with localized anti-phase correlation', () => {
  const channels = makeBalancedStereo();
  const measured = analyzeAudioBuffer(channels, SR);
  const post = {
    ...measured,
    phaseCorrelation: 0.72,
    lowEndCorrelation: 0.91,
    stereoBandCorrelation: { low: 0.91, mid: 0.88, high: -0.82 },
  };
  const imager = createProcessorModule('stereo-imager');
  const chain = [imager];
  const objective = resolveObjectiveTarget('streaming');
  const qc = runQualityControl(measured, post, QC_TARGET_PROFILES[0]);
  const evaluation = evaluateMultiObjectiveMetrics(measured, post, objective, qc);
  const stereoDimension = evaluation.dimensions.find((dimension) => dimension.key === 'stereoIntegrity');
  assert.ok(
    stereoDimension && stereoDimension.score < 85,
    'Localized high-band phase cancellation must reduce the stereo-integrity objective score',
  );
  const result = deriveRefinementCommands(
    measured,
    post,
    chain,
    objective,
    qc,
    evaluation,
  );
  const correction = result.commands.find((command) =>
    command.processorType === 'stereo-imager' && command.op === 'configure',
  );
  assert.ok(correction && correction.op === 'configure');
  const current = imager.params as { lowWidth: number; midWidth: number; highWidth: number; monoBassBelowHz: number };
  const patch = correction.paramsPatch as Partial<typeof current>;
  assert.ok(
    typeof patch.highWidth === 'number' && patch.highWidth < current.highWidth,
    'Negative high-band correlation must reduce high-band width',
  );
  assert.equal(patch.lowWidth, current.lowWidth, 'Healthy low band must not be narrowed');
  assert.equal(patch.midWidth, current.midWidth, 'Healthy mid band must not be narrowed');
  assert.equal(patch.monoBassBelowHz, current.monoBassBelowHz, 'High-band cancellation must not move the mono-bass crossover');
});


test('Loudness refinement does not drive an already compressed premaster harder', () => {
  const base = analyzeAudioBuffer(makeBalancedStereo(1.2, 0.18), SR);
  const pre = { ...base, dynamicRangeDb: 4.0 };
  const post = { ...pre, integratedLufs: -18.0 };
  const objective = resolveObjectiveTarget('streaming');
  const qc = runQualityControl(pre, post, QC_TARGET_PROFILES[0]);
  const evaluation = evaluateMultiObjectiveMetrics(pre, post, objective, qc);
  const maximizer = createProcessorModule('maximizer', {
    params: { character: 'transparent', targetLufs: -14, ceilingDb: -1, transientEmphasis: 25, truePeak: true },
  });
  const result = deriveRefinementCommands(pre, post, [maximizer], objective, qc, evaluation);
  assert.equal(
    result.commands.some((command) =>
      command.processorType === 'maximizer' && command.op === 'configure' &&
      Object.prototype.hasOwnProperty.call(command.paramsPatch, 'targetLufs') &&
      Number((command.paramsPatch as { targetLufs: number }).targetLufs) > -14,
    ),
    false,
    'A low-DR premaster must not receive more maximizer drive merely to chase the LUFS target',
  );
  assert.equal(
    result.commands.some((command) =>
      command.processorType === 'maximizer' && command.op === 'configure' &&
      Object.prototype.hasOwnProperty.call(command.paramsPatch, 'transientEmphasis'),
    ),
    false,
    'Transient emphasis is not source-dynamics reconstruction',
  );
});

test('Loudness refinement backs off processing-induced dynamic-range collapse', () => {
  const base = analyzeAudioBuffer(makeBalancedStereo(1.2, 0.18), SR);
  const pre = { ...base, dynamicRangeDb: 12.0 };
  const post = { ...base, dynamicRangeDb: 6.0, integratedLufs: -14.0 };
  const objective = resolveObjectiveTarget('streaming');
  const qc = runQualityControl(pre, post, QC_TARGET_PROFILES[0]);
  const evaluation = evaluateMultiObjectiveMetrics(pre, post, objective, qc);
  const maximizer = createProcessorModule('maximizer', {
    params: { character: 'transparent', targetLufs: -14, ceilingDb: -1, transientEmphasis: 25, truePeak: true },
  });
  const compressor = createProcessorModule('compressor', {
    params: { mode: 'downward', thresholdDb: -22, ratio: 4, attackMs: 8, releaseMs: 90, kneeDb: 3, makeupDb: 0, scHpfHz: 40 },
  });
  const result = deriveRefinementCommands(pre, post, [maximizer, compressor], objective, qc, evaluation);
  const maxCommand = result.commands.find((command) =>
    command.processorType === 'maximizer' && command.op === 'configure',
  );
  const compCommand = result.commands.find((command) =>
    command.processorType === 'compressor' && command.op === 'configure',
  );
  assert.ok(maxCommand && maxCommand.op === 'configure');
  assert.ok(compCommand && compCommand.op === 'configure');
  assert.ok(
    Number((maxCommand.paramsPatch as { targetLufs: number }).targetLufs) < -14,
    'Maximizer target should be eased quieter to restore headroom and transient contrast',
  );
  assert.ok(
    Number((compCommand.paramsPatch as { ratio: number }).ratio) < 4,
    'Bus compression ratio should be relaxed rather than increasing transient emphasis',
  );
});


test('Autonomous loop rejects a first-pass chain that introduces new harmonic distortion', async () => {
  const n = Math.floor(SR * 2);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const sample = 0.24 * Math.sin((2 * Math.PI * 440 * i) / SR);
    left[i] = sample;
    right[i] = sample;
  }
  const source = [left, right];
  const baseline = analyzeAudioBuffer(source, SR);
  assert.ok(baseline.thdEstimatePercent < 2.2, 'Fixture must begin with a clean harmonic baseline');
  const damaged = { ...baseline, integratedLufs: -14, thdEstimatePercent: 8.0 };

  const report = await runAutonomousDirectorLoop({
    sourceChannels: source,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    maxIterations: 1,
    renderPassFn: async () => ({ channels: source, analysis: damaged }),
  });

  assert.equal(
    report.finalChain.length,
    0,
    'A first pass that introduces a new technical distortion finding must not replace the clean baseline checkpoint',
  );
  assert.equal(report.postAnalysis.thdEstimatePercent, baseline.thdEstimatePercent);
  assert.equal(
    report.checkpoints.find((checkpoint) => checkpoint.passNumber === 1)?.iterationSummary.outcome,
    'regressed',
  );
});


test('Noise objective score is invariant to uniform attenuation and rewards level-matched noise reduction', () => {
  const measured = analyzeAudioBuffer(makeBalancedStereo(), SR);
  const pre = {
    ...measured,
    integratedLufs: -12,
    rmsDb: -12,
    noiseFloorDb: -40,
  };
  const uniformlyAttenuated = {
    ...pre,
    integratedLufs: -16,
    rmsDb: -16,
    noiseFloorDb: -44,
  };
  const noiseReduced = {
    ...uniformlyAttenuated,
    noiseFloorDb: -46,
  };
  const objective = resolveObjectiveTarget('streaming');
  const scoreFor = (post: typeof pre) => {
    const qc = runQualityControl(pre, post, QC_TARGET_PROFILES[0]);
    const evaluation = evaluateMultiObjectiveMetrics(pre, post, objective, qc);
    return evaluation.dimensions.find((dimension) => dimension.key === 'noise')?.score;
  };
  assert.equal(
    scoreFor(uniformlyAttenuated),
    scoreFor(pre),
    'Uniform gain reduction must not improve the noise score',
  );
  assert.ok(
    Number(scoreFor(noiseReduced)) > Number(scoreFor(uniformlyAttenuated)),
    'Noise reduction that improves level-matched noise floor must improve the noise score',
  );
});


test('Analysis reliability rejects malformed optional frequency-band phase telemetry', () => {
  const analysis = analyzeAudioBuffer(makeBalancedStereo(), SR);
  assert.equal(isAnalysisMeasurementReliable(analysis), true);
  assert.equal(
    isAnalysisMeasurementReliable({ ...analysis, stereoBandCorrelation: null } as unknown as typeof analysis),
    false,
    'Explicit null must not bypass optional stereo-band telemetry validation',
  );
  assert.equal(
    isAnalysisMeasurementReliable({
      ...analysis,
      stereoBandCorrelation: { low: 0.2, mid: 1.2, high: -0.1 },
    }),
    false,
    'Out-of-range band correlation must be rejected',
  );
});


test('Explainable plan still targets a genuinely isolated upper-mid resonance', () => {
  const n = Math.floor(SR * 2);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let seed = 71;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const broadband = ((seed / 4294967296) * 2 - 1) * 0.018;
    const resonance = 0.24 * Math.sin(2 * Math.PI * 3100 * t);
    left[i] = broadband + resonance;
    right[i] = broadband * 0.98 + resonance;
  }
  const analysis = analyzeAudioBuffer([left, right], SR);
  assert.ok(
    analysis.resonances.some((resonance) => resonance.freqHz >= 2000 && resonance.excessDb >= 6),
    'Fixture must produce an isolated high-mid spectral prominence',
  );
  const plan = buildExplainableMasterPlan({ analysis, objectiveId: 'streaming' });
  assert.ok(
    plan.chain.some((module) => module.type === 'dynamic-eq'),
    'A measured isolated resonance should still trigger a targeted dynamic EQ recommendation',
  );
});
