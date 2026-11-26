import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessorModule } from '../dsp/chainValidation';
import { mergeAiChainWithMeasuredPlan } from './directorEngine';

test('AI seed chain retains measured Dynamic EQ and Match EQ corrections plus local vocal modules', () => {
  const ai = [
    createProcessorModule('parametric-eq'),
    createProcessorModule('compressor'),
    createProcessorModule('limiter'),
  ];
  const localVocal = [createProcessorModule('vocal-rebalance')];
  const measured = [
    createProcessorModule('dynamic-eq'),
    createProcessorModule('match-eq'),
  ];

  const merged = mergeAiChainWithMeasuredPlan(ai, localVocal, measured);
  const types = merged.map((module) => module.type);
  assert.equal(types.filter((type) => type === 'vocal-rebalance').length, 1);
  assert.equal(types.filter((type) => type === 'dynamic-eq').length, 1);
  assert.equal(types.filter((type) => type === 'match-eq').length, 1);
  assert.ok(types.indexOf('vocal-rebalance') < types.indexOf('parametric-eq'));
  assert.ok(types.indexOf('dynamic-eq') < types.indexOf('compressor'));
  assert.ok(types.indexOf('match-eq') < types.indexOf('compressor'));
  assert.ok(types.indexOf('compressor') < types.indexOf('limiter'));
});

test('an already configured AI Dynamic EQ is not duplicated', () => {
  const aiDynamic = createProcessorModule('dynamic-eq', { intensity: 40 });
  const measuredDynamic = createProcessorModule('dynamic-eq', { intensity: 85 });
  const merged = mergeAiChainWithMeasuredPlan(
    [aiDynamic, createProcessorModule('limiter')],
    [],
    [measuredDynamic, createProcessorModule('match-eq')],
  );
  assert.equal(merged.filter((module) => module.type === 'dynamic-eq').length, 1);
  assert.equal(merged.filter((module) => module.type === 'match-eq').length, 1);
  assert.equal(merged.find((module) => module.type === 'dynamic-eq')?.intensity, 85);
});

test('Match EQ is not invented when no measured reference plan exists', () => {
  const merged = mergeAiChainWithMeasuredPlan(
    [createProcessorModule('parametric-eq'), createProcessorModule('limiter')],
    [],
    [createProcessorModule('dynamic-eq')],
  );
  assert.equal(merged.some((module) => module.type === 'dynamic-eq'), true);
  assert.equal(merged.some((module) => module.type === 'match-eq'), false);
});

test('adding measured EQ never truncates the safety limiter from a full AI chain', () => {
  const ai = [
    'parametric-eq', 'compressor', 'saturation', 'stereo-imager',
    'bass-enhancer', 'transient-shaper', 'restore', 'clipper',
    'multiband-comp', 'multiband-maximizer', 'saturation', 'limiter',
  ].map((type) => createProcessorModule(type as Parameters<typeof createProcessorModule>[0]));
  const merged = mergeAiChainWithMeasuredPlan(
    ai,
    [],
    [createProcessorModule('dynamic-eq'), createProcessorModule('match-eq')],
  );
  assert.ok(merged.length <= 12);
  assert.ok(merged.some((module) => module.type === 'limiter'));
  assert.ok(merged.some((module) => module.type === 'dynamic-eq'));
  assert.ok(merged.some((module) => module.type === 'match-eq'));
});
