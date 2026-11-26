import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { createAiGuestSession } from './aiAccess.ts';

const SECRET = 'unit-test-session-secret-0123456789abcdef';

function makeRequest(options: { origin?: string; host?: string; protocol?: string; secure?: boolean; cookie?: string; fetchSite?: string } = {}) {
  const values: Record<string, string> = {
    host: options.host ?? 'app.example',
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.fetchSite ? { 'sec-fetch-site': options.fetchSite } : {}),
  };
  return {
    headers: { cookie: options.cookie },
    protocol: options.protocol ?? 'https',
    secure: options.secure ?? true,
    get: (name: string) => values[name.toLowerCase()],
  } as unknown as Request;
}

function makeResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let payload: unknown;
  let ended = false;
  const response = {
    locals: {} as Record<string, unknown>,
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { payload = value; return this; },
    end() { ended = true; return this; },
  } as unknown as Response;
  return { response, headers, get statusCode() { return statusCode; }, get payload() { return payload; }, get ended() { return ended; } };
}

test('production guest bootstrap issues an HttpOnly Secure SameSite=Strict cookie', () => {
  const sessions = createAiGuestSession({ secret: SECRET, production: true, now: () => 1_000 });
  const req = makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https', secure: true });
  const res = makeResponse();
  sessions.bootstrap(req, res.response);
  const cookie = res.headers['set-cookie'];
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  assert.match(cookie, /^syn_master_guest=/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /; Path=\/api\/ai/);
  const token = cookie.split(';', 1)[0];
  const parsed = sessions.readSession(makeRequest({ cookie: token }));
  assert.ok(parsed);
  assert.equal(parsed.expiresAt, 1_000 + 12 * 60 * 60 * 1000);
});

test('guest middleware renews a valid session within its final two hours without changing its identity', () => {
  let now = 1_000;
  const sessions = createAiGuestSession({ secret: SECRET, production: true, now: () => now });
  const bootstrapRes = makeResponse();
  sessions.bootstrap(makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https', secure: true }), bootstrapRes.response);
  const initialCookie = bootstrapRes.headers['set-cookie'].split(';', 1)[0];
  const initialSession = sessions.readSession(makeRequest({ cookie: initialCookie }));
  assert.ok(initialSession);

  now += 10.5 * 60 * 60 * 1000;
  const renewalRes = makeResponse();
  let nextCalled = false;
  sessions.middleware(
    makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https', secure: true, cookie: initialCookie, fetchSite: 'same-origin' }),
    renewalRes.response,
    (() => { nextCalled = true; }) as NextFunction,
  );

  assert.equal(nextCalled, true);
  const renewedCookie = renewalRes.headers['set-cookie'];
  assert.ok(renewedCookie, 'a session inside the renewal window must receive a refreshed cookie');
  assert.match(renewedCookie, /; HttpOnly/);
  assert.match(renewedCookie, /; Secure/);
  assert.match(renewedCookie, /; SameSite=Strict/);
  const renewedSession = sessions.readSession(makeRequest({ cookie: renewedCookie.split(';', 1)[0] }));
  assert.equal(renewedSession?.id, initialSession.id, 'renewal must preserve the guest-session identity');
  assert.equal(renewedSession?.expiresAt, now + 12 * 60 * 60 * 1000);
});

test('guest middleware rejects cross-site fetch metadata even when the cookie is valid', () => {
  const sessions = createAiGuestSession({ secret: SECRET, production: true });
  const bootstrapRes = makeResponse();
  sessions.bootstrap(makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https' }), bootstrapRes.response);
  const cookie = bootstrapRes.headers['set-cookie'].split(';', 1)[0];
  const crossSite = makeResponse();
  let nextCalled = false;

  sessions.middleware(
    makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https', cookie, fetchSite: 'cross-site' }),
    crossSite.response,
    (() => { nextCalled = true; }) as NextFunction,
  );

  assert.equal(nextCalled, false);
  assert.equal(crossSite.statusCode, 403);
});

test('guest middleware validates the cookie and exposes only its session identifier server-side', () => {
  const sessions = createAiGuestSession({ secret: SECRET, production: true, now: () => 1_000 });
  const bootstrapReq = makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https' });
  const bootstrapRes = makeResponse();
  sessions.bootstrap(bootstrapReq, bootstrapRes.response);
  const cookie = bootstrapRes.headers['set-cookie'].split(';', 1)[0];
  const req = makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https', cookie, fetchSite: 'same-origin' });
  const res = makeResponse();
  let nextCalled = false;
  sessions.middleware(req, res.response, (() => { nextCalled = true; }) as NextFunction);
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.response.locals.guestSessionId, 'string');
  assert.equal(String(res.response.locals.guestSessionId).length, 36);
});

test('tampered, missing and expired guest cookies are rejected', () => {
  let now = 1_000;
  const sessions = createAiGuestSession({ secret: SECRET, production: true, now: () => now });
  const req = makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https' });
  const bootstrapRes = makeResponse();
  sessions.bootstrap(req, bootstrapRes.response);
  const cookie = bootstrapRes.headers['set-cookie'].split(';', 1)[0];
  const tokenValue = cookie.slice('syn_master_guest='.length);
  const tamperedValue = (tokenValue[0] === '0' ? '1' : '0') + tokenValue.slice(1);
  const tampered = makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https', cookie: 'syn_master_guest=' + tamperedValue });
  const expired = makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https', cookie });
  now += 13 * 60 * 60 * 1000;
  for (const invalid of [makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https' }), tampered, expired]) {
    const res = makeResponse();
    let nextCalled = false;
    sessions.middleware(invalid, res.response, (() => { nextCalled = true; }) as NextFunction);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  }
});

test('production derives a stable, domain-separated guest signing key from the server Gemini key when no override is configured', () => {
  const providerKey = 'server-side-gemini-api-key-for-syn-master-123456789';
  const firstReplica = createAiGuestSession({ providerKey, production: true, now: () => 1_000 });
  const secondReplica = createAiGuestSession({ providerKey, production: true, now: () => 1_000 });
  assert.equal(firstReplica.isConfigured, true);
  assert.equal(secondReplica.isConfigured, true);

  const bootstrap = makeResponse();
  firstReplica.bootstrap(makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https', secure: true }), bootstrap.response);
  assert.equal(bootstrap.statusCode, 204);
  const cookie = bootstrap.headers['set-cookie'].split(';', 1)[0];

  const accepted = makeResponse();
  let nextCalled = false;
  secondReplica.middleware(
    makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https', secure: true, cookie, fetchSite: 'same-origin' }),
    accepted.response,
    (() => { nextCalled = true; }) as NextFunction,
  );
  assert.equal(nextCalled, true, 'another replica must validate the same signed guest cookie');

  const differentKeyReplica = createAiGuestSession({ providerKey: providerKey + '-different', production: true });
  const rejected = makeResponse();
  let differentKeyNextCalled = false;
  differentKeyReplica.middleware(
    makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https', cookie, fetchSite: 'same-origin' }),
    rejected.response,
    (() => { differentKeyNextCalled = true; }) as NextFunction,
  );
  assert.equal(differentKeyNextCalled, false, 'a different provider key must not validate the cookie');
  assert.equal(rejected.statusCode, 401);
});

test('guest bootstrap rejects cross-origin requests and fails closed only when neither a valid override nor Gemini server key exists', () => {
  const sessions = createAiGuestSession({ secret: SECRET, production: true });
  const crossOrigin = makeResponse();
  sessions.bootstrap(makeRequest({ origin: 'https://attacker.example', host: 'app.example', protocol: 'https' }), crossOrigin.response);
  assert.equal(crossOrigin.statusCode, 403);

  const unconfigured = createAiGuestSession({ production: true });
  const unavailable = makeResponse();
  unconfigured.bootstrap(makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https' }), unavailable.response);
  assert.equal(unavailable.statusCode, 503);

  const invalidProvider = createAiGuestSession({ providerKey: 'MY_GEMINI_API_KEY', production: true });
  assert.equal(invalidProvider.isConfigured, false);
});

test('production rejects placeholder signing secrets and reuse of the Gemini provider key', () => {
  const placeholder = createAiGuestSession({ secret: 'GENERATE_A_RANDOM_64_CHARACTER_HEX_SECRET', providerKey: 'server-side-gemini-api-key-for-syn-master-123456789', production: true });
  assert.equal(placeholder.isConfigured, false);
  const reused = createAiGuestSession({ secret: SECRET, providerKey: SECRET, production: true });
  assert.equal(reused.isConfigured, false);
  for (const sessions of [placeholder, reused]) {
    const res = makeResponse();
    sessions.bootstrap(makeRequest({ origin: 'https://app.example', host: 'app.example', protocol: 'https' }), res.response);
    assert.equal(res.statusCode, 503);
  }
});

test('development guest cookies omit Secure on loopback HTTP and still validate', () => {
  const sessions = createAiGuestSession({ secret: SECRET, production: false });
  const req = makeRequest({ origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000', protocol: 'http', secure: false });
  const res = makeResponse();
  sessions.bootstrap(req, res.response);
  assert.equal(res.statusCode, 204);
  assert.doesNotMatch(res.headers['set-cookie'], /; Secure/);
});
