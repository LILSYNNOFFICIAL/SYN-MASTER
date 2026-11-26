import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_AI_TIMEOUT_MS,
  CloudAiHttpError,
  CloudAiRateLimitError,
  assertCloudAiAvailable,
  classifyBuiltinAiError,
  cloudAiCooldownRemainingSec,
  createCloudAiRequestSignal,
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

test('cloud AI client timeout is longer than the server 60s timeout and Stop cancels immediately', async () => {
  assert.equal(CLOUD_AI_TIMEOUT_MS, 70_000);
  assert.ok(CLOUD_AI_TIMEOUT_MS > 60_000, 'client timeout must exceed server GEMINI_TIMEOUT_MS (60s)');

  const cancelController = new AbortController();
  const stopReq = createCloudAiRequestSignal(10_000, cancelController.signal);
  try {
    assert.equal(stopReq.signal.aborted, false);
    cancelController.abort();
    assert.equal(stopReq.signal.aborted, true);
    assert.equal(stopReq.cancelled(), true);
    assert.equal(stopReq.timedOut(), false);
  } finally {
    stopReq.cleanup();
  }

  const timeoutReq = createCloudAiRequestSignal(15);
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(timeoutReq.signal.aborted, true);
    assert.equal(timeoutReq.timedOut(), true);
    assert.equal(timeoutReq.cancelled(), false);
  } finally {
    timeoutReq.cleanup();
  }
});

test('readBuiltinAiResponse and classifyBuiltinAiError distinguish fallback causes and 25s/30s timeouts', async () => {
  resetCloudAiCooldown();
  const cases: Array<{ status: number; body: Record<string, unknown>; expectedReason: string; expectedTimeout: string | null }> = [
    { status: 504, body: { error: 'AI mastering took too long. Please try again.', code: 'ai_timeout', timeoutHit: 'server-25s' }, expectedReason: 'timeout', expectedTimeout: 'server-25s' },
    { status: 503, body: { error: 'GEMINI_API_KEY is not configured.', code: 'missing_key' }, expectedReason: 'missing-key', expectedTimeout: null },
    { status: 401, body: { error: 'Guest session expired.', code: 'guest_session' }, expectedReason: 'guest-session', expectedTimeout: null },
    { status: 502, body: { error: 'Malformed JSON from Gemini', code: 'parse_error' }, expectedReason: 'parse', expectedTimeout: null },
    { status: 422, body: { error: 'Invalid chain', code: 'validation_error' }, expectedReason: 'validation', expectedTimeout: null },
    { status: 500, body: { error: 'Unexpected error', code: 'server_error' }, expectedReason: 'server-error', expectedTimeout: null },
  ];

  for (const c of cases) {
    let caught: unknown;
    try {
      await readBuiltinAiResponse(jsonResponse(c.status, c.body));
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof CloudAiHttpError, `status ${c.status} must throw CloudAiHttpError`);
    const classified = classifyBuiltinAiError(caught, false);
    assert.equal(classified.fallbackReason, c.expectedReason);
    assert.equal(classified.timeoutHit, c.expectedTimeout);
  }

  const clientTimedOut = classifyBuiltinAiError(new DOMException('timed out', 'TimeoutError'), true);
  assert.equal(clientTimedOut.fallbackReason, 'timeout');
  assert.equal(clientTimedOut.timeoutHit, 'client-30s');
});
