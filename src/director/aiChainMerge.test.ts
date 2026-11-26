import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer } from '../dsp/analyzer';
import { createProcessorModule } from '../dsp/chainValidation';
import { mergeAiChainWithRequiredModules, runAutonomousDirectorLoop } from './directorEngine';
import type { ProcessorModule } from '../types/mastering';

test('AI chain keeps its selected tools and prepends required local vocal modules', () => {
  const ai = [
    createProcessorModule('parametric-eq'),
    createProcessorModule('compressor'),
    createProcessorModule('limiter'),
  ];
  const localVocal = [createProcessorModule('vocal-rebalance')];
  const merged = mergeAiChainWithRequiredModules(ai, localVocal);
  const types = merged.map((module) => module.type);
  assert.equal(types.filter((type) => type === 'vocal-rebalance').length, 1);
  assert.equal(types.includes('dynamic-eq'), false);
  assert.equal(types.includes('match-eq'), false);
  assert.ok(types.indexOf('vocal-rebalance') < types.indexOf('parametric-eq'));
  assert.ok(types.indexOf('compressor') < types.indexOf('limiter'));
});

test('AI Dynamic EQ and Match EQ settings are retained unchanged', () => {
  const aiDynamic = createProcessorModule('dynamic-eq', {
    intensity: 40,
    params: {
      bands: [{ id: 'ai-harshness', enabled: true, freq: 4800, q: 2.4, thresholdDb: -28, maxCutDb: -4.5, ratio: 4, mode: 'cut', attackMs: 4, releaseMs: 90 }],
    },
  });
  const aiMatch = createProcessorModule('match-eq', {
    params: { amount: 48, smoothing: 6, maxBoostDb: 2.5, maxCutDb: 2.5, lowHz: 35, highHz: 16000, channel: 'stereo', phase: 'linear' },
  });
  const merged = mergeAiChainWithRequiredModules(
    [aiDynamic, aiMatch, createProcessorModule('limiter')],
    [],
  );
  assert.equal(merged.filter((module) => module.type === 'dynamic-eq').length, 1);
  assert.equal(merged.filter((module) => module.type === 'match-eq').length, 1);
  const dynamic = merged.find((module) => module.type === 'dynamic-eq')!;
  assert.equal(dynamic.intensity, 40);
  assert.equal((dynamic.params as { bands: Array<{ id: string; freq: number; maxCutDb: number }> }).bands[0].id, 'ai-harshness');
  assert.equal((dynamic.params as { bands: Array<{ id: string; freq: number; maxCutDb: number }> }).bands[0].freq, 4800);
  const match = merged.find((module) => module.type === 'match-eq')!;
  assert.equal((match.params as { amount: number }).amount, 48);
});

test('AI may omit Dynamic EQ and Match EQ when it chooses not to use them', () => {
  const merged = mergeAiChainWithRequiredModules(
    [createProcessorModule('parametric-eq'), createProcessorModule('limiter')],
    [],
  );
  assert.equal(merged.some((module) => module.type === 'dynamic-eq'), false);
  assert.equal(merged.some((module) => module.type === 'match-eq'), false);
});

test('required modules never truncate the safety limiter from a full AI chain', () => {
  const ai = [
    'parametric-eq', 'compressor', 'saturation', 'stereo-imager',
    'bass-enhancer', 'transient-shaper', 'restore', 'clipper',
    'multiband-comp', 'multiband-maximizer', 'saturation', 'limiter',
  ].map((type) => createProcessorModule(type as Parameters<typeof createProcessorModule>[0]));
  const merged = mergeAiChainWithRequiredModules(
    ai,
    [],
  );
  assert.ok(merged.length <= 12);
  assert.ok(merged.some((module) => module.type === 'limiter'));
});

test('AI refinement retunes Dynamic EQ and the next rendered pass uses its settings', async () => {
  const sampleRate = 44_100;
  const left = new Float32Array(sampleRate);
  const right = new Float32Array(sampleRate);
  for (let sampleIndex = 0; sampleIndex < sampleRate; sampleIndex++) {
    const sample = 0.025 * Math.sin((2 * Math.PI * 440 * sampleIndex) / sampleRate);
    left[sampleIndex] = sample;
    right[sampleIndex] = sample;
  }
  const source = [left, right];
  const aiDynamic = createProcessorModule('dynamic-eq', {
    params: {
      bands: [{ id: 'ai-retuned', enabled: true, freq: 6200, q: 2, thresholdDb: -32, maxCutDb: -2.25, ratio: 3, mode: 'cut', attackMs: 3, releaseMs: 75 }],
    },
  });
  const renderedChains: ProcessorModule[][] = [];

  await runAutonomousDirectorLoop({
    sourceChannels: source,
    sampleRate,
    operatingMode: 'autonomous',
    objectiveId: 'streaming',
    initialChain: [createProcessorModule('limiter')],
    maxIterations: 2,
    maxCpuBudgetMs: 10_000,
    aiRefineCallback: async () => [aiDynamic, createProcessorModule('limiter')],
    renderPassFn: async (channels, rate, chain) => {
      renderedChains.push(structuredClone(chain));
      return { channels, analysis: analyzeAudioBuffer(channels, rate) };
    },
  });

  assert.ok(renderedChains.length >= 2, 'AI refinement is rendered as a later pass');
  const refined = renderedChains[1].find((module) => module.type === 'dynamic-eq');
  assert.ok(refined, 'Dynamic EQ is present on the refined pass');
  assert.equal((refined.params as { bands: Array<{ id: string; freq: number; maxCutDb: number }> }).bands[0].id, 'ai-retuned');
  assert.equal((refined.params as { bands: Array<{ id: string; freq: number; maxCutDb: number }> }).bands[0].freq, 6200);
  assert.equal((refined.params as { bands: Array<{ id: string; freq: number; maxCutDb: number }> }).bands[0].maxCutDb, -2.25);
});
