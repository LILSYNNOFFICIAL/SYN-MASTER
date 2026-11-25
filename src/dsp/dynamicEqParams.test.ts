import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProcessorParams } from './chainValidation';
import type { DynamicEQParams } from '../types/mastering';

test('legacy Dynamic EQ params retain the original ratio and cut mode', () => {
  const validated = validateProcessorParams('dynamic-eq', {
    bands: [{ id: 'legacy', enabled: true, freq: 500, q: 2, thresholdDb: -20, maxCutDb: -3, attackMs: 10, releaseMs: 100 }],
  }) as DynamicEQParams;

  assert.equal(validated.bands[0].ratio, 20 / 7);
  assert.equal(validated.bands[0].mode, 'cut');
  assert.equal(validated.bands[0].maxCutDb, -3);
});

test('Dynamic EQ validation clamps ratio and range and rejects unknown modes', () => {
  const validated = validateProcessorParams('dynamic-eq', {
    bands: [{ id: 'invalid', enabled: true, freq: 500, q: 2, thresholdDb: -20, maxCutDb: 99, ratio: 200, mode: 'sideways', attackMs: 10, releaseMs: 100 }],
  }) as DynamicEQParams;

  assert.equal(validated.bands[0].ratio, 20);
  assert.equal(validated.bands[0].mode, 'cut');
  assert.equal(validated.bands[0].maxCutDb, 0);
});

test('Dynamic EQ validation preserves bounded boost settings', () => {
  const validated = validateProcessorParams('dynamic-eq', {
    bands: [{ id: 'boost', enabled: true, freq: 500, q: 2, thresholdDb: -20, maxCutDb: 99, ratio: 4, mode: 'boost', attackMs: 10, releaseMs: 100 }],
  }) as DynamicEQParams;

  assert.equal(validated.bands[0].mode, 'boost');
  assert.equal(validated.bands[0].maxCutDb, 12);
});
