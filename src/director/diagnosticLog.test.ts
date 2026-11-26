import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer } from '../dsp/analyzer';
import type { AnalysisFinding, MasterFinalReport } from '../types/mastering';
import { buildDiagnosticLog } from './diagnosticLog';
import { resolveObjectiveTarget } from './directorEngine';

test('diagnostic log never marks a missing verification classification as fixed', () => {
  const sampleRate = 48_000;
  const left = new Float32Array(sampleRate);
  const right = new Float32Array(sampleRate);
  for (let i = 0; i < sampleRate; i++) {
    left[i] = right[i] = 0.12 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  const analysis = analyzeAudioBuffer([left, right], sampleRate);
  const finding: AnalysisFinding = {
    id: 'diag-test',
    kind: 'technical-problem',
    category: 'Spectral',
    title: 'Synthetic unresolved finding',
    severity: 'moderate',
    evidence: ['measured test evidence'],
    explanation: 'Regression fixture.',
    recommendedAction: 'Re-measure the processed audio.',
  };
  const report = {
    postAnalysis: analysis,
    finalChain: [],
    targetGate: { passed: true, checks: [], failed: [], summary: 'Synthetic gate pass.' },
    postFixVerification: {
      analysisFresh: true,
      baselineAnalysisId: 'baseline',
      postAnalysisId: 'post-render',
      chainFingerprint: 'dry:0',
      postAnalysis: analysis,
      activeFindings: [],
      resolvedFindings: [],
      newlyIntroducedFindings: [],
    },
  } as unknown as MasterFinalReport;

  const log = buildDiagnosticLog({
    trackName: 'test.wav',
    objective: resolveObjectiveTarget('streaming'),
    source: analysis,
    findings: [finding],
    chain: [],
    report,
  });
  const entry = log.entries.find((candidate) => candidate.id === 'finding-diag-test');

  assert.equal(entry?.status, 'unverified');
  assert.match(log.verdict, /NOT FULLY VERIFIED/);
});

test('diagnostic log keeps an unverified vocal correction from producing a passed verdict', () => {
  const sampleRate = 48_000;
  const left = new Float32Array(sampleRate);
  const right = new Float32Array(sampleRate);
  for (let i = 0; i < sampleRate; i++) {
    left[i] = right[i] = 0.12 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  const analysis = analyzeAudioBuffer([left, right], sampleRate);
  const report = {
    postAnalysis: analysis,
    finalChain: [],
    targetGate: { passed: true, checks: [], failed: [], summary: 'Synthetic gate pass.' },
    postFixVerification: {
      analysisFresh: true,
      baselineAnalysisId: 'baseline',
      postAnalysisId: 'post-render',
      chainFingerprint: 'dry:0',
      postAnalysis: analysis,
      activeFindings: [],
      resolvedFindings: [],
      newlyIntroducedFindings: [],
    },
    vocalBalanceVerification: {
      status: 'unverified',
      sourceBalanceDb: null,
      referenceBalanceDb: null,
      postRenderBalanceDb: null,
      appliedGainDb: 0,
      summary: 'Reference stem separation failed.',
    },
  } as unknown as MasterFinalReport;
  const log = buildDiagnosticLog({
    trackName: 'test.wav',
    objective: resolveObjectiveTarget('vocal-focused'),
    source: analysis,
    findings: [],
    chain: [],
    report,
  });

  assert.equal(log.entries.find((entry) => entry.id === 'vocal-balance')?.status, 'unverified');
  assert.match(log.verdict, /NOT FULLY VERIFIED/);
});
