import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer, dbToLinear } from '../dsp/analyzer';
import { createProcessorModule } from '../dsp/chainValidation';
import { processChainOffline } from '../dsp/offlineDsp';
import { QC_TARGET_PROFILES, runQualityControl } from '../dsp/qc';
import type { ExportConfig, ExternalPluginRecord, StereoImagerParams } from '../types/mastering';
import { analyzeTrackIntelligence } from './analyzeIntelligence';
import { applyStructuredChainCommands } from './chainCommands';
import {
  buildBattleCandidatesIntelligent,
  buildExplainableMasterPlan,
  compareReferenceIntelligent,
  deriveRefinementCommands,
  evaluateMultiObjectiveMetrics,
  runAutonomousDirectorLoop,
} from './directorEngine';
import { inspectPluginInventory } from './pluginIntelligence';

const SR = 48000;

function makeQuietDynamicMix(durationSec = 1.8): [Float32Array, Float32Array] {
  const n = Math.floor(SR * durationSec);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Percussive envelope every 0.3s -> ~ -22 LUFS with high crest
    const env = (i % Math.floor(SR * 0.3)) < 960 ? 1.0 : 0.18;
    const mid =
      0.11 * Math.sin(2 * Math.PI * 75 * t) * env +
      0.08 * Math.sin(2 * Math.PI * 520 * t) * env +
      0.04 * Math.sin(2 * Math.PI * 3200 * t) * env;
    const side = 0.03 * Math.sin(2 * Math.PI * 1400 * t) * env;
    l[i] = mid + side;
    r[i] = mid - side;
  }
  return [l, r];
}

function makeWarmDarkArtisticMix(durationSec = 1.6): [Float32Array, Float32Array] {
  const n = Math.floor(SR * durationSec);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const cyclePhase = (i % Math.floor(SR * 0.4)) / (SR * 0.4);
    // Include real low-level quiet passages so the 5th-percentile estimator measures noise, not sustained music.
    const env = cyclePhase < 0.72 ? 0.7 + 0.3 * Math.sin(2 * Math.PI * 2.5 * t) : 0.00035;
    // Warm downward spectral tilt without mud spike or phase issues
    const mid =
      0.18 * Math.sin(2 * Math.PI * 95 * t) * env +
      0.11 * Math.sin(2 * Math.PI * 750 * t) * env +
      0.025 * Math.sin(2 * Math.PI * 6500 * t) * env;
    const side = 0.06 * Math.sin(2 * Math.PI * 1200 * t) * env;
    l[i] = mid + side;
    r[i] = mid - side;
  }
  return [l, r];
}

function makeProblematicMix(durationSec = 1.6): [Float32Array, Float32Array] {
  const n = Math.floor(SR * durationSec);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  // Deterministic PRNG noise floor
  let seed = 1337;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647) * 2 - 1;
  };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Out-of-phase sub bass + DC offset + L/R skew + broadband noise floor (~ -38 dBFS)
    const sub = 0.16 * Math.sin(2 * Math.PI * 58 * t);
    const body = 0.12 * Math.sin(2 * Math.PI * 620 * t);
    const noise = 0.018 * rand();
    l[i] = sub + body + 0.025 + noise;
    r[i] = (-sub + body * 0.65) + 0.025 + noise;
  }
  return [l, r];
}

const DEFAULT_EXPORT: ExportConfig = {
  filename: 'test_out',
  format: 'wav',
  wavBitDepth: 24,
  sampleRate: 48000,
  channels: 'stereo',
  dither: 'tpdf',
  normalizeToTarget: false,
  targetLufs: -14,
  ceilingDb: -1.0,
  deliveryProfile: 'streaming',
  metadataTitle: 'Test',
  metadataArtist: 'SYN MASTER',
};

test('SYN-ANALYZE: noiseFloorDb measurement & artistic choice vs technical problem distinction', () => {
  const [darkL, darkR] = makeWarmDarkArtisticMix();
  const darkAnalysis = analyzeAudioBuffer([darkL, darkR], SR);
  const darkDiag = analyzeTrackIntelligence(darkAnalysis, 'warm');

  assert.ok(darkAnalysis.noiseFloorDb < -50, `Expected low noise floor, got ${darkAnalysis.noiseFloorDb}`);
  assert.ok(
    darkDiag.findings.some((f) => f.kind === 'artistic-choice' && f.id === 'diag-dark-artistic'),
    'Warm dark tilt without mud should be classified as artistic-choice',
  );
  assert.equal(
    darkDiag.findings.filter((f) => f.kind === 'technical-problem').length,
    0,
    'Clean warm mix should not trigger false technical-problem alarms',
  );

  const [probL, probR] = makeProblematicMix();
  const probAnalysis = analyzeAudioBuffer([probL, probR], SR);
  const probDiag = analyzeTrackIntelligence(probAnalysis, 'streaming');

  assert.ok(probAnalysis.noiseFloorDb > -48, `Expected elevated noise floor, got ${probAnalysis.noiseFloorDb}`);
  const problemIds = new Set(
    probDiag.findings.filter((f) => f.kind === 'technical-problem').map((f) => f.id),
  );
  assert.ok(problemIds.has('diag-dc'), 'Should flag DC offset technical problem');
  assert.ok(problemIds.has('diag-phase'), 'Should flag out-of-phase sub technical problem');
  assert.ok(problemIds.has('diag-lr-skew'), 'Should flag L/R skew technical problem');
  assert.ok(problemIds.has('diag-noise'), 'Should flag elevated noise floor technical problem');
});

test('SYN-MASTER Planner: distinct Mastering Objectives produce genuinely distinct chains', () => {
  const [l, r] = makeQuietDynamicMix();
  const analysis = analyzeAudioBuffer([l, r], SR);

  const pTrans = buildExplainableMasterPlan({ analysis, objectiveId: 'transparent' });
  const pPunchy = buildExplainableMasterPlan({ analysis, objectiveId: 'punchy' });
  const clean = new Float32Array(Math.floor(SR * 1.8));
  for (let i = 0; i < clean.length; i++) clean[i] = 0.18 * Math.sin((2 * Math.PI * 440 * i) / SR);
  const cleanAnalysis = analyzeAudioBuffer([clean, new Float32Array(clean)], SR);
  assert.ok(cleanAnalysis.thdEstimatePercent < 1.8, `Warm saturation fixture must be clean, THD=${cleanAnalysis.thdEstimatePercent}%`);
  const pWarm = buildExplainableMasterPlan({ analysis: cleanAnalysis, objectiveId: 'warm' });
  const pCustom = buildExplainableMasterPlan({
    analysis,
    objectiveId: 'custom',
    customSpec: {
      targetLufs: -16.5,
      maxTruePeakDb: -1.5,
      minDynamicRangeDb: 10,
      tonalBias: 'bright',
      stereoPreference: 'wide',
      preserveTransients: true,
    },
  });

  assert.equal(pTrans.chain.some((m) => m.type === 'saturation'), false, 'Transparent omits saturation');
  assert.equal(pWarm.chain.some((m) => m.type === 'saturation'), true, 'Warm includes tube saturation');
  assert.notEqual(pTrans.objective.targetLufs, pPunchy.objective.targetLufs);
  assert.equal(pCustom.objective.targetLufs, -16.5);
  assert.equal(pCustom.objective.maxTruePeakDb, -1.5);
  assert.ok(pWarm.recommendations.every((r) => r.expectedResult && r.potentialTradeoffs && r.supportingMeasurements.length > 0));
});

test('SYN-CHAIN Intelligence: structured commands execute & validate bounds safely', () => {
  const res = applyStructuredChainCommands([], [
    { op: 'add', processorType: 'parametric-eq', rationale: 'Initial EQ' },
    { op: 'add', processorType: 'maximizer', rationale: 'Initial Maximizer' },
    { op: 'configure', processorType: 'maximizer', paramsPatch: { targetLufs: -13.5, ceilingDb: -1.2 }, rationale: 'Set target' },
    { op: 'wet-dry', processorType: 'parametric-eq', wetDry: 75, rationale: 'Blend EQ' },
    { op: 'gain-stage', processorType: 'parametric-eq', inputGainDb: -1.5, outputGainDb: 0.5, rationale: 'Gain stage' },
    { op: 'bypass', processorType: 'parametric-eq', bypassed: true, rationale: 'Test bypass' },
  ]);

  assert.equal(res.chain.length, 2);
  assert.equal(res.appliedCount, 6);
  assert.equal(res.chain[0].wetDry, 75);
  assert.equal(res.chain[0].inputGainDb, -1.5);
  assert.equal(res.chain[0].bypassed, true);
  assert.equal((res.chain[1].params as { ceilingDb: number }).ceilingDb, -1.2);
});

test('Operating Modes & Closed-Loop Autonomous Refinement: Manual vs Assisted vs Autonomous', async () => {
  const [l, r] = makeQuietDynamicMix(2.0);
  const existingChain = [createProcessorModule('parametric-eq')];

  // 1. Manual Mode: must not mutate input chain or execute refinement passes
  const manualReport = await runAutonomousDirectorLoop({
    sourceChannels: [l, r],
    sampleRate: SR,
    operatingMode: 'manual',
    objectiveId: 'streaming',
    initialChain: existingChain,
  });
  assert.equal(manualReport.iterationsExecuted, 0);
  assert.ok(manualReport.recommendations.length >= 2);
  assert.equal(manualReport.finalChain.length, 1, 'Manual mode must preserve existing chain untouched');

  // 2. Autonomous Mode: executes real DSP render -> analyze -> QC -> refine loop
  const autoReport = await runAutonomousDirectorLoop({
    sourceChannels: [l, r],
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    exportConfig: DEFAULT_EXPORT,
    maxIterations: 3,
    convergenceThreshold: 0.5,
  });

  assert.ok(autoReport.iterationsExecuted >= 1);
  assert.ok(autoReport.postAnalysis.integratedLufs > autoReport.preAnalysis.integratedLufs + 4, 'Autonomous loop should elevate quiet mix toward -14 LUFS');
  assert.ok(autoReport.postAnalysis.truePeakDb <= -0.95, `True Peak (${autoReport.postAnalysis.truePeakDb}) must respect -1.0 dBTP ceiling`);
  assert.equal(autoReport.postAnalysis.clippedSamples, 0);
  assert.equal(autoReport.multiObjective.dimensions.length, 11);
  assert.ok(autoReport.activityLog.some((a) => a.kind === 'observation'));
  assert.ok(autoReport.activityLog.some((a) => a.kind === 'verified-result'));
});

test('SYN-QC Expansion & Failure Feedback Remediation', () => {
  const [probL, probR] = makeProblematicMix(1.5);
  const post = analyzeAudioBuffer([probL, probR], SR);
  const badExport: ExportConfig = { ...DEFAULT_EXPORT, wavBitDepth: 16, dither: 'none', ceilingDb: -0.2 };
  const qc = runQualityControl(post, post, QC_TARGET_PROFILES[0], badExport);

  assert.equal(qc.overallStatus, 'fail');
  assert.ok(qc.checks.some((c) => c.id === 'qc-lr-balance' && c.status !== 'pass'));
  assert.ok(qc.checks.some((c) => c.id === 'qc-noise-floor' && c.status !== 'pass'));
  assert.ok(qc.checks.some((c) => c.id === 'qc-export-integrity' && c.status === 'fail'));

  // Feed QC failures back into refinement command generator
  const plan = buildExplainableMasterPlan({ analysis: post, objectiveId: 'streaming' });
  const evalMetrics = evaluateMultiObjectiveMetrics(post, post, plan.objective, qc);
  const { commands } = deriveRefinementCommands(post, post, plan.chain, plan.objective, qc, evalMetrics);
  assert.ok(commands.length > 0, 'QC failures must generate targeted ChainCommands');

  // Execute commands and verify stereo/noise/balance actually improve after processing
  const refined = applyStructuredChainCommands(plan.chain, commands).chain;
  const rendered = processChainOffline([probL, probR], SR, refined);
  const after = analyzeAudioBuffer(rendered.channels, SR);
  assert.ok(after.lowEndCorrelation > post.lowEndCorrelation, 'Refined stereo focus must improve low-end phase correlation');
  assert.ok(
    Math.abs(after.lrBalanceDb) < Math.abs(post.lrBalanceDb),
    `Refined L/R balance must move closer to 0 dB (before=${post.lrBalanceDb.toFixed(2)}, after=${after.lrBalanceDb.toFixed(2)})`,
  );
});

test('SYN-ITERATE Rollback Safeguard: preserves best checkpoint if forced degradation occurs', async () => {
  const [l, r] = makeQuietDynamicMix(1.6);
  let passCounter = 0;

  const report = await runAutonomousDirectorLoop({
    sourceChannels: [l, r],
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    maxIterations: 2,
    convergenceThreshold: 0.1,
    // Simulate a bad refinement callback on Pass 2 that clips and distorts heavily
    aiRefineCallback: async ({ currentChain }) => {
      passCounter++;
      if (passCounter === 1) {
        return [
          createProcessorModule('saturation', {
            inputGainDb: 12,
            outputGainDb: 12,
            params: { flavor: 'hard-clip', drive: 100, tone: 80, harmonics: 'odd', oversampling: 1 },
          }),
        ];
      }
      return currentChain;
    },
  });

  // Pass 1 had a clean Maximizer; Pass 2 distorted/clipped with hard-clip +24dB gain -> must retain Pass 1!
  assert.equal(report.bestPassNumber, 1);
  assert.equal(report.rolledBack, true);
  assert.equal(report.postAnalysis.clippedSamples, 0);
});

test('SYN-PLUGIN Intelligence: honest offline reporting + real APVTS metadata mapping when connected', () => {
  const qaPlugin: ExternalPluginRecord = {
    uid: 'syn-test-vst3-qa',
    format: 'vst3',
    name: 'SYN Test Gain and Tilt QA',
    manufacturer: 'SYN AUDIO',
    version: '1.0.0',
    sdkVersion: '3.8',
    category: 'Fx|EQ|Mastering',
    subCategories: ['EQ'],
    bundlePath: 'C:/Program Files/Common Files/VST3/syn_test_vst3_gain.vst3',
    binaryPath: 'C:/Program Files/Common Files/VST3/syn_test_vst3_gain.vst3/Contents/x86_64-win/syn_test_vst3_gain.vst3',
    arch: 'x64',
    status: 'available',
    statusReason: 'OK',
    hasEditor: false,
    latencySamples: 0,
    busConfigs: [{ layoutName: 'Stereo', mainInputChannels: 2, mainOutputChannels: 2, sidechainInputChannels: 0 }],
    parameterCount: 3,
    parameters: [
      { id: 0, name: 'Output Gain', label: 'dB', defaultValueNormalized: 0.5, stepCount: 0, isAutomatable: true, isReadOnly: false, isBypass: false },
      { id: 1, name: 'Spectral Tilt', label: 'dB', defaultValueNormalized: 0.5, stepCount: 0, isAutomatable: true, isReadOnly: false, isBypass: false },
      { id: 2, name: 'Bypass', label: '', defaultValueNormalized: 0, stepCount: 1, isAutomatable: true, isReadOnly: false, isBypass: true },
    ],
    fileMtimeNs: 0,
    fileSizeBytes: 1024,
    fileHashSha256: 'abc',
    failCount: 0,
    lastScannedAt: 0,
    favorite: false,
    lastUsedAt: 0,
    disabledByUser: false,
  };

  const [l, r] = makeQuietDynamicMix(1.2);
  const analysis = analyzeAudioBuffer([l, r], SR);
  const plan = buildExplainableMasterPlan({ analysis, objectiveId: 'warm' });

  // Offline must report 0 compatible available plugins
  const offline = inspectPluginInventory([qaPlugin], false, analysis, plan.objective);
  assert.equal(offline.hostConnected, false);
  assert.equal(offline.compatibleAvailableCount, 0);

  // Connected host must match Gain & Tilt parameters cleanly
  const online = inspectPluginInventory([qaPlugin], true, analysis, plan.objective);
  assert.equal(online.hostConnected, true);
  assert.equal(online.compatibleAvailableCount, 1);
  assert.ok(online.matches[0].recommendedParams.some((p) => p.paramName === 'Output Gain'));
  assert.ok(online.matches[0].recommendedParams.some((p) => p.paramName === 'Spectral Tilt'));
});

test('SYN-BATTLE & SYN-REFERENCE Intelligence: objective-calibrated candidates & crest-aware reference deltas', () => {
  const [l, r] = makeQuietDynamicMix(1.4);
  const [refL, refR] = makeWarmDarkArtisticMix(1.4);
  const pre = analyzeAudioBuffer([l, r], SR);
  const ref = analyzeAudioBuffer([refL, refR], SR);

  const battle = buildBattleCandidatesIntelligent(pre);
  assert.equal(battle.length, 3);
  assert.notEqual(JSON.stringify(battle[0].chain), JSON.stringify(battle[1].chain));
  assert.notEqual(JSON.stringify(battle[1].chain), JSON.stringify(battle[2].chain));

  const cmp = compareReferenceIntelligent(pre, pre, ref);
  assert.ok(cmp.suggestedActions.length >= 1);
  assert.ok(Number.isFinite(cmp.crestDeltaDb));
  assert.ok(Number.isFinite(cmp.zoneDeltasDb.bass));
});
