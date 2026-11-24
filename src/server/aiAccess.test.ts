import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { createAiAccessGuard } from './aiAccess.ts';

const TOKEN = 'a'.repeat(64);

function invoke(guard: ReturnType<typeof createAiAccessGuard>, authorization?: string) {
  let statusCode = 200;
  let payload: unknown;
  let nextCalled = false;
  const req = { get: (name: string) => name.toLowerCase() === 'authorization' ? authorization : undefined } as unknown as Request;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json(body: unknown) { payload = body; return this; },
  } as unknown as Response;
  guard(req, res, (() => { nextCalled = true; }) as NextFunction);
  return { statusCode, payload, nextCalled };
}

test('production access is closed when the server token is missing or too short', () => {
  const missing = invoke(createAiAccessGuard({ production: true }));
  const short = invoke(createAiAccessGuard({ production: true, accessToken: 'too-short' }));
  assert.equal(missing.statusCode, 503);
  assert.equal(short.statusCode, 503);
  assert.equal(missing.nextCalled, false);
  assert.equal(short.nextCalled, false);
});

test('production access rejects missing and incorrect bearer credentials', () => {
  const guard = createAiAccessGuard({ production: true, accessToken: TOKEN });
  assert.equal(invoke(guard).statusCode, 401);
  assert.equal(invoke(guard, 'Bearer ' + 'b'.repeat(64)).statusCode, 401);
  assert.equal(invoke(guard, 'Basic ' + TOKEN).statusCode, 401);
});

test('production access accepts the configured bearer credential', () => {
  const result = invoke(createAiAccessGuard({ production: true, accessToken: TOKEN }), 'Bearer ' + TOKEN);
  assert.equal(result.statusCode, 200);
  assert.equal(result.nextCalled, true);
  assert.equal(result.payload, undefined);
});

test('development does not require a production access token', () => {
  const result = invoke(createAiAccessGuard({ production: false }), undefined);
  assert.equal(result.statusCode, 200);
  assert.equal(result.nextCalled, true);
});
