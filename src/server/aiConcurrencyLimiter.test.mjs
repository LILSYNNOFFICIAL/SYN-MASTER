import test from 'node:test';
import assert from 'node:assert/strict';
import { createConcurrencyLimiter } from './aiConcurrencyLimiter.mjs';

test('limits concurrent AI requests per guest session and globally', () => {
  const acquire = createConcurrencyLimiter({ maxTotal: 3, maxPerKey: 2 });
  const a1 = acquire('guest-a');
  const a2 = acquire('guest-a');
  assert.equal(a1.allowed, true);
  assert.equal(a2.allowed, true);
  assert.equal(acquire('guest-a').allowed, false, 'a guest cannot exceed its own concurrency cap');
  const b1 = acquire('guest-b');
  assert.equal(b1.allowed, true);
  assert.equal(acquire('guest-c').allowed, false, 'the process-wide concurrency cap is enforced');
  a1.release();
  assert.equal(acquire('guest-a').allowed, true, 'released capacity is reusable');
});

test('release is idempotent and missing identities cannot acquire capacity', () => {
  const acquire = createConcurrencyLimiter({ maxTotal: 1, maxPerKey: 1 });
  assert.equal(acquire('').allowed, false);
  const slot = acquire('guest');
  assert.equal(slot.allowed, true);
  slot.release();
  slot.release();
  assert.equal(acquire('other').allowed, true);
});

test('rejects invalid concurrency limits', () => {
  assert.throws(() => createConcurrencyLimiter({ maxTotal: 0 }), /maxTotal/);
  assert.throws(() => createConcurrencyLimiter({ maxPerKey: -1 }), /maxPerKey/);
});
