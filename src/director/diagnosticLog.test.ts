import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyzeAudioBuffer } from '../dsp/analyzer';
import type { AiFallbackReason, AiPassTrace, AnalysisFinding, MasterFinalReport, VerifiedFindingState } from '../types/mastering';
import { DiagnosticLogPanel } from '../components/studio/DiagnosticLogPanel';
import { MasterConsole } from '../components/console/MasterConsole';
import {
  buildDiagnosticLog,
  diagnosticLogToText,
  diagnosticStatusForFinding,
  summarizeAiFallbackBanner,
} from './diagnosticLog';
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

function state(status: VerifiedFindingState['status'], measurementReliable = true): VerifiedFindingState {
  return {
    findingId: 'diag-mud',
    originalFinding: { id: 'diag-mud' } as VerifiedFindingState['originalFinding'],
    postFinding: null,
    status,
    updatedSeverity: 'low',
    beforeMeasurements: [],
    afterMeasurements: [],
    verificationSummary: 'test',
    appliedCorrections: [],
    measurementReliable,
  };
}

function report(activeFindings: VerifiedFindingState[], resolvedFindings: VerifiedFindingState[] = []): MasterFinalReport {
  return { postFixVerification: { activeFindings, resolvedFindings, analysisFresh: true, postAnalysis: {} } } as unknown as MasterFinalReport;
}

test('diagnostic status never turns missing verification evidence green', () => {
  assert.equal(diagnosticStatusForFinding(null, 'diag-mud'), 'open');
  assert.equal(diagnosticStatusForFinding(report([], []), 'diag-mud'), 'unverified');
  const stale = report([], []);
  stale.postFixVerification!.analysisFresh = false;
  assert.equal(diagnosticStatusForFinding(stale, 'diag-mud'), 'unverified');
});

test('diagnostic status reflects measured partial and unresolved outcomes', () => {
  assert.equal(diagnosticStatusForFinding(report([state('IMPROVED')]), 'diag-mud'), 'improved');
  assert.equal(diagnosticStatusForFinding(report([state('PARTIALLY_RESOLVED')]), 'diag-mud'), 'partially-resolved');
  assert.equal(diagnosticStatusForFinding(report([state('UNRESOLVED')]), 'diag-mud'), 'not-fixed');
  assert.equal(diagnosticStatusForFinding(report([state('UNVERIFIED', false)]), 'diag-mud'), 'unverified');
});

test('only a reliable RESOLVED finding receives fixed status', () => {
  assert.equal(diagnosticStatusForFinding(report([], [state('RESOLVED', true)]), 'diag-mud'), 'fixed');
  assert.equal(diagnosticStatusForFinding(report([], [state('RESOLVED', false)]), 'diag-mud'), 'unverified');
});

test('summarizeAiFallbackBanner reports all fallback causes and stays silent when cloud AI succeeded', () => {
  assert.equal(summarizeAiFallbackBanner([]), null);
  assert.equal(
    summarizeAiFallbackBanner([
      {
        pass: 0,
        stage: 'strategy',
        source: 'gemini-cloud',
        fallbackReason: null,
        modelName: 'gemini-4-hydrogen',
        responseTimeMs: 1240,
        promptChars: 8420,
        timeoutHit: null,
        aiReturnedModules: ['parametric-eq', 'limiter'],
        finalRenderedModules: ['parametric-eq', 'limiter'],
      },
    ]),
    null,
  );

  const allReasons: AiFallbackReason[] = [
    '429',
    'guest-session',
    'timeout',
    'missing-key',
    'server-error',
    'parse',
    'validation',
    'user-disabled',
  ];
  for (const reason of allReasons) {
    const banner = summarizeAiFallbackBanner([
      {
        pass: 0,
        stage: 'strategy',
        source: 'local-dsp-planner',
        fallbackReason: reason,
        modelName: 'gemini-4-hydrogen',
        responseTimeMs: 42,
        promptChars: 4000,
        timeoutHit: reason === 'timeout' ? 'client' : null,
        timeoutMs: reason === 'timeout' ? 70_000 : null,
        aiReturnedModules: [],
        finalRenderedModules: ['parametric-eq'],
      },
    ]);
    assert.ok(banner && banner.startsWith('Cloud AI was not used for this pass because: '), `missing banner prefix for ${reason}`);
  }
});

test('diagnostic log JSON/text downloads, DiagnosticLogPanel, and MasterConsole expose AI provenance and fallback banner', () => {
  const sampleRate = 48_000;
  const left = new Float32Array(sampleRate);
  const right = new Float32Array(sampleRate);
  for (let i = 0; i < sampleRate; i++) {
    left[i] = right[i] = 0.12 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  const analysis = analyzeAudioBuffer([left, right], sampleRate);
  const aiPasses: AiPassTrace[] = [
    {
      pass: 0,
      stage: 'strategy',
      source: 'gemini-cloud',
      fallbackReason: null,
      modelName: 'gemini-4-hydrogen',
      responseTimeMs: 1842,
      promptChars: 9125,
      timeoutHit: null,
      aiReturnedModules: ['parametric-eq', 'compressor'],
      finalRenderedModules: ['parametric-eq', 'compressor', 'limiter'],
    },
    {
      pass: 1,
      stage: 'refine',
      source: 'deterministic-director',
      fallbackReason: 'timeout',
      fallbackDetail: 'upstream-timeout, server limit 60000 ms',
      modelName: 'gemini-4-hydrogen',
      responseTimeMs: 60014,
      promptChars: 7340,
      timeoutHit: 'server',
      timeoutMs: 60_000,
      aiReturnedModules: [],
      finalRenderedModules: ['parametric-eq', 'compressor', 'maximizer'],
    },
  ];
  const rep = {
    postAnalysis: analysis,
    finalChain: [],
    targetGate: { passed: true, checks: [], failed: [], summary: 'Synthetic gate pass.' },
    aiPasses,
  } as unknown as MasterFinalReport;

  const log = buildDiagnosticLog({
    trackName: 'test_track.wav',
    objective: resolveObjectiveTarget('streaming'),
    source: analysis,
    findings: [],
    chain: [],
    report: rep,
  });

  assert.equal(log.aiPasses.length, 2);
  assert.ok(log.aiFallbackBanner?.startsWith('Cloud AI was not used for this pass because: '));

  // JSON download includes full provenance & banner
  const parsedJson = JSON.parse(JSON.stringify(log)) as typeof log;
  assert.equal(parsedJson.aiPasses[0]?.responseTimeMs, 1842);
  assert.equal(parsedJson.aiPasses[0]?.promptChars, 9125);
  assert.deepEqual(parsedJson.aiPasses[0]?.aiReturnedModules, ['parametric-eq', 'compressor']);
  assert.deepEqual(parsedJson.aiPasses[0]?.finalRenderedModules, ['parametric-eq', 'compressor', 'limiter']);
  assert.equal(parsedJson.aiPasses[1]?.timeoutHit, 'server');
  assert.equal(parsedJson.aiPasses[1]?.timeoutMs, 60_000);
  assert.equal(parsedJson.aiPasses[1]?.fallbackDetail, 'upstream-timeout, server limit 60000 ms');
  assert.equal(parsedJson.aiPasses[1]?.fallbackReason, 'timeout');
  assert.ok(parsedJson.aiFallbackBanner?.includes('Cloud AI was not used for this pass because:'));

  // Text download includes provenance section, response time, prompt chars, timeout, and module diff
  const text = diagnosticLogToText(log);
  assert.match(text, /== AI & Fallback Provenance ==/);
  assert.match(text, /Cloud AI was not used for this pass because:/);
  assert.match(text, /source=gemini-cloud/);
  assert.match(text, /model=gemini-4-hydrogen/);
  assert.match(text, /responseTime=1842 ms/);
  assert.match(text, /prompt=9125 chars/);
  assert.match(text, /timeoutHit=server \(60000 ms\)/);
  assert.match(text, /fallback=timeout \(upstream-timeout, server limit 60000 ms\)/);
  assert.match(log.aiFallbackBanner ?? '', /upstream-timeout/);
  assert.match(text, /AI returned:\s+\[parametric-eq, compressor\]/);
  assert.match(text, /Final rendered:\s+\[parametric-eq, compressor, limiter\]/);

  // DiagnosticLogPanel shows banner and response times
  const panelHtml = renderToStaticMarkup(React.createElement(DiagnosticLogPanel, { log }));
  assert.match(panelHtml, /data-testid="diagnostic-ai-fallback-banner"/);
  assert.match(panelHtml, /Cloud AI was not used for this pass because:/);
  assert.match(panelHtml, /data-testid="diagnostic-ai-timing-summary"/);
  assert.match(panelHtml, /1842 ms/);
  assert.match(panelHtml, /60014 ms/);
  assert.match(panelHtml, /server timeout 60000 ms/);
  assert.match(panelHtml, /upstream-timeout, server limit 60000 ms/);

  // MasterConsole shows banner when fallback occurred and hides it when null
  const noop = () => {};
  const consoleWithBanner = renderToStaticMarkup(
    React.createElement(MasterConsole, {
      chain: [],
      chainBypassed: false,
      onChangeChain: noop,
      sampleRate,
      source: analysis,
      master: analysis,
      referenceAnalysis: null,
      scopeChannels: null,
      waveformPeaks: [],
      fades: { inSec: 0, outSec: 0, inCurve: 'linear', outCurve: 'linear' },
      onFadesChange: noop,
      durationSec: 1,
      hasTrack: true,
      running: false,
      stage: 'Complete',
      pass: 1,
      maxPasses: 4,
      report: rep,
      onFix: noop,
      onStop: noop,
      onDemo: noop,
      onImport: noop,
      targetPresetId: 'streaming',
      targetLabel: 'Streaming',
      targetLufs: -14,
      maxTruePeakDb: -1,
      onTargetPreset: noop,
      presets: [],
      onApplyPreset: noop,
      onOpenRack: noop,
      onOpenStereoLab: noop,
      aiFallbackBanner: log.aiFallbackBanner,
      isPlaying: false,
      onTogglePlay: noop,
    }),
  );
  assert.match(consoleWithBanner, /data-testid="console-ai-fallback-banner"/);
  assert.match(consoleWithBanner, /Cloud AI was not used for this pass because:/);

  const consoleWithoutBanner = renderToStaticMarkup(
    React.createElement(MasterConsole, {
      chain: [],
      chainBypassed: false,
      onChangeChain: noop,
      sampleRate,
      source: analysis,
      master: analysis,
      referenceAnalysis: null,
      scopeChannels: null,
      waveformPeaks: [],
      fades: { inSec: 0, outSec: 0, inCurve: 'linear', outCurve: 'linear' },
      onFadesChange: noop,
      durationSec: 1,
      hasTrack: true,
      running: false,
      stage: 'Complete',
      pass: 1,
      maxPasses: 4,
      report: rep,
      onFix: noop,
      onStop: noop,
      onDemo: noop,
      onImport: noop,
      targetPresetId: 'streaming',
      targetLabel: 'Streaming',
      targetLufs: -14,
      maxTruePeakDb: -1,
      onTargetPreset: noop,
      presets: [],
      onApplyPreset: noop,
      onOpenRack: noop,
      onOpenStereoLab: noop,
      aiFallbackBanner: null,
      isPlaying: false,
      onTogglePlay: noop,
    }),
  );
  assert.doesNotMatch(consoleWithoutBanner, /data-testid="console-ai-fallback-banner"/);
});
