import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer } from '../dsp/analyzer';
import { processChainOffline } from '../dsp/offlineDsp';
import { createProcessorModule } from '../dsp/chainValidation';
import { QC_TARGET_PROFILES } from '../dsp/qc';
import { requestRefine, requestStrategy } from '../ai/masteringClient';
import { formatModeLine, MODE_MEANINGS } from '../ai/masteringPrompt';
import type { ProviderConfig } from '../ai/providerAdapters';
import { generateGeminiMasterStrategy } from '../server/aiMastering';
import type { AIMasteringStrategy, MasteringMode, ProcessorModule } from '../types/mastering';
import { resolveObjectiveTarget, runAutonomousDirectorLoop } from './directorEngine';
import { evaluateMasterTargets } from './masterTargets';
import { summarizeAiFallbackBanner } from './diagnosticLog';
import { validateChainAgainstInventory } from './processorInventory';

// Fix All end to end with a mocked AI: the strategy request carries "Mode: <mode> — <meaning>"
// (BYO provider and the server's built-in Gemini call), the AI's chain only seeds the loop, and
// the verification loop renders, re-measures, asks the AI to refine, and gates on measured audio.

const SR = 44100;

function subDominantMix(seconds = 1.2): Float32Array[] {
  const n = Math.floor(SR * seconds);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const sub = 0.46 * Math.sin(2 * Math.PI * 40 * t);
    const bass = 0.045 * Math.sin(2 * Math.PI * 110 * t);
    const mid = 0.07 * Math.sin(2 * Math.PI * 1000 * t);
    left[i] = sub + bass + mid;
    right[i] = sub + bass + mid * 0.98;
  }
  return [left, right];
}

function quietMix(seconds = 1.2, gain = 0.05): Float32Array[] {
  const n = Math.floor(SR * seconds);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = 0.65 + 0.35 * Math.sin(2 * Math.PI * 2 * t);
    const body = 0.48 * Math.sin(2 * Math.PI * 65 * t) + 0.32 * Math.sin(2 * Math.PI * 220 * t) + 0.24 * Math.sin(2 * Math.PI * 880 * t) + 0.16 * Math.sin(2 * Math.PI * 2800 * t) + 0.08 * Math.sin(2 * Math.PI * 7400 * t);
    const side = 0.08 * Math.sin(2 * Math.PI * 950 * t + 0.4);
    L[i] = gain * env * (body + side);
    R[i] = gain * env * (body - side);
  }
  return [L, R];
}

// A deliberately weak first suggestion (a gentle EQ, no loudness stage), so pass 1 cannot meet
// the streaming loudness gate and the loop must re-measure, refine and render again.
const WEAK_STRATEGY = {
  genre: 'Electropop',
  musicalStyle: 'electronic',
  instrumentationSummary: 'synths, bass',
  vocalPresence: 'none',
  tonalCharacteristics: 'balanced',
  issuesDetected: ['low loudness'],
  strategySummary: 'light tonal touch only',
  targetLufs: -14,
  targetTruePeakDb: -1,
  processors: [
    {
      type: 'parametric-eq',
      name: 'Mock EQ',
      intensity: 100,
      wetDry: 100,
      reason: 'mocked AI suggestion',
      paramsJson: JSON.stringify({ bands: [{ id: 'b1', enabled: true, type: 'bell', freq: 3000, gainDb: 0.5, q: 1 }] }),
    },
  ],
};

const REFINE = {
  ...WEAK_STRATEGY,
  strategySummary: 'add a limiter',
  processors: [
    WEAK_STRATEGY.processors[0],
    {
      type: 'limiter',
      name: 'Mock Limiter',
      intensity: 100,
      wetDry: 100,
      reason: 'mocked refine: raise loudness under the ceiling',
      inputGainDb: 12,
      paramsJson: JSON.stringify({ ceilingDb: -1, thresholdDb: -3, releaseMs: 80, lookaheadMs: 5, truePeak: true, oversampling: 4 }),
    },
  ],
};

function openAiReply(body: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const provider: ProviderConfig = { presetId: 'openai-compatible', model: 'mock-model', baseUrl: 'https://mock-ai.invalid/v1', apiKey: 'sk-mock-0123456789', agentic: false, timeoutSec: 30 };

function userPromptOf(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> };
  return (body.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
}

test('BYO provider strategy request carries the "Mode: <mode> — <meaning>" line for every mode', async () => {
  const analysis = analyzeAudioBuffer(quietMix(), SR);
  for (const mode of Object.keys(MODE_MEANINGS) as MasteringMode[]) {
    const prompts: string[] = [];
    const run = await requestStrategy(
      provider,
      { analysis, mode, objective: 'streaming', operatingMode: 'autonomous', targetLufs: -14 },
      async () => { throw new Error('built-in must not be called when the provider succeeds'); },
      { fetchImpl: async (_u, init) => { prompts.push(userPromptOf(init)); return openAiReply(WEAK_STRATEGY); } },
    );
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes(`Mode: ${mode} — ${MODE_MEANINGS[mode]}`), `${mode}: mode line missing from request`);
    assert.ok(prompts[0].includes('Mastering Objective: STREAMING'), 'objective line still present');
    assert.equal(run.fellBack, false);
    assert.equal(run.result?.chain.length, 1);
  }
});

test('built-in Gemini (server) sends the Mode line to the model; mocked Gemini response is parsed', async () => {
  const analysis = analyzeAudioBuffer(quietMix(), SR);
  const realFetch = globalThis.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'mock-gemini-key-not-real';
  const sent: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    assert.match(u, /generativelanguage\.googleapis\.com/, 'only the Gemini endpoint may be called');
    sent.push(String(init?.body ?? (url instanceof Request ? await url.text() : '')));
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(WEAK_STRATEGY) }] }, finishReason: 'STOP' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const strategy = await generateGeminiMasterStrategy({ analysis, mode: 'analog', objective: 'streaming', operatingMode: 'autonomous', targetLufs: -14 });
    assert.equal(sent.length, 1, 'exactly one mocked Gemini call');
    assert.ok(sent[0].includes(formatModeLine('analog')), 'Gemini request contents must include the Mode line');
    assert.equal(strategy.chain[0]?.type, 'parametric-eq');
  } finally {
    globalThis.fetch = realFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Fix All with a mocked AI: AI only seeds the chain; the loop renders, re-measures, refines and gates on measured output', async () => {
  const src = quietMix();
  const analysis = analyzeAudioBuffer(src, SR);
  const prompts: string[] = [];
  const calls: string[] = [];
  const fetchImpl = async (_u: string, init?: RequestInit) => {
    const prompt = userPromptOf(init);
    prompts.push(prompt);
    const isRefine = prompt.includes('CURRENT PROCESSED PASS');
    calls.push(isRefine ? 'refine' : 'strategy');
    return openAiReply(isRefine ? REFINE : WEAK_STRATEGY);
  };

  // Same shape as App.handleRunMasterDirector's strategyInput.
  const strategyRun = await requestStrategy(provider, { analysis, mode: 'loudness', objective: 'streaming', operatingMode: 'autonomous', targetLufs: -14 }, async () => { throw new Error('no fallback expected'); }, { fetchImpl });
  assert.ok(prompts[0].includes(`Mode: loudness — ${MODE_MEANINGS.loudness}`));
  const strat = strategyRun.result as unknown as AIMasteringStrategy;
  const inv = validateChainAgainstInventory(strat.chain);
  assert.ok(inv.valid && inv.sanitizedChain.length > 0, 'mocked AI chain passes inventory validation');

  const refineContexts: Array<{ currentChain: ProcessorModule[] }> = [];
  const lifecycles: string[] = [];
  const report = await runAutonomousDirectorLoop({
    sourceChannels: src,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    mode: 'loudness',
    initialChain: inv.sanitizedChain,
    maxIterations: 4,
    maxCpuBudgetMs: 60_000,
    onProgress: (u) => { if (u.lifecycle) lifecycles.push(u.lifecycle); },
    aiRefineCallback: async (ctx) => {
      refineContexts.push(ctx);
      const run = await requestRefine(provider, ctx, async () => { throw new Error('no fallback expected'); }, { fetchImpl });
      return { chain: run.result?.chain ?? null, producedBy: run.producedBy ?? undefined, notices: run.notices };
    },
  });

  // The loop ran more than one measured pass and asked the AI to refine from measurements.
  assert.ok(report.iterationsExecuted >= 2, `expected >= 2 passes, got ${report.iterationsExecuted}: ${report.stopReason}`);
  assert.ok(refineContexts.length >= 1, 'verification loop must request an AI refinement after a failing pass');
  assert.deepEqual(calls.slice(0, 2), ['strategy', 'refine']);
  assert.ok(prompts[1]?.includes('Mastering Objective: STREAMING'), 'AI refinement prompt includes the Mastering Objective name');
  assert.ok(prompts[1]?.includes(`Mode: loudness — ${MODE_MEANINGS.loudness}`), 'AI refinement prompt includes the Mode line');
  assert.ok(prompts.some((prompt) => prompt.includes('OBJECTIVE GATE: FAIL')), 'AI refinement prompt includes the measured failed objective gate');
  assert.ok(lifecycles.includes('Validating'), 'loop reports a Validating stage');

  // Pass 1 (the weak AI chain) was re-measured and failed the objective gate.
  const pass1 = report.checkpoints.find((c) => c.passNumber === 1);
  assert.ok(pass1?.targetGate, 'pass 1 carries a measured objective gate');
  assert.equal(pass1.targetGate.passed, false, 'the weak mocked AI chain must not pass the gate');

  // Every rendered pass carries its own measured gate.
  for (const cp of report.checkpoints.filter((c) => c.passNumber > 0)) assert.ok(cp.targetGate, `pass ${cp.passNumber} gate measured`);

  // The delivered verdict is the re-measured render of the retained chain, not the AI's word.
  assert.ok(report.targetGate, 'final report carries the objective gate');
  const rerender = processChainOffline(src, SR, report.finalChain, null);
  const remeasured = analyzeAudioBuffer(rerender.channels, SR);
  assert.ok(Math.abs(remeasured.integratedLufs - report.postAnalysis.integratedLufs) < 0.05, 'report post-analysis = independent re-measurement of the final chain');
  const independentGate = evaluateMasterTargets(remeasured, report.objective, { preAnalysis: report.preAnalysis });
  assert.equal(report.targetGate.passed, independentGate.passed, 'final gate verdict reproduces from the rendered audio');
  if (report.targetGate.passed) {
    assert.ok(Math.abs(remeasured.integratedLufs - report.objective.targetLufs) <= report.objective.lufsTolerance + 1e-9);
    assert.ok(remeasured.truePeakDb <= report.objective.maxTruePeakDb + 0.1);
  }
});


test('sub-bass objective gate uses the same genre-aware tolerance as Director diagnosis', () => {
  const measured = analyzeAudioBuffer(quietMix(), SR);
  const source = {
    ...measured,
    zoneEnergyDb: { ...measured.zoneEnergyDb, sub: measured.zoneEnergyDb.bass + 6 },
  };
  const makePost = (excessDb: number) => ({
    ...measured,
    zoneEnergyDb: { ...measured.zoneEnergyDb, sub: measured.zoneEnergyDb.bass + excessDb },
  });

  const streamingGate = evaluateMasterTargets(makePost(5), resolveObjectiveTarget('streaming'), { preAnalysis: source });
  const streamingCheck = streamingGate.checks.find((check) => check.id === 'sub-excess');
  assert.equal(streamingCheck?.status, 'fail', '5 dB exceeds the streaming +4.5 dB limit');
  assert.match(streamingCheck?.target ?? '', /4\.5/);

  const streamingWithinLimit = evaluateMasterTargets(makePost(4.4), resolveObjectiveTarget('streaming'), { preAnalysis: source });
  assert.equal(streamingWithinLimit.checks.find((check) => check.id === 'sub-excess')?.status, 'pass');

  const hipHopWithinLimit = evaluateMasterTargets(makePost(5.4), resolveObjectiveTarget('hip-hop'), { preAnalysis: source });
  assert.equal(hipHopWithinLimit.checks.find((check) => check.id === 'sub-excess')?.status, 'pass');
});

test('Fix All applies deterministic gate repairs alongside a valid unchanged AI refinement', async () => {
  const src = subDominantMix();
  const sourceAnalysis = analyzeAudioBuffer(src, SR);
  assert.ok(sourceAnalysis.zoneEnergyDb.sub - sourceAnalysis.zoneEnergyDb.bass > 4.5, 'fixture must exceed streaming sub-bass tolerance');

  const initialEq = createProcessorModule('parametric-eq');
  const refinePasses: number[] = [];
  const failedGateIds: string[][] = [];
  const report = await runAutonomousDirectorLoop({
    sourceChannels: src,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    initialChain: [initialEq],
    maxIterations: 2,
    maxCpuBudgetMs: 60_000,
    aiRefineCallback: async (ctx) => {
      refinePasses.push(ctx.postAnalysis.zoneEnergyDb.sub - ctx.postAnalysis.zoneEnergyDb.bass);
      failedGateIds.push(ctx.targetGate.failed.map((check) => check.id));
      return { chain: ctx.currentChain, producedBy: 'mock AI (unchanged chain)' };
    },
  });

  assert.equal(refinePasses.length, 1, 'the failing first pass must request an AI refinement');
  assert.ok(failedGateIds[0]?.includes('sub-excess'), 'AI refinement receives the actual failed sub-bass gate');
  const secondPass = report.checkpoints.find((checkpoint) => checkpoint.passNumber === 2);
  assert.ok(secondPass, 'the combined AI + deterministic candidate must be rendered on pass 2');
  const eq = secondPass.chain.find((module) => module.type === 'parametric-eq');
  const bands = (eq?.params as { bands?: Array<{ id?: string; freq?: number; gain?: number }> } | undefined)?.bands ?? [];
  assert.ok(
    bands.some((band) => band.id === 'syn-sub-excess' && (band.freq ?? 0) >= 20 && (band.freq ?? 0) <= 60 && (band.gain ?? 0) < 0),
    'deterministic sub-bass gate repair must be merged into a valid AI refinement instead of being skipped',
  );
});


test('Fix All does not converge while blocking QC failures remain even if the objective gate passes', async () => {
  const src = Array.from({ length: Math.floor(SR * 1.2) }, (_, i) => {
    const t = i / SR;
    return 0.16 * Math.sin(2 * Math.PI * 110 * t) +
      0.12 * Math.sin(2 * Math.PI * 1000 * t) +
      0.06 * Math.sin(2 * Math.PI * 3200 * t);
  });
  const channels = [Float32Array.from(src), Float32Array.from(src)];
  const sourceAnalysis = analyzeAudioBuffer(channels, SR);
  const passingPost = {
    ...sourceAnalysis,
    clippedSamples: 0,
    clickCount: 0,
    clicksPerMinute: 0,
    clickAtStart: false,
    clickAtEnd: false,
    dcOffset: 0,
    phaseCorrelation: 1,
    lowEndCorrelation: 1,
    lrBalanceDb: 0,
    zoneEnergyDb: { ...sourceAnalysis.zoneEnergyDb, sub: sourceAnalysis.zoneEnergyDb.bass - 1 },
  };
  let refineCalls = 0;
  const report = await runAutonomousDirectorLoop({
    sourceChannels: channels,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'custom',
    customSpec: {
      targetLufs: passingPost.integratedLufs,
      maxTruePeakDb: -1,
      minDynamicRangeDb: 100,
    },
    qcProfile: { ...QC_TARGET_PROFILES[0], minDynamicRangeDb: 100 },
    initialChain: [createProcessorModule('parametric-eq')],
    maxIterations: 2,
    maxCpuBudgetMs: 60_000,
    renderPassFn: async (renderedChannels) => ({
      channels: renderedChannels,
      analysis: passingPost,
    }),
    aiRefineCallback: async (ctx) => {
      refineCalls++;
      return { chain: ctx.currentChain, producedBy: 'mock AI (no QC correction)' };
    },
  });

  const firstPass = report.checkpoints.find((checkpoint) => checkpoint.passNumber === 1);
  assert.equal(firstPass?.targetGate?.passed, true, `first rendered pass must meet every blocking objective target; failures: ${JSON.stringify(firstPass?.targetGate?.failed)}`);
  assert.ok((firstPass?.qcReport.failCount ?? 0) > 0, 'first rendered pass deliberately retains a blocking QC failure');
  assert.equal(refineCalls, 1, 'QC failures must prevent early convergence and trigger an AI refinement');
  assert.notEqual(report.status, 'converged', 'a master with blocking QC failures cannot be marked converged');
  assert.match(report.stopReason, /QC|not fully verified/i, 'the final reason must disclose the remaining QC failure');
});

test('Stop halts Fix All immediately during AI refinement without falling back or logging an error', async () => {
  const channels = quietMix();
  let stopped = false;
  let renders = 0;
  const report = await runAutonomousDirectorLoop({
    sourceChannels: channels,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    qcProfile: QC_TARGET_PROFILES[0],
    initialChain: [createProcessorModule('parametric-eq')],
    maxIterations: 4,
    maxCpuBudgetMs: 60_000,
    shouldStop: () => stopped,
    renderPassFn: async (renderedChannels) => {
      renders++;
      return { channels: renderedChannels, analysis: analyzeAudioBuffer(renderedChannels, SR) };
    },
    aiRefineCallback: async () => {
      stopped = true;
      throw new DOMException('Cancelled.', 'AbortError');
    },
  });

  assert.equal(renders, 1, 'stopping during pass 1 AI wait must not render a second pass');
  assert.equal(report.status, 'stopped-by-user');
  assert.equal(
    report.activityLog.some((entry) => /AI refinement skipped/i.test(entry.message)),
    false,
    'intentional Stop must not emit a fallback warning',
  );
});

test('Director records AI strategy and refine provenance including response time, prompt size, model, and module diff', async () => {
  const src = quietMix();
  const analysis = analyzeAudioBuffer(src, SR);
  const fetchImpl = async (_u: string, init?: RequestInit) => {
    const prompt = userPromptOf(init);
    return openAiReply(prompt.includes('CURRENT PROCESSED PASS') ? REFINE : WEAK_STRATEGY);
  };

  const stratRun = await requestStrategy(
    provider,
    { analysis, mode: 'transparent', objective: 'streaming', operatingMode: 'autonomous', targetLufs: -14 },
    async () => { throw new Error('no fallback expected'); },
    { fetchImpl },
  );
  const strat = stratRun.result as unknown as AIMasteringStrategy;
  const inv = validateChainAgainstInventory(strat.chain);
  assert.ok(inv.valid);

  const report = await runAutonomousDirectorLoop({
    sourceChannels: src,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    mode: 'transparent',
    initialChain: inv.sanitizedChain,
    initialAiTrace: {
      pass: 0,
      stage: 'strategy',
      source: stratRun.meta?.source ?? 'byo-provider',
      fallbackReason: null,
      modelName: stratRun.meta?.modelName ?? provider.model,
      responseTimeMs: stratRun.meta?.responseTimeMs ?? 0,
      promptChars: stratRun.meta?.promptChars ?? 0,
      timeoutHit: null,
      aiReturnedModules: stratRun.meta?.aiReturnedModules ?? strat.chain.map((m) => m.type),
      finalRenderedModules: inv.sanitizedChain.map((m) => m.type),
    },
    maxIterations: 2,
    maxCpuBudgetMs: 60_000,
    aiRefineCallback: async (ctx) => {
      const run = await requestRefine(provider, ctx, async () => { throw new Error('no fallback expected'); }, { fetchImpl });
      return {
        chain: run.result?.chain ?? null,
        producedBy: run.producedBy ?? undefined,
        notices: run.notices,
        trace: run.meta
          ? {
              source: run.meta.source,
              fallbackReason: null,
              modelName: run.meta.modelName,
              responseTimeMs: run.meta.responseTimeMs,
              promptChars: run.meta.promptChars,
              timeoutHit: null,
              aiReturnedModules: run.meta.aiReturnedModules,
            }
          : undefined,
      };
    },
  });

  const aiPasses = report.aiPasses ?? [];
  assert.ok(aiPasses.length >= 2, `expected strategy + refine trace, got ${aiPasses.length}`);
  assert.equal(aiPasses[0]?.stage, 'strategy');
  assert.equal(aiPasses[0]?.source, 'byo-provider');
  assert.equal(aiPasses[0]?.modelName, 'mock-model');
  assert.ok((aiPasses[0]?.promptChars ?? 0) > 500, 'strategy trace records promptChars');
  assert.equal(typeof aiPasses[0]?.responseTimeMs, 'number');
  assert.deepEqual(aiPasses[0]?.aiReturnedModules, ['parametric-eq']);
  assert.equal(aiPasses[1]?.stage, 'refine');
  assert.equal(aiPasses[1]?.source, 'byo-provider');
  assert.ok((aiPasses[1]?.promptChars ?? 0) > 500, 'refine trace records promptChars');
  assert.deepEqual(aiPasses[1]?.aiReturnedModules, ['parametric-eq', 'limiter']);
  assert.ok(aiPasses[1]?.finalRenderedModules.length > 0);
  assert.equal(summarizeAiFallbackBanner(aiPasses), null);
});

test('Director records deterministic-director fallback with exact reason when AI refine is skipped or fails', async () => {
  const src = subDominantMix();
  const report = await runAutonomousDirectorLoop({
    sourceChannels: src,
    sampleRate: SR,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    initialChain: [createProcessorModule('parametric-eq')],
    initialAiTrace: {
      pass: 0,
      stage: 'strategy',
      source: 'local-dsp-planner',
      fallbackReason: '429',
      fallbackDetail: 'rate limit test',
      modelName: 'gemini-4-hydrogen',
      responseTimeMs: 85,
      promptChars: 5000,
      timeoutHit: null,
      aiReturnedModules: [],
      finalRenderedModules: ['parametric-eq'],
    },
    maxIterations: 2,
    maxCpuBudgetMs: 60_000,
    aiRefineCallback: async () => ({
      chain: null,
      trace: {
        source: 'deterministic-director',
        fallbackReason: 'timeout',
        fallbackDetail: 'client timeout exceeded (70000 ms)',
        modelName: 'gemini-4-hydrogen',
        responseTimeMs: 70005,
        promptChars: 6100,
        timeoutHit: 'client',
        timeoutMs: 70_000,
        aiReturnedModules: [],
      },
    }),
  });

  const aiPasses = report.aiPasses ?? [];
  assert.equal(aiPasses[0]?.source, 'local-dsp-planner');
  assert.equal(aiPasses[0]?.fallbackReason, '429');
  assert.ok(aiPasses.some((p) => p.stage === 'refine' && p.source === 'deterministic-director' && p.fallbackReason === 'timeout' && p.timeoutHit === 'client' && p.timeoutMs === 70_000));
  const banner = summarizeAiFallbackBanner(aiPasses);
  assert.ok(banner && banner.includes('Cloud AI was not used for this pass because:'));
  assert.match(banner, /429/);
  assert.match(banner, /timed out/);
});
