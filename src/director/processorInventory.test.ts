import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessorModule } from '../dsp/chainValidation.ts';
import {
  VERIFIED_NATIVE_PROCESSOR_INVENTORY,
  validateChainAgainstInventory,
  validateChainCommand,
} from './processorInventory.ts';

test('inventory exposes all native processor types with explicit metadata', () => {
  assert.equal(Object.keys(VERIFIED_NATIVE_PROCESSOR_INVENTORY).length, 14);
  for (const descriptor of Object.values(VERIFIED_NATIVE_PROCESSOR_INVENTORY)) {
    assert.ok(descriptor.displayName.length > 0);
    assert.ok(descriptor.maxRecommendedInstances >= 1);
    assert.equal(typeof descriptor.realtimeSupported, 'boolean');
    assert.ok(descriptor.offlineSupported);
  }
});

test('accepts and sanitizes a valid native processor chain', () => {
  const result = validateChainAgainstInventory([
    createProcessorModule('parametric-eq'),
    createProcessorModule('limiter'),
  ]);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.sanitizedChain.length, 2);
});

test('rejects unsupported own and inherited processor names', () => {
  for (const type of ['magic-maximizer', 'toString', 'constructor', '__proto__']) {
    const result = validateChainAgainstInventory([{ type, name: 'Invalid', params: {} }]);
    assert.equal(result.valid, false, type);
    assert.ok(result.errors.length > 0, type);
  }
});

test('rejects non-finite parameters and chains longer than twelve stages', () => {
  const nonFinite = validateChainAgainstInventory([{
    type: 'limiter',
    name: 'Limiter',
    intensity: 100,
    wetDry: 100,
    params: { ceilingDb: Number.NaN },
  }]);
  assert.equal(nonFinite.valid, false);
  assert.ok(nonFinite.errors.some((message) => message.includes('Non-finite numeric value')));

  const tooLong = validateChainAgainstInventory(
    Array.from({ length: 13 }, () => createProcessorModule('parametric-eq')),
  );
  assert.equal(tooLong.valid, false);
  assert.ok(tooLong.errors.some((message) => message.includes('exceeds 12-stage limit')));
});

test('rejects missing processor types and malformed structured commands', () => {
  const missingType = validateChainCommand({ op: 'add' } as never);
  assert.equal(missingType.valid, false);
  assert.ok(missingType.reason?.includes('requires an own processorType'));

  const malformedOrder = validateChainCommand({ op: 'reorder', order: 'limiter' } as never);
  assert.equal(malformedOrder.valid, false);

  const malformedPatch = validateChainCommand({
    op: 'configure',
    processorType: 'limiter',
    paramsPatch: [],
  } as never);
  assert.equal(malformedPatch.valid, false);
});

test('rejects malformed chains and invalid AI commands', () => {
  assert.equal(validateChainAgainstInventory('not-an-array').valid, false);
  assert.equal(validateChainAgainstInventory([]).valid, false);

  const badCommand = validateChainCommand({
    op: 'add',
    processorType: 'toString',
  } as never);
  assert.equal(badCommand.valid, false);
  assert.ok(badCommand.reason);
});
