import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer } from '../dsp/analyzer';
import { createProcessorModule } from '../dsp/chainValidation';
import { processChainOffline } from '../dsp/offlineDsp';
import type { AppliedCorrectionRecord, ProcessorModule } from '../types/mastering';
import { analyzeTrackIntelligence, computeRegionEnergyDb } from './analyzeIntelligence';
import { runAutonomousDirectorLoop } from './directorEngine';
import { computeChainFingerprint, verifyPostFixAnalysis } from './postFixVerification';

const SR = 44100;

function makeMuddyWithSubAndClipRisk(durationSec = 1.4): Float32Array[] {
  const n = Math.floor(SR * durationSec);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const bass = 0.24 * Math.sin(2 * Math.PI * 82 * t) + 0.14 * Math.sin(2 * Math.PI * 115 * t);
    const mud =
      0.34 * Math.sin(2 * Math.PI * 185 * t) +
      0.38 * Math.sin(2 * Math.PI * 285 * t) +
      0.26 * Math.sin(2 * Math.PI * 340 * t);
    const midHigh =
      0.16 * Math.sin(2 * Math.PI * 680 * t) +
      0.16 * Math.sin(2 * Math.PI * 1150 * t) +
      0.13 * Math.sin(2 * Math.PI * 1650 * t) +
      0.10 * Math.sin(2 * Math.PI * 2600 * t) +
      0.08 * Math.sin(2 * Math.PI * 3900 * t) +
      0.06 * Math.sin(2 * Math.PI * 5200 * t);
    L[i] = 0.25 * (bass + mud + midHigh);
    R[i] = 0.25 * (bass + mud + midHigh * 0.96);
  }
  return [L, R];
}

function makeCleanBassHeavyHipHop(durationSec = 1.4): Float32Array[] {
  const n = Math.floor(SR * durationSec);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Deep intentional 58-92 Hz 808/sub foundation with clean 150-400 Hz pocket & clear mids
    const subAndBass =
      0.42 * Math.sin(2 * Math.PI * 58 * t) +
      0.38 * Math.sin(2 * Math.PI * 92 * t);
    const cleanMudRegion = 0.08 * Math.sin(2 * Math.PI * 240 * t);
    const vocalAndSnareMid =
      0.16 * Math.sin(2 * Math.PI * 1050 * t) +
      0.12 * Math.sin(2 * Math.PI * 3100 * t);
    L[i] = 0.28 * (subAndBass + cleanMudRegion + vocalAndSnareMid);
    R[i] = 0.28 * (subAndBass + cleanMudRegion + vocalAndSnareMid * 0.95);
  }
  return [L, R];
}

function makeMuddyOutOfPhaseStereo(durationSec = 1.4): Float32Array[] {
  const n = Math.floor(SR * durationSec);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const subL = 0.26 * Math.sin(2 * Math.PI * 62 * t);
    const subR = 0.26 * Math.sin(2 * Math.PI * 62 * t + 2.35);
    const mud =
      0.34 * Math.sin(2 * Math.PI * 270 * t) +
      0.30 * Math.sin(2 * Math.PI * 190 * t);
    const mid =
      0.15 * Math.sin(2 * Math.PI * 720 * t) +
      0.14 * Math.sin(2 * Math.PI * 1250 * t) +
      0.09 * Math.sin(2 * Math.PI * 2800 * t);
    L[i] = 0.26 * (subL + mud + mid);
    R[i] = 0.26 * (subR + mud + mid * 0.94);
  }
  return [L, R];
}

function renderAndAnalyze(channels: Float32Array[], chain: ProcessorModule[]) {
  const rendered = processChainOffline(channels, SR, chain);
  return analyzeAudioBuffer(rendered.channels, SR);
}

test('1. Applying a correction without running post-analysis does NOT mark finding resolved', () => {
  const src = makeMuddyWithSubAndClipRisk();
  const baseline = analyzeAudioBuffer(src, SR);
  const eq = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 0,
      bands: [{ id: 'b1', enabled: true, shape: 'bell', freq: 260, gain: -6, q: 1.2 }],
    },
  });
  const fp = computeChainFingerprint([eq]);
  const corrections: AppliedCorrectionRecord[] = [
    {
      id: 'corr-1',
      timestamp: Date.now(),
      label: 'Surgical EQ cut -6 dB @ 260 Hz',
      findingId: 'diag-mud',
      processorTypes: ['parametric-eq'],
      chainFingerprint: fp,
    },
  ];

  const report = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    postAnalysis: null,
    objective: 'streaming',
    currentChainFingerprint: fp,
    postProcessingStatus: 'idle',
    appliedCorrections: corrections,
  });

  assert.equal(report.analysisFresh, false);
  assert.equal(report.resolvedFindings.length, 0);
  const mudState = report.activeFindings.find((f) => f.findingId === 'diag-mud');
  assert.ok(mudState, 'diag-mud must remain in activeFindings when unanalyzed');
  assert.equal(mudState.status, 'UNVERIFIED');
  assert.equal(mudState.measurementReliable, false);
  assert.ok(
    mudState.afterMeasurements.every((m) => m.afterValue === null && m.afterFormatted === 'UNVERIFIED'),
  );
});

test('2. Genuinely effective DSP fix resolves diag-mud with Before/After verification and moves to resolvedFindings', () => {
  const src = makeMuddyWithSubAndClipRisk();
  const baseline = analyzeAudioBuffer(src, SR);
  const baseDiag = analyzeTrackIntelligence(baseline, 'streaming');
  assert.ok(baseDiag.findings.some((f) => f.id === 'diag-mud'));

  // Apply real surgical 30 Hz HPF + 185/295 Hz attenuation cuts via offline DSP
  const eqFix = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 0.4,
      bands: [
        { id: 'b1', enabled: true, shape: 'highpass', freq: 30, gain: 0, q: 0.71 },
        { id: 'b2', enabled: true, shape: 'bell', freq: 185, gain: -8.0, q: 1.1 },
        { id: 'b3', enabled: true, shape: 'bell', freq: 295, gain: -8.5, q: 1.0 },
      ],
    },
  });
  const chain = [eqFix];
  const fp = computeChainFingerprint(chain);
  const post = renderAndAnalyze(src, chain);

  const report = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    baselineDiagnosis: baseDiag,
    postAnalysis: post,
    objective: 'streaming',
    baselineAnalysisId: 'track-1',
    postAnalysisId: 'post-1',
    currentChainFingerprint: fp,
    postChainFingerprint: fp,
    postProcessingStatus: 'ready',
    appliedCorrections: [
      {
        id: 'corr-eq-fix',
        timestamp: Date.now(),
        label: 'Applied 175/280 Hz bell cuts + 30 Hz HPF',
        findingId: 'diag-mud',
        processorTypes: ['parametric-eq'],
        chainFingerprint: fp,
      },
    ],
  });

  assert.equal(report.analysisFresh, true);
  assert.equal(
    report.activeFindings.some((f) => f.findingId === 'diag-mud'),
    false,
    'Resolved diag-mud must be removed from activeFindings',
  );
  const resolvedMud = report.resolvedFindings.find((f) => f.findingId === 'diag-mud');
  assert.ok(resolvedMud, 'diag-mud must appear in resolvedFindings');
  assert.equal(resolvedMud.status, 'RESOLVED');
  assert.match(resolvedMud.verificationSummary, /Status: RESOLVED/);

  const regBefore = computeRegionEnergyDb(baseline, 150, 400)!;
  const regAfter = computeRegionEnergyDb(post, 150, 400)!;
  assert.ok(regAfter < regBefore - 5, `150–400 Hz energy must measurably drop (${regBefore.toFixed(1)} -> ${regAfter.toFixed(1)})`);
  assert.ok(report.affectedMetricsSummary.region150To400DbAfter !== null);
  assert.ok(report.affectedMetricsSummary.region150To400DbAfter! < report.affectedMetricsSummary.region150To400DbBefore!);
});

test('3. Ineffective correction (bypassed EQ or unrelated 10 kHz cut) leaves finding UNRESOLVED', () => {
  const src = makeMuddyWithSubAndClipRisk();
  const baseline = analyzeAudioBuffer(src, SR);

  // Wrong frequency: cut 10 kHz instead of 150-400 Hz
  const wrongEq = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 0,
      bands: [{ id: 'b1', enabled: true, shape: 'bell', freq: 10000, gain: -6.0, q: 1.5 }],
    },
  });
  const fp = computeChainFingerprint([wrongEq]);
  const post = renderAndAnalyze(src, [wrongEq]);

  const report = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    postAnalysis: post,
    objective: 'streaming',
    baselineAnalysisId: 'track-1',
    postAnalysisId: 'post-wrong',
    currentChainFingerprint: fp,
    postChainFingerprint: fp,
    postProcessingStatus: 'ready',
    appliedCorrections: [
      {
        id: 'corr-wrong',
        timestamp: Date.now(),
        label: 'Cut -6 dB @ 10 kHz',
        findingId: 'diag-mud',
        processorTypes: ['parametric-eq'],
        chainFingerprint: fp,
      },
    ],
  });

  assert.equal(report.resolvedFindings.length, 0);
  const mudState = report.activeFindings.find((f) => f.findingId === 'diag-mud');
  assert.ok(mudState);
  assert.equal(mudState.status, 'UNRESOLVED');
});

test('4. Partially effective correction yields IMPROVED or PARTIALLY_RESOLVED and stays active', () => {
  const src = makeMuddyWithSubAndClipRisk();
  const baseline = analyzeAudioBuffer(src, SR);

  // Too gentle: only -2.0 dB at 260 Hz leaves significant mud remaining
  const weakEq = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 0,
      bands: [
        { id: 'b1', enabled: true, shape: 'bell', freq: 175, gain: -1.8, q: 1.4 },
        { id: 'b2', enabled: true, shape: 'bell', freq: 280, gain: -2.0, q: 1.4 },
      ],
    },
  });
  const fp = computeChainFingerprint([weakEq]);
  const post = renderAndAnalyze(src, [weakEq]);

  const report = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    postAnalysis: post,
    objective: 'streaming',
    baselineAnalysisId: 'track-1',
    postAnalysisId: 'post-weak',
    currentChainFingerprint: fp,
    postChainFingerprint: fp,
    postProcessingStatus: 'ready',
    appliedCorrections: [
      {
        id: 'corr-weak',
        timestamp: Date.now(),
        label: 'Mild -2 dB @ 280 Hz',
        findingId: 'diag-mud',
        processorTypes: ['parametric-eq'],
        chainFingerprint: fp,
      },
    ],
  });

  const mudState = report.activeFindings.find((f) => f.findingId === 'diag-mud');
  assert.ok(mudState, 'Insufficient cut must NOT resolve diag-mud');
  assert.ok(
    mudState.status === 'IMPROVED' || mudState.status === 'PARTIALLY_RESOLVED',
    `Expected IMPROVED or PARTIALLY_RESOLVED, got ${mudState.status}`,
  );
  assert.ok(mudState.remainingDeviation);
  assert.ok(mudState.nextRecommendedAction);
});

test('5. Failed or corrupted post-analysis returns UNVERIFIED and never fabricates metrics', () => {
  const src = makeMuddyWithSubAndClipRisk();
  const baseline = analyzeAudioBuffer(src, SR);

  const failedReport = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    postAnalysis: null,
    objective: 'streaming',
    postProcessingStatus: 'failed',
    postProcessingError: 'Worker render timed out',
    appliedCorrections: [
      {
        id: 'corr-f',
        timestamp: Date.now(),
        label: 'EQ Cut',
        processorTypes: ['parametric-eq'],
        chainFingerprint: 'active:1:abc',
      },
    ],
  });
  assert.equal(failedReport.analysisFresh, false);
  assert.equal(failedReport.resolvedFindings.length, 0);
  assert.equal(failedReport.affectedMetricsSummary.integratedLufsAfter, null);
  assert.ok(failedReport.activeFindings.every((f) => f.status === 'UNVERIFIED'));

  // Corrupted NaN analysis must also be rejected as UNVERIFIED
  const corrupted = { ...baseline, integratedLufs: Number.NaN, rmsDb: Number.NaN };
  const corruptReport = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    postAnalysis: corrupted,
    objective: 'streaming',
    baselineAnalysisId: 'b1',
    postAnalysisId: 'p1',
    currentChainFingerprint: 'active:1:abc',
    postChainFingerprint: 'active:1:abc',
    postProcessingStatus: 'ready',
  });
  assert.equal(corruptReport.analysisFresh, false);
  assert.equal(corruptReport.resolvedFindings.length, 0);
  assert.ok(corruptReport.activeFindings.every((f) => f.status === 'UNVERIFIED'));
});

test('6 & 7. Baseline metrics remain preserved and stale/cached postAnalysis mismatches are rejected', () => {
  const src = makeMuddyWithSubAndClipRisk();
  const baseline = analyzeAudioBuffer(src, SR);

  const staleFp = 'active:1:old-fp';
  const currentFp = 'active:2:new-fp';
  const eq = createProcessorModule('parametric-eq');
  const oldPost = renderAndAnalyze(src, [eq]);

  const staleReport = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    postAnalysis: oldPost,
    objective: 'streaming',
    baselineAnalysisId: 'trk-1',
    postAnalysisId: 'post-old',
    currentChainFingerprint: currentFp,
    postChainFingerprint: staleFp,
    postProcessingStatus: 'ready',
  });

  assert.equal(staleReport.analysisFresh, false);
  assert.equal(staleReport.resolvedFindings.length, 0);
  assert.ok(staleReport.verificationError?.includes('outdated mastering chain'));
  assert.equal(staleReport.baselineAnalysis.integratedLufs, baseline.integratedLufs);
  assert.equal(staleReport.affectedMetricsSummary.integratedLufsBefore, baseline.integratedLufs);
  assert.equal(staleReport.affectedMetricsSummary.integratedLufsAfter, null);

  // Cached baseline ID masquerading as post-analysis after applying a correction
  const cachedBaselineReport = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    postAnalysis: baseline,
    objective: 'streaming',
    baselineAnalysisId: 'trk-1',
    postAnalysisId: 'trk-1',
    currentChainFingerprint: currentFp,
    postChainFingerprint: currentFp,
    postProcessingStatus: 'ready',
    appliedCorrections: [
      {
        id: 'corr-2',
        timestamp: Date.now(),
        label: 'EQ',
        processorTypes: ['parametric-eq'],
        chainFingerprint: currentFp,
      },
    ],
  });
  assert.equal(cachedBaselineReport.analysisFresh, false);
  assert.ok(cachedBaselineReport.activeFindings.every((f) => f.status === 'UNVERIFIED'));
});

test('8. Fixing mud leaves unrelated active findings (low-end phase cancellation) active', () => {
  const src = makeMuddyOutOfPhaseStereo();
  const baseline = analyzeAudioBuffer(src, SR);
  const baseDiag = analyzeTrackIntelligence(baseline, 'streaming');
  assert.ok(baseDiag.findings.some((f) => f.id === 'diag-mud'));
  assert.ok(baseDiag.findings.some((f) => f.id === 'diag-phase'));

  // Fix only mud with EQ, leave out-of-phase sub untouched
  const eqOnly = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 0.6,
      bands: [
        { id: 'b1', enabled: true, shape: 'bell', freq: 180, gain: -9.0, q: 1.4 },
        { id: 'b2', enabled: true, shape: 'bell', freq: 255, gain: -9.5, q: 1.4 },
      ],
    },
  });
  const fp = computeChainFingerprint([eqOnly]);
  const post = renderAndAnalyze(src, [eqOnly]);

  const report = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    baselineDiagnosis: baseDiag,
    postAnalysis: post,
    objective: 'streaming',
    baselineAnalysisId: 't-phase',
    postAnalysisId: 'p-eq-only',
    currentChainFingerprint: fp,
    postChainFingerprint: fp,
    postProcessingStatus: 'ready',
    appliedCorrections: [
      {
        id: 'corr-mud-only',
        timestamp: Date.now(),
        label: 'Fixed Mud Only',
        findingId: 'diag-mud',
        processorTypes: ['parametric-eq'],
        chainFingerprint: fp,
      },
    ],
  });

  assert.ok(
    report.resolvedFindings.some((f) => f.findingId === 'diag-mud'),
    'diag-mud should be resolved',
  );
  assert.ok(
    report.activeFindings.some((f) => f.findingId === 'diag-phase' && f.status !== 'RESOLVED'),
    'Unaddressed diag-phase must remain in activeFindings',
  );
});

test('9. False-positive prevention: naturally bass-heavy clean Hip-Hop mix is NOT flagged as mud', () => {
  const cleanBassHeavy = makeCleanBassHeavyHipHop();
  const analysis = analyzeAudioBuffer(cleanBassHeavy, SR);
  const diag = analyzeTrackIntelligence(analysis, 'hip-hop');

  assert.equal(
    diag.findings.some((f) => f.id === 'diag-mud'),
    false,
    'Clean bass-heavy mix without 150–400 Hz mud must not produce diag-mud false positive',
  );
  assert.ok(
    diag.findings.some((f) => f.id === 'diag-bass-heavy-clean' && f.kind === 'artistic-choice'),
    'Should recognize clean bass-heavy foundation as an artistic choice',
  );
});

test('10. Autonomous Director Loop integrates evidence-based PostFixVerificationReport with full affected metrics', async () => {
  const src = makeMuddyWithSubAndClipRisk();
  const report = await runAutonomousDirectorLoop({
    sourceChannels: src,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    maxIterations: 3,
  });

  assert.ok(report.postFixVerification, 'MasterFinalReport must include postFixVerification');
  const pfv = report.postFixVerification!;
  assert.equal(pfv.analysisFresh, true);
  assert.ok(Number.isFinite(pfv.affectedMetricsSummary.integratedLufsAfter!));
  assert.ok(Number.isFinite(pfv.affectedMetricsSummary.shortTermLufsMaxAfter!));
  assert.ok(Number.isFinite(pfv.affectedMetricsSummary.rmsDbAfter!));
  assert.ok(Number.isFinite(pfv.affectedMetricsSummary.samplePeakDbAfter!));
  assert.ok(Number.isFinite(pfv.affectedMetricsSummary.truePeakDbAfter!));
  assert.ok(Number.isFinite(pfv.affectedMetricsSummary.crestFactorDbAfter!));
  assert.ok(Number.isFinite(pfv.affectedMetricsSummary.plrDbAfter!));
  assert.ok(Number.isFinite(pfv.affectedMetricsSummary.dynamicRangeDbAfter!));
  assert.ok(pfv.affectedMetricsSummary.region150To400DbAfter !== null);
});

test('11. Scenario D (Over-cut): Excessive 150-400 Hz cut surfaces newly introduced hollow tonal imbalance', () => {
  const src = makeMuddyWithSubAndClipRisk();
  const baseline = analyzeAudioBuffer(src, SR);
  const eqOvercut = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 1.5,
      bands: [
        { id: 'b1', enabled: true, shape: 'bell', freq: 200, gain: -12, q: 0.7 },
        { id: 'b2', enabled: true, shape: 'bell', freq: 310, gain: -12, q: 0.7 },
        { id: 'b3', enabled: true, shape: 'lowshelf', freq: 140, gain: -10, q: 0.8 },
      ],
    },
  });
  const fp = computeChainFingerprint([eqOvercut]);
  const post = renderAndAnalyze(src, [eqOvercut]);

  const report = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    postAnalysis: post,
    objective: 'streaming',
    baselineAnalysisId: 'b-d',
    postAnalysisId: 'p-d',
    currentChainFingerprint: fp,
    postChainFingerprint: fp,
    postProcessingStatus: 'ready',
    appliedCorrections: [
      {
        id: 'corr-overcut',
        timestamp: Date.now(),
        label: 'Over-cut EQ (-12 dB @ 200/310 Hz)',
        findingId: 'diag-mud',
        processorTypes: ['parametric-eq'],
        chainFingerprint: fp,
      },
    ],
  });

  assert.ok(
    report.newlyIntroducedFindings.some(
      (f) => f.id === 'diag-hollow-lowmid' || f.id === 'diag-overcut-imbalance',
    ),
    'Over-cut low-mid must be flagged in newlyIntroducedFindings',
  );
});

test('12. Scenario E (Collateral loudness/ceiling breach): Spectral fix + hot maximizer flags True Peak & Loudness overshoot', () => {
  const src = makeMuddyWithSubAndClipRisk();
  const baseline = analyzeAudioBuffer(src, SR);
  const eqFix = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 0.4,
      bands: [
        { id: 'b1', enabled: true, shape: 'highpass', freq: 30, gain: 0, q: 0.71 },
        { id: 'b2', enabled: true, shape: 'bell', freq: 185, gain: -8.0, q: 1.1 },
        { id: 'b3', enabled: true, shape: 'bell', freq: 295, gain: -8.5, q: 1.0 },
      ],
    },
  });
  const hotMax = createProcessorModule('maximizer', {
    params: {
      character: 'aggressive',
      targetLufs: -7.5,
      ceilingDb: -0.3,
      transientEmphasis: 20,
      truePeak: false,
    },
  });
  const chain = [eqFix, hotMax];
  const fp = computeChainFingerprint(chain);
  const post = renderAndAnalyze(src, chain);

  const report = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    postAnalysis: post,
    objective: 'streaming',
    baselineAnalysisId: 'b-e',
    postAnalysisId: 'p-e',
    currentChainFingerprint: fp,
    postChainFingerprint: fp,
    postProcessingStatus: 'ready',
  });

  assert.ok(report.resolvedFindings.some((f) => f.findingId === 'diag-mud'));
  assert.ok(
    report.newlyIntroducedFindings.some((f) => f.id === 'diag-tp-ceiling-exceeded'),
    'Must detect newly exceeded True Peak delivery ceiling (-0.3 > -1.0 dBTP)',
  );
  assert.ok(
    report.newlyIntroducedFindings.some((f) => f.id === 'diag-loudness-overshoot'),
    'Must detect excessive loudness overshoot above Streaming -14 LUFS target',
  );
});

test('13. Pink-noise -3 dB/oct curve does NOT trigger diag-mud false positive & fingerprint collapses no-ops', () => {
  const n = SR * 2;
  const pL = new Float32Array(n);
  const pR = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let seed = 42;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const w = ((seed / 4294967296) * 2 - 1) * 0.22;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    const p = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.12;
    b6 = w * 0.115926;
    pL[i] = p;
    pR[i] = p;
  }
  const pinkAnalysis = analyzeAudioBuffer([pL, pR], SR);
  const pinkDiag = analyzeTrackIntelligence(pinkAnalysis, 'streaming');
  assert.equal(
    pinkDiag.findings.some((f) => f.id === 'diag-mud'),
    false,
    'Flat -3 dB/oct pink noise must not false-trigger diag-mud',
  );

  const disabledBandEq = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 0,
      bands: [{ id: 'b1', enabled: false, shape: 'bell', freq: 300, gain: -6, q: 1.2 }],
    },
  });
  const dryComp = createProcessorModule('compressor', { wetDry: 0 });
  assert.equal(computeChainFingerprint([disabledBandEq, dryComp]), 'dry:0');
});

test('14. Short zero-padded FFT preserves calibrated 1 kHz amplitude & LPF mid-collapse cannot falsely resolve diag-mud', async () => {
  const { computeMagnitudeSpectrumDb } = await import('../dsp/fft');
  const shortLen = 1024;
  const shortSine = new Float32Array(shortLen);
  for (let i = 0; i < shortLen; i++) {
    shortSine[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
  }
  const spec = computeMagnitudeSpectrumDb(shortSine, 4096);
  const peakDb = Math.max(...spec);
  assert.ok(
    Math.abs(peakDb - -6.02) < 0.6,
    `Expected ~ -6.02 dBFS for 0.5-amp short sine in 4096-pt FFT, got ${peakDb.toFixed(2)}`,
  );

  const src = makeMuddyWithSubAndClipRisk();
  const baseline = analyzeAudioBuffer(src, SR);
  const brutalLpf = createProcessorModule('parametric-eq', {
    params: {
      phaseMode: 'minimum',
      msMode: 'stereo',
      tiltDb: 0,
      bands: [{ id: 'lp', enabled: true, shape: 'lowpass', freq: 650, gain: 0, q: 0.71 }],
    },
  });
  const fp = computeChainFingerprint([brutalLpf]);
  const post = renderAndAnalyze(src, [brutalLpf]);
  const rep = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    postAnalysis: post,
    objective: 'streaming',
    baselineAnalysisId: 'b-lpf',
    postAnalysisId: 'p-lpf',
    currentChainFingerprint: fp,
    postChainFingerprint: fp,
    postProcessingStatus: 'ready',
  });
  assert.equal(
    rep.resolvedFindings.some((f) => f.findingId === 'diag-mud'),
    false,
    'Mid-collapsing LPF must never mark diag-mud RESOLVED',
  );
});


test('15. Spectral zone levels and Director region levels share one log-frequency power estimator', () => {
  const analysis = analyzeAudioBuffer(makeMuddyWithSubAndClipRisk(), SR);
  const zones = [
    ['sub', 20, 60],
    ['bass', 60, 250],
    ['lowMid', 250, 500],
    ['mid', 500, 2000],
    ['highMid', 2000, 6000],
    ['presence', 6000, 12000],
  ] as const;

  for (const [key, lowHz, highHz] of zones) {
    const directorLevel = computeRegionEnergyDb(analysis, lowHz, highHz);
    assert.notEqual(directorLevel, null, `Expected log-band samples for ${key}`);
    assert.ok(
      Math.abs(analysis.zoneEnergyDb[key] - directorLevel!) <= 0.011,
      `${key} zone (${analysis.zoneEnergyDb[key]} dB) must match Director region (${directorLevel} dB)`,
    );
  }

  const bassCenterHz = Math.sqrt(60 * 250);
  const presenceCenterHz = Math.sqrt(6000 * 12000);
  const expectedSlope =
    (analysis.zoneEnergyDb.presence - analysis.zoneEnergyDb.bass) /
    Math.log2(presenceCenterHz / bassCenterHz);
  assert.ok(
    Math.abs(analysis.spectralSlopeDbPerOct - expectedSlope) <= 0.011,
    'Spectral slope must use the actual octave distance between representative band centers',
  );
});

test('16. Low-mid diagnosis reports evidence strength and does not claim unmeasured limiter pumping', () => {
  const analysis = analyzeAudioBuffer(makeMuddyWithSubAndClipRisk(), SR);
  const diagnosis = analyzeTrackIntelligence(analysis, 'streaming');
  const mud = diagnosis.findings.find((finding) => finding.id === 'diag-mud');

  assert.ok(mud, 'The deliberately low-mid-heavy fixture should produce a diagnostic hypothesis');
  assert.equal(mud.evidenceStrength, 'convergent');
  assert.match(mud.title, /Potential/i);
  assert.match(mud.explanation, /cannot confirm audible masking/i);
  assert.doesNotMatch(mud.explanation, /forces the limiter to pump/i);
  assert.match(mud.recommendedAction ?? '', /audition/i);
});

test('Partially resolved mud recommendation targets bass when only Bass vs Mid remains out of range', () => {
  const baseline = analyzeAudioBuffer(makeMuddyWithSubAndClipRisk(), SR);
  const baselineDiagnosis = analyzeTrackIntelligence(baseline, 'streaming');
  assert.ok(baselineDiagnosis.findings.some((finding) => finding.id === 'diag-mud'));
  const post = {
    ...baseline,
    zoneEnergyDb: {
      ...baseline.zoneEnergyDb,
      lowMid: baseline.zoneEnergyDb.mid + 2.0,
      bass: baseline.zoneEnergyDb.mid + 11.7,
      sub: baseline.zoneEnergyDb.mid + 15.7,
    },
    spectrumBinsDb: baseline.spectrumBinsFreq.map((frequency, index) =>
      frequency >= 150 && frequency <= 400 ? baseline.spectrumBinsDb[index] - 10 : baseline.spectrumBinsDb[index]),
  };
  const fp = 'mud-bass-refinement';
  const report = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    baselineDiagnosis,
    postAnalysis: post,
    objective: 'streaming',
    currentChainFingerprint: fp,
    postChainFingerprint: fp,
    postProcessingStatus: 'ready',
  });
  const mud = report.activeFindings.find((finding) => finding.findingId === 'diag-mud');
  assert.ok(mud);
  assert.equal(mud.status, 'PARTIALLY_RESOLVED');
  assert.match(mud.remainingDeviation ?? '', /Bass vs Mid/);
  assert.match(mud.nextRecommendedAction ?? '', /low-shelf/i);
  assert.doesNotMatch(mud.nextRecommendedAction ?? '', /220-340 Hz bell cut/i);
});

test('source clipping cannot be marked RESOLVED by simply attenuating the clipped waveform', () => {
  const n = SR * 2;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const sample = 1.3 * Math.sin((2 * Math.PI * 997 * i) / SR);
    const clipped = Math.max(-1, Math.min(1, sample));
    left[i] = clipped;
    right[i] = clipped;
  }

  const source = [left, right];
  const baseline = analyzeAudioBuffer(source, SR);
  assert.ok(baseline.clippedSamples > 0, 'Fixture must contain full-scale clipped samples');

  // Gain reduction removes the over-ceiling sample count but cannot restore the clipped waveform.
  const attenuated = source.map((channel) => Float32Array.from(channel, (sample) => sample * 0.5));
  const post = analyzeAudioBuffer(attenuated, SR);
  assert.equal(post.clippedSamples, 0, 'Attenuated output must fall below the analyzer full-scale threshold');

  const report = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    postAnalysis: post,
    objective: 'streaming',
    baselineAnalysisId: 'clipped-source',
    postAnalysisId: 'attenuated-output',
    currentChainFingerprint: 'gain-trim-only',
    postChainFingerprint: 'gain-trim-only',
    postProcessingStatus: 'ready',
  });

  const clipping = report.activeFindings.find((finding) => finding.findingId === 'diag-clipping');
  assert.ok(clipping, 'Irreversible source clipping must remain visible after output attenuation');
  assert.equal(clipping.status, 'UNRESOLVED');
  assert.match(clipping.verificationSummary, /source.*clipp|clipp.*source/i);
  assert.match(clipping.nextRecommendedAction ?? '', /unclipped|source/i);
  assert.equal(
    report.resolvedFindings.some((finding) => finding.findingId === 'diag-clipping'),
    false,
    'Gain reduction must never be reported as reconstruction of clipped source peaks',
  );
});

test('corrupted secondary telemetry is rejected before any finding can be resolved', () => {
  const baseline = analyzeAudioBuffer(makeMuddyWithSubAndClipRisk(), SR);
  const invalidAnalyses: Array<{ label: string; analysis: typeof baseline }> = [
    {
      label: 'non-finite clipping counter',
      analysis: { ...baseline, clippedSamples: Number.NaN },
    },
    {
      label: 'non-finite spectral zone',
      analysis: {
        ...baseline,
        zoneEnergyDb: { ...baseline.zoneEnergyDb, lowMid: Number.NaN },
      },
    },
    {
      label: 'non-finite spectrum bin',
      analysis: {
        ...baseline,
        spectrumBinsDb: baseline.spectrumBinsDb.map((value, index) => index === 3 ? Number.NaN : value),
      },
    },
    {
      label: 'out-of-range phase correlation',
      analysis: { ...baseline, phaseCorrelation: 1.25 },
    },
    {
      label: 'missing spectral-zone object',
      analysis: { ...baseline, zoneEnergyDb: null as unknown as typeof baseline.zoneEnergyDb },
    },
    {
      label: 'null resonance entry',
      analysis: {
        ...baseline,
        resonances: [null as unknown as typeof baseline.resonances[number]],
      },
    },
  ];

  for (const candidate of invalidAnalyses) {
    const report = verifyPostFixAnalysis({
      baselineAnalysis: baseline,
      postAnalysis: candidate.analysis,
      objective: 'streaming',
      baselineAnalysisId: 'integrity-baseline',
      postAnalysisId: `invalid-${candidate.label}`,
      currentChainFingerprint: 'integrity-check',
      postChainFingerprint: 'integrity-check',
      postProcessingStatus: 'ready',
    });
    assert.equal(report.analysisFresh, false, `Must reject ${candidate.label}`);
    assert.match(report.verificationError ?? '', /reliability/i);
    assert.equal(report.resolvedFindings.length, 0, `Must not resolve findings from ${candidate.label}`);
    assert.ok(report.activeFindings.every((finding) => finding.status === 'UNVERIFIED'));
  }
});

test('Pre-existing dynamic compression and harmonic distortion cannot be marked resolved by changed output telemetry', () => {
  const n = SR * 2;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const sample = 0.35 * Math.tanh(7 * Math.sin((2 * Math.PI * 997 * i) / SR));
    left[i] = sample;
    right[i] = sample * 0.98;
  }

  const measuredBaseline = analyzeAudioBuffer([left, right], SR);
  const baseline = {
    ...measuredBaseline,
    dynamicRangeDb: 3.0,
    crestFactorDb: 4.0,
    loudnessRangeLu: 1.0,
    thdEstimatePercent: 7.0,
  };
  const baselineDiagnosis = analyzeTrackIntelligence(baseline, 'streaming');
  const compressed = baselineDiagnosis.findings.find((finding) => finding.id === 'diag-overcompressed');
  const distorted = baselineDiagnosis.findings.find((finding) => finding.id === 'diag-thd');
  assert.ok(
    compressed,
    'Steady, low-crest source fixture must be identified as pre-compressed',
  );
  assert.ok(
    distorted,
    'Saturated source fixture must be identified as pre-existing harmonic distortion',
  );

  // Deliberately present optimistic post metrics to prove the verifier cannot mistake
  // a lower THD estimate or altered DR/crest measurements for reconstructed source data.
  const post = {
    ...baseline,
    dynamicRangeDb: Math.max(14, baseline.dynamicRangeDb + 8),
    crestFactorDb: Math.max(10, baseline.crestFactorDb + 5),
    loudnessRangeLu: Math.max(5, baseline.loudnessRangeLu + 4),
    thdEstimatePercent: 0.5,
  };
  const report = verifyPostFixAnalysis({
    baselineAnalysis: baseline,
    postAnalysis: post,
    objective: 'streaming',
    baselineAnalysisId: 'damaged-source',
    postAnalysisId: 'processed-output',
    currentChainFingerprint: 'source-integrity-check',
    postChainFingerprint: 'source-integrity-check',
    postProcessingStatus: 'ready',
  });

  for (const findingId of ['diag-overcompressed', 'diag-thd']) {
    const state =
      report.activeFindings.find((finding) => finding.findingId === findingId) ??
      report.resolvedFindings.find((finding) => finding.findingId === findingId);
    assert.ok(state, findingId + ' must remain visible after processing');
    assert.equal(state.status, 'UNRESOLVED', findingId + ' cannot be resolved from meter movement alone');
    assert.equal(
      report.resolvedFindings.some((finding) => finding.findingId === findingId),
      false,
      findingId + ' must not be reported as reconstructed source material',
    );
    assert.match(state.verificationSummary, /source integrity|source entered mastering/i);
    assert.match(state.nextRecommendedAction ?? '', /premaster|source/i);
  }
});
