import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer } from '../dsp/analyzer';
import { processChainOffline } from '../dsp/offlineDsp';
import { requestRefine, requestStrategy } from '../ai/masteringClient';
import { formatModeLine, MODE_MEANINGS } from '../ai/masteringPrompt';
import type { ProviderConfig } from '../ai/providerAdapters';
import { generateGeminiMasterStrategy } from '../server/aiMastering';
import type { AIMasteringStrategy, MasteringMode, ProcessorModule } from '../types/mastering';
import { runAutonomousDirectorLoop } from './directorEngine';
import { evaluateMasterTargets } from './masterTargets';
import { validateChainAgainstInventory } from './processorInventory';

// Fix All end to end with a mocked AI: the strategy request carries "Mode: <mode> — <meaning>"
// (BYO provider and the server's built-in Gemini call), the AI's chain only seeds the loop, and
// the verification loop renders, re-measures, asks the AI to refine, and gates on measured audio.

const SR = 44100;

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
    const isRefine = !prompt.includes('Mode: ');
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
