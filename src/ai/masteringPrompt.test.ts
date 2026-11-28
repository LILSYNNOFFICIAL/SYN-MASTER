import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRefineUserPrompt, buildStrategyUserPrompt, formatModeLine, MODE_MEANINGS, PROCESSOR_JSON_SCHEMA, SYSTEM_PROMPT } from './masteringPrompt.ts';
import type { AudioAnalysis, MasteringMode } from '../types/mastering.ts';
import { VERIFIED_NATIVE_PROCESSOR_INVENTORY } from '../director/processorInventory.ts';
import { PROCESSOR_PARAM_LIMITS } from '../dsp/chainValidation.ts';

// Minimal analysis stub: summarizeAnalysisForPrompt only reads numeric fields; missing ones print as undefined.
const analysis = new Proxy({}, { get: (_t, k) => (k === 'zoneEnergyDb' ? {} : k === 'spectrumBinsFreq' || k === 'spectrumBinsDb' ? [] : 0) }) as unknown as AudioAnalysis;

test('strategy prompt always carries the selected Mode as its own line, alongside the Objective', () => {
  const p = buildStrategyUserPrompt({ analysis, mode: 'analog', objective: 'streaming' });
  assert.match(p, /Mastering Objective: STREAMING/);
  assert.ok(p.includes(`Mode: analog — ${MODE_MEANINGS.analog}`), 'mode line present even when an Objective is set');
});

test('Objective still falls back to Mode when no Objective is given; Mode line is still added', () => {
  const p = buildStrategyUserPrompt({ analysis, mode: 'dynamic' });
  assert.match(p, /Mastering Objective: DYNAMIC/);
  assert.ok(p.includes(formatModeLine('dynamic')));
});

test('every MasteringMode has a meaning', () => {
  const modes: MasteringMode[] = ['ai-auto', 'manual', 'hybrid', 'transparent', 'loudness', 'analog', 'dynamic', 'reference', 'streaming', 'custom'];
  for (const m of modes) assert.ok(MODE_MEANINGS[m] && MODE_MEANINGS[m].length > 8, m);
});

test('strategy and refinement prompts expose every supported processor and require track-specific retuning', () => {
  const schemaDescription = PROCESSOR_JSON_SCHEMA.properties.type.description;
  const refinePrompt = buildRefineUserPrompt({
    preAnalysis: analysis,
    postAnalysis: analysis,
    currentChain: [],
    targetLufs: -14,
    targetTruePeakDb: -1,
    preserveDynamics: true,
  });
  for (const type of Object.keys(VERIFIED_NATIVE_PROCESSOR_INVENTORY)) {
    assert.ok(schemaDescription.includes(type), `schema lists ${type}`);
    assert.ok(SYSTEM_PROMPT.includes(`"${type}"`), `system prompt lists ${type}`);
  }
  assert.match(SYSTEM_PROMPT, /never repeat unchanged settings when the same measured failure persists/i);
  assert.match(refinePrompt, /retune it when its target remains unmet/i);
  assert.match(refinePrompt, /consider each and enable only those this track's evidence justifies/i);
});

test('E3: prompt asks the AI to consider every tool, justify each, set precise values and explain unused tools', () => {
  const strategyPrompt = buildStrategyUserPrompt({ analysis, mode: 'ai-auto', objective: 'pop' });
  for (const text of [SYSTEM_PROMPT, strategyPrompt]) {
    assert.ok(!/use ONLY needed processors/i.test(text), 'old "use ONLY needed processors" wording removed');
    assert.ok(!/surgical/i.test(text), 'old "surgical" wording removed');
  }
  assert.match(SYSTEM_PROMPT, /Consider every available processor, but enable a tool only when measurements or musical goals justify it/);
  assert.match(SYSTEM_PROMPT, /Set precise parameter values, not just on\/off/);
  assert.match(SYSTEM_PROMPT, /short rationale/);
  assert.match(SYSTEM_PROMPT, /in strategySummary name any available tool deliberately left unused and why/);
  assert.match(SYSTEM_PROMPT, /The chain will be rendered and re-measured, so keep values conservative where measurement shows no problem/);
  assert.match(strategyPrompt, /rationale states its supporting telemetry and tradeoffs/);
  assert.match(SYSTEM_PROMPT, /"restore" first \(after any "vocal-rebalance"\)/, 'restore-first rule agrees with vocal-rebalance always first');
});

test('refinement receives the reference and the latest unresolved findings', () => {
  const prompt = buildRefineUserPrompt({
    preAnalysis: analysis,
    postAnalysis: analysis,
    currentChain: [],
    referenceAnalysis: analysis,
    remainingFindings: [{
      findingId: 'diag-resonance',
      title: 'Unresolved upper-mid resonance',
      status: 'ACTIVE',
      detail: 'The 6.2 kHz resonance remains 5 dB above its limit after render.',
      recommendedAction: 'Retune the Dynamic EQ threshold or range and remeasure.',
      measurementReliable: true,
    }],
    targetLufs: -14,
    targetTruePeakDb: -1,
    preserveDynamics: true,
  });
  assert.match(prompt, /REFERENCE TRACK MEASUREMENTS/);
  assert.match(prompt, /Match EQ: AVAILABLE/);
  assert.match(prompt, /diag-resonance \[ACTIVE; reliable\]/);
  assert.match(prompt, /Retune the Dynamic EQ threshold or range and remeasure/);
});

test('AI is told when Vocal-Focused correction was already verified or was not applied', () => {
  const verified = buildStrategyUserPrompt({
    analysis,
    mode: 'ai-auto',
    objective: 'vocal-focused',
    vocalBalanceVerification: {
      status: 'verified',
      sourceBalanceDb: -5,
      referenceBalanceDb: 0,
      postRenderBalanceDb: -2,
      appliedGainDb: 3,
      summary: 'The rendered vocal balance moved toward the reference.',
    },
  });
  assert.match(verified, /VOCAL-FOCUSED PRE-CHAIN VERIFICATION/);
  assert.match(verified, /Status: verified/);
  assert.match(verified, /do not duplicate the correction/);

  const unverified = buildRefineUserPrompt({
    preAnalysis: analysis,
    postAnalysis: analysis,
    currentChain: [],
    vocalBalanceVerification: {
      status: 'unverified',
      sourceBalanceDb: -5,
      referenceBalanceDb: null,
      postRenderBalanceDb: null,
      appliedGainDb: 0,
      summary: 'Reference stems were unavailable.',
    },
    targetLufs: -14,
    targetTruePeakDb: -1,
    preserveDynamics: true,
  });
  assert.match(unverified, /This preparation was not verified/);
  assert.match(unverified, /do not claim it fixed vocal balance/);
});

test('strategy and refine prompts include clickCount with timestamps, shimmer, stereoBandCorrelation, and momentaryLufsMax', () => {
  const richAnalysis = {
    durationSec: 120,
    sampleRate: 48000,
    channels: 2,
    integratedLufs: -16.2,
    shortTermLufsMax: -11.5,
    momentaryLufsMax: -7.4,
    loudnessRangeLu: 6.1,
    rmsDb: -18.0,
    samplePeakDb: -1.2,
    truePeakDb: -1.0,
    dynamicRangeDb: 9.5,
    crestFactorDb: 11.2,
    plrDb: 15.2,
    transientDensity: 0.42,
    spectralCentroidHz: 1850,
    spectralSlopeDbPerOct: -3.2,
    zoneEnergyDb: { sub: -18, bass: -12, lowMid: -10, mid: -9, highMid: -11, presence: -15, air: -22 },
    spectrumBinsFreq: [],
    spectrumBinsDb: [],
    resonances: [],
    stereoWidth: 0.85,
    midSideRatioDb: 4.2,
    phaseCorrelation: 0.78,
    lowEndCorrelation: 0.94,
    stereoBandCorrelation: { low: 0.94, mid: 0.72, high: -0.35 },
    lrBalanceDb: 0.1,
    monoCompatibilityScore: 86,
    clippedSamples: 0,
    interSamplePeaks: 0,
    thdEstimatePercent: 0.4,
    noiseFloorDb: -68,
    dcOffset: 0,
    loudnessHistoryLufs: [],
    clickCount: 2,
    clickTimesSec: [1.25, 14.5],
    shimmer: {
      score: 0.81,
      confidence: 0.76,
      sideHfRatio: 0.62,
      fluxRatio: 0.88,
      tonality: 0.7,
      hfShareDb: -11.2,
    },
  } as unknown as AudioAnalysis;

  const strategyPrompt = buildStrategyUserPrompt({ analysis: richAnalysis, mode: 'streaming', objective: 'pop' });
  const refinePrompt = buildRefineUserPrompt({
    preAnalysis: richAnalysis,
    postAnalysis: richAnalysis,
    currentChain: [],
    mode: 'analog',
    objective: 'vocal-focused',
    targetLufs: -14,
    targetTruePeakDb: -1,
    preserveDynamics: true,
  });

  for (const prompt of [strategyPrompt, refinePrompt]) {
    assert.match(prompt, /Momentary Max: -7\.4/);
    assert.match(prompt, /Band Corr \(low\/mid\/high\): low=0\.94, mid=0\.72, high=-0\.35/);
    assert.match(prompt, /clickCount=2 \(timestamps: 1\.25s, 14\.50s\)/);
    assert.match(prompt, /shimmer: score=0\.81, confidence=0\.76/);
  }
  assert.match(refinePrompt, /Mastering Objective: VOCAL-FOCUSED/);
  assert.ok(refinePrompt.includes(`Mode: analog — ${MODE_MEANINGS.analog}`), 'refine prompt includes Mode line');
});

test('SYSTEM_PROMPT replaces hardcoded literals with types/enums, expands multiband-maximizer, and reflects PROCESSOR_PARAM_LIMITS ranges', () => {
  for (const forbidden of [
    '"truePeak":true',
    '"autoBlank":true',
    '"bypass":false',
    '"enabled":true',
    '"oversampling":2',
    '"oversampling":4',
    '{...same}',
  ]) {
    assert.ok(!SYSTEM_PROMPT.includes(forbidden), `SYSTEM_PROMPT must not contain hardcoded literal ${forbidden}`);
  }

  for (const requiredTypeOrEnum of [
    '"truePeak":boolean',
    '"autoBlank":boolean',
    '"bypass":boolean',
    '"enabled":boolean',
    '"oversampling":1|2|4',
  ]) {
    assert.ok(SYSTEM_PROMPT.includes(requiredTypeOrEnum), `SYSTEM_PROMPT must expose ${requiredTypeOrEnum}`);
  }

  const L = PROCESSOR_PARAM_LIMITS;
  const bandTuple = `${L.compressor.thresholdDb[0]}..${L.compressor.thresholdDb[1]}`;
  assert.ok(SYSTEM_PROMPT.includes(`"thresholdDb":${bandTuple}`));
  assert.ok(SYSTEM_PROMPT.includes(`"ceilingDb":${L.limiter.ceilingDb[0]}..${L.limiter.ceilingDb[1]}`));
  assert.ok(SYSTEM_PROMPT.includes(`"targetLufs":${L.maximizer.targetLufs[0]}..${L.maximizer.targetLufs[1]}`));
  assert.ok(SYSTEM_PROMPT.includes(`"lowWidth":${L['stereo-imager'].lowWidth[0]}..${L['stereo-imager'].lowWidth[1]}`));
  assert.ok(SYSTEM_PROMPT.includes(`"deEssFreqHz":${L.restore.deEssFreqHz[0]}..${L.restore.deEssFreqHz[1]}`));
  assert.ok(SYSTEM_PROMPT.includes(`"subFreqHz":${L['bass-enhancer'].subFreqHz[0]}..${L['bass-enhancer'].subFreqHz[1]}`));

  const mbMaxLine = SYSTEM_PROMPT.split('\n').find((line) => line.startsWith('13. "multiband-maximizer":'));
  assert.ok(mbMaxLine, 'multiband-maximizer schema line exists');
  const mbBandSchema = `"preGainDb":${L['multiband-maximizer'].band.preGainDb[0]}..${L['multiband-maximizer'].band.preGainDb[1]}`;
  assert.ok(mbMaxLine.includes(`"low":{${mbBandSchema}`), 'multiband-maximizer expands low band fields');
  assert.ok(mbMaxLine.includes(`"mid":{${mbBandSchema}`), 'multiband-maximizer expands mid band fields');
  assert.ok(mbMaxLine.includes(`"high":{${mbBandSchema}`), 'multiband-maximizer expands high band fields');
});



test('album reference profile and Match EQ availability are described independently', () => {
  const text = buildStrategyUserPrompt({
    analysis,
    mode: 'reference',
    referenceAnalysis: analysis,
    referenceLabel: 'ALBUM REFERENCE PROFILE (4-track robust median)',
    matchEqAvailable: false,
    albumContext: 'ALBUM REFERENCE PROFILE: median target -13 LUFS across 4 songs; keep track-specific contrast.',
  });
  assert.match(text, /ALBUM REFERENCE PROFILE \(4-track robust median\)/);
  assert.match(text, /Match EQ: NOT AVAILABLE/);
  assert.match(text, /keep track-specific contrast/);
});
