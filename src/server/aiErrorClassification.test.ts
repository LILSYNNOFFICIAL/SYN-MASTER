import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_UPSTREAM_FAILURE_CODES, isAiUpstreamFailureCode } from '../ai/aiFailureCodes.ts';
import { AiValidationError } from '../ai/masteringPrompt.ts';
import { buildSanitizedAiErrorResponse, classifyUpstreamAiFailure } from './aiErrorClassification.ts';
import {
  AiConfigError,
  AiTimeoutError,
  AiUpstreamResponseError,
  GEMINI_TIMEOUT_MS,
  assertUsableGeminiResponse,
} from './aiMastering.ts';

/** Mimics @google/genai ApiError: an Error with a numeric HTTP status and the upstream body in the message. */
function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const FAKE_KEY = 'AIzaSyFAKEFAKEFAKEFAKEFAKE1234567';

test('server Gemini timeout stays 60 s (client 70 s must remain longer)', () => {
  assert.equal(GEMINI_TIMEOUT_MS, 60_000);
});

test('upstream failures classify into the safe short codes', () => {
  const cases: Array<[unknown, string]> = [
    [apiError(429, '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'), 'upstream-429'],
    [new Error('got status: 429 Too Many Requests'), 'upstream-429'],
    [apiError(500, '{"error":{"code":500,"status":"INTERNAL"}}'), 'upstream-5xx'],
    [apiError(503, 'The model is overloaded. UNAVAILABLE'), 'upstream-5xx'],
    [apiError(504, 'DEADLINE_EXCEEDED'), 'upstream-timeout'],
    [new AiTimeoutError('AI refinement pass timed out after 60s.'), 'upstream-timeout'],
    [new AiUpstreamResponseError('upstream-safety-block', 'blocked'), 'upstream-safety-block'],
    [apiError(400, 'Response was blocked due to SAFETY'), 'upstream-safety-block'],
    [new AiUpstreamResponseError('empty-response', 'empty'), 'empty-response'],
    [new SyntaxError('Unexpected token } in JSON at position 3'), 'json-parse'],
    [new AiValidationError('AI chain failed validation'), 'schema-validation'],
    [new Error('something odd'), 'unknown'],
    [apiError(400, 'INVALID_ARGUMENT'), 'unknown'],
    ['a string', 'unknown'],
  ];
  for (const [err, expected] of cases) {
    const code = classifyUpstreamAiFailure(err);
    assert.equal(code, expected, `expected ${expected} for ${String((err as Error)?.message ?? err)}`);
    assert.ok(isAiUpstreamFailureCode(code));
  }
});

test('responses carry fallbackDetail, keep existing status codes, and record the server timeout in ms', () => {
  const timeout = buildSanitizedAiErrorResponse(new AiTimeoutError('timed out'));
  assert.equal(timeout.status, 504);
  assert.equal(timeout.body.code, 'ai_timeout');
  assert.equal(timeout.body.timeoutHit, 'server');
  assert.equal(timeout.body.timeoutMs, GEMINI_TIMEOUT_MS);
  assert.equal(timeout.body.fallbackDetail, 'upstream-timeout');

  const expectations: Array<[unknown, number, string, string]> = [
    [apiError(429, 'RESOURCE_EXHAUSTED'), 429, 'ai_rate_limited', 'upstream-429'],
    [apiError(503, 'UNAVAILABLE'), 503, 'server_error', 'upstream-5xx'],
    [apiError(504, 'DEADLINE_EXCEEDED'), 504, 'ai_timeout', 'upstream-timeout'],
    [new AiUpstreamResponseError('empty-response', 'x'), 502, 'empty_response', 'empty-response'],
    [new AiUpstreamResponseError('upstream-safety-block', 'x'), 502, 'safety_block', 'upstream-safety-block'],
    [new SyntaxError('bad'), 502, 'parse_error', 'json-parse'],
    [new AiValidationError('bad chain'), 422, 'validation_error', 'schema-validation'],
    [new Error('mystery'), 500, 'server_error', 'unknown'],
  ];
  for (const [err, status, code, detail] of expectations) {
    const r = buildSanitizedAiErrorResponse(err);
    assert.equal(r.status, status, detail);
    assert.equal(r.body.code, code, detail);
    assert.equal(r.body.fallbackDetail, detail);
    assert.ok(AI_UPSTREAM_FAILURE_CODES.includes(r.body.fallbackDetail!));
  }
  // Only our own timer sets timeoutHit.
  assert.equal(buildSanitizedAiErrorResponse(apiError(504, 'DEADLINE_EXCEEDED')).body.timeoutHit, undefined);

  const missing = buildSanitizedAiErrorResponse(new AiConfigError('Cloud AI mastering is not configured on this server.'));
  assert.equal(missing.status, 503);
  assert.equal(missing.body.code, 'missing_key');
});

test('responses never leak the API key, upstream body text, request bodies or stack traces', () => {
  const nasty = apiError(
    500,
    `request to https://generativelanguage.googleapis.com/v1/models?key=${FAKE_KEY} failed: {"contents":"SECRET PROMPT BODY","analysis":{"lufs":-9}}\n    at fetch (node:internal/deps/undici:1:1)`,
  );
  nasty.stack = `Error: boom\n    at secretFunction (/srv/app/server.ts:42:7)`;
  const errors: unknown[] = [nasty, new Error(`key=${FAKE_KEY} SECRET PROMPT BODY`), apiError(429, `RESOURCE_EXHAUSTED key=${FAKE_KEY}`), apiError(503, `UNAVAILABLE ${FAKE_KEY}`)];
  for (const err of errors) {
    const r = buildSanitizedAiErrorResponse(err);
    const serialized = JSON.stringify(r.body);
    assert.ok(!serialized.includes(FAKE_KEY), 'API key leaked into body');
    assert.ok(!serialized.includes('SECRET PROMPT BODY'), 'upstream/request body leaked');
    assert.ok(!/\bat \S+ \(/.test(serialized) && !serialized.includes('server.ts:42'), 'stack trace leaked');
    assert.ok(!(r.logLine ?? '').includes(FAKE_KEY), 'API key leaked into server log line');
    assert.ok(!(r.logLine ?? '').includes('secretFunction'), 'stack leaked into server log line');
  }
});

test('assertUsableGeminiResponse flags empty and safety-blocked responses', () => {
  assert.equal(assertUsableGeminiResponse({ text: '{"processors":[]}' }), '{"processors":[]}');
  assert.throws(() => assertUsableGeminiResponse({ text: '' }), (e: unknown) => e instanceof AiUpstreamResponseError && e.failureCode === 'empty-response');
  assert.throws(() => assertUsableGeminiResponse({ text: '   ' }), (e: unknown) => e instanceof AiUpstreamResponseError && e.failureCode === 'empty-response');
  assert.throws(() => assertUsableGeminiResponse({}), (e: unknown) => e instanceof AiUpstreamResponseError && e.failureCode === 'empty-response');
  assert.throws(
    () => assertUsableGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
    (e: unknown) => e instanceof AiUpstreamResponseError && e.failureCode === 'upstream-safety-block',
  );
  assert.throws(
    () => assertUsableGeminiResponse({ text: '', candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }),
    (e: unknown) => e instanceof AiUpstreamResponseError && e.failureCode === 'upstream-safety-block',
  );
  assert.equal(assertUsableGeminiResponse({ text: '{}', candidates: [{ finishReason: 'STOP' }] }), '{}');
});
