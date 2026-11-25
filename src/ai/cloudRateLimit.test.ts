import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CloudAiRateLimitError,
  assertCloudAiAvailable,
  cloudAiCooldownRemainingSec,
  friendlyCloudAiLimitNotice,
  readBuiltinAiResponse,
  resetCloudAiCooldown,
} from './cloudRateLimit.ts';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

test('429 from the server becomes a rate-limit error and starts a cooldown', async () => {
  resetCloudAiCooldown();
  const now = 1_000_000;
  await assert.rejects(
    readBuiltinAiResponse(jsonResponse(429, { error: 'x', code: 'ai_rate_limited', scope: 'client-minute', retryAfterSec: 42 }), now),
    (err: unknown) => err instanceof CloudAiRateLimitError && err.scope === 'client-minute' && err.retryAfterSec === 42,
  );
  assert.equal(cloudAiCooldownRemainingSec(now), 42);
  assert.throws(() => assertCloudAiAvailable(now + 1000), CloudAiRateLimitError);
  assert.doesNotThrow(() => assertCloudAiAvailable(now + 43_000));
  resetCloudAiCooldown();
});

test('generic 429 without a body uses Retry-After and the burst scope', async () => {
  resetCloudAiCooldown();
  await assert.rejects(
    readBuiltinAiResponse(new Response('nope', { status: 429, headers: { 'Retry-After': '7' } }), 0),
    (err: unknown) => err instanceof CloudAiRateLimitError && err.scope === 'burst' && err.retryAfterSec === 7,
  );
  resetCloudAiCooldown();
});

test('other errors stay plain errors and success returns the body', async () => {
  resetCloudAiCooldown();
  await assert.rejects(readBuiltinAiResponse(jsonResponse(500, { error: 'boom' })), (err: unknown) => !(err instanceof CloudAiRateLimitError) && (err as Error).message === 'boom');
  assert.deepEqual(await readBuiltinAiResponse(jsonResponse(200, { strategy: { chain: [] } })), { strategy: { chain: [] } });
  assert.equal(cloudAiCooldownRemainingSec(), 0);
});

test('friendly notices mention the local planner and a wait time', () => {
  const minute = friendlyCloudAiLimitNotice(new CloudAiRateLimitError('', 'client-minute', 30));
  assert.match(minute, /local DSP planner/);
  assert.match(minute, /30 s/);
  assert.match(friendlyCloudAiLimitNotice(new CloudAiRateLimitError('', 'client-day', 7200)), /today's cloud AI allowance.*2 h/);
  assert.match(friendlyCloudAiLimitNotice(new CloudAiRateLimitError('', 'global-day', 600)), /server's daily limit.*10 min/);
});
