import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from './requestLimiter.mjs';

test('allows requests up to the configured limit and rejects the next request', () => {
  let now = 1_000;
  const allow = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => now });

  assert.deepEqual(allow('client-a'), { allowed: true, remaining: 1, retryAfterMs: 0 });
  assert.deepEqual(allow('client-a'), { allowed: true, remaining: 0, retryAfterMs: 0 });
  assert.deepEqual(allow('client-a'), { allowed: false, remaining: 0, retryAfterMs: 60_000 });
});

test('isolates clients and resets an expired window', () => {
  let now = 1_000;
  const allow = createRateLimiter({ limit: 1, windowMs: 500, now: () => now });

  assert.equal(allow('client-a').allowed, true);
  assert.equal(allow('client-b').allowed, true);
  assert.equal(allow('client-a').allowed, false);
  now += 500;
  assert.equal(allow('client-a').allowed, true);
});

test('rejects invalid limiter configuration', () => {
  assert.throws(() => createRateLimiter({ limit: 0 }), /positive integer/);
  assert.throws(() => createRateLimiter({ windowMs: 0 }), /positive/);
});
