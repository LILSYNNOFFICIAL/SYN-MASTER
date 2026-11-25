import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_SPEND_DEFAULTS, createAiSpendLimiter, readAiSpendLimitsFromEnv } from './aiSpendLimiter.mjs';
import { createRateLimiter } from './requestLimiter.mjs';

test('peek reports the next decision without spending budget', () => {
  let now = 0;
  const allow = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
  assert.equal(allow.peek('a').allowed, true);
  assert.equal(allow.peek('a').allowed, true);
  assert.equal(allow('a').allowed, true);
  assert.equal(allow.peek('a').allowed, false);
  now += 1000;
  assert.equal(allow.peek('a').allowed, true);
});

test('strategy calls are limited per client per minute and reset after the window', () => {
  let now = 0;
  const limiter = createAiSpendLimiter({ now: () => now, limits: { strategyPerMinute: 2 } });
  assert.equal(limiter.consume('1.1.1.1', 'strategy').allowed, true);
  assert.equal(limiter.consume('1.1.1.1', 'strategy').allowed, true);
  const blocked = limiter.consume('1.1.1.1', 'strategy');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, 'client-minute');
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60_000);
  assert.match(blocked.message, /local DSP planner/);
  // Another client and the refine route keep their own budgets.
  assert.equal(limiter.consume('2.2.2.2', 'strategy').allowed, true);
  assert.equal(limiter.consume('1.1.1.1', 'refine').allowed, true);
  now += 60_000;
  assert.equal(limiter.consume('1.1.1.1', 'strategy').allowed, true);
});

test('a rejected call does not spend any other limit', () => {
  let now = 0;
  const limiter = createAiSpendLimiter({ now: () => now, limits: { strategyPerMinute: 1, globalPerDay: 3 } });
  assert.equal(limiter.consume('a', 'strategy').allowed, true);
  for (let i = 0; i < 5; i++) assert.equal(limiter.consume('a', 'strategy').scope, 'client-minute');
  // Global budget still has 2 left despite the five rejected calls.
  assert.equal(limiter.consume('b', 'strategy').allowed, true);
  assert.equal(limiter.consume('c', 'strategy').allowed, true);
  assert.equal(limiter.consume('d', 'strategy').scope, 'global-day');
});

test('daily caps apply per client and globally across minutes', () => {
  let now = 0;
  const limiter = createAiSpendLimiter({ now: () => now, limits: { strategyPerDay: 2, clientPerDay: 3, globalPerDay: 100 } });
  assert.equal(limiter.consume('a', 'strategy').allowed, true);
  now += 61_000;
  assert.equal(limiter.consume('a', 'strategy').allowed, true);
  now += 61_000;
  const strategyDay = limiter.consume('a', 'strategy');
  assert.equal(strategyDay.allowed, false);
  assert.equal(strategyDay.scope, 'client-day');
  assert.equal(limiter.consume('a', 'refine').allowed, true); // third spending call of the day
  const clientDay = limiter.consume('a', 'refine');
  assert.equal(clientDay.scope, 'client-day');
  now += 24 * 60 * 60 * 1000;
  assert.equal(limiter.consume('a', 'strategy').allowed, true);
});

test('limits are env-overridable and ignore invalid values', () => {
  const limits = readAiSpendLimitsFromEnv({
    SYN_AI_STRATEGY_PER_MINUTE: '5',
    SYN_AI_GLOBAL_PER_DAY: '0',
    SYN_AI_CLIENT_PER_DAY: 'abc',
    SYN_AI_REFINE_PER_MINUTE: '2.5',
    SYN_AI_STRATEGY_PER_DAY: ' 9 ',
  });
  assert.equal(limits.strategyPerMinute, 5);
  assert.equal(limits.globalPerDay, AI_SPEND_DEFAULTS.globalPerDay);
  assert.equal(limits.clientPerDay, AI_SPEND_DEFAULTS.clientPerDay);
  assert.equal(limits.refinePerMinute, AI_SPEND_DEFAULTS.refinePerMinute);
  assert.equal(limits.strategyPerDay, 9);
  assert.deepEqual(readAiSpendLimitsFromEnv({}), { ...AI_SPEND_DEFAULTS });
});
