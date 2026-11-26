import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import test from 'node:test';

const SESSION_SECRET = 'integration-test-session-secret-0123456789abcdef';
const sessionCookies = new Map();

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(t, extraEnv) {
  const port = await getFreePort();
  const baseUrl = 'http://127.0.0.1:' + port;
  const env = { ...process.env, NODE_ENV: 'production', PORT: String(port), SYN_MASTER_SESSION_SECRET: SESSION_SECRET, ...extraEnv };
  // Never let the test reach a real Gemini key: every spending call stops before billing.
  delete env.GEMINI_API_KEY;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  const collect = (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-8000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
        timer.unref?.();
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited early: ' + diagnostics);
    try {
      const res = await fetch(baseUrl + '/api/health');
      if (res.ok) return baseUrl;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start: ' + diagnostics);
}

async function post(baseUrl, route, { auth = true, body = {} } = {}) {
  let cookie = '';
  if (auth) {
    cookie = sessionCookies.get(baseUrl) ?? '';
    if (!cookie) {
      const session = await fetch(baseUrl + '/api/ai/session', { method: 'POST', headers: { Origin: baseUrl } });
      assert.equal(session.status, 204);
      cookie = String(session.headers.get('set-cookie') ?? '').split(';', 1)[0];
      assert.match(cookie, /^syn_master_guest=/);
      sessionCookies.set(baseUrl, cookie);
    }
  }
  return fetch(baseUrl + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test('AI spend limits: per-client strategy minute cap, refine budget and unauthenticated traffic', { timeout: 60_000 }, async (t) => {
  const baseUrl = await startServer(t, { SYN_AI_STRATEGY_PER_MINUTE: '2', SYN_AI_REFINE_PER_MINUTE: '1', SYN_AI_GLOBAL_PER_DAY: '50' });

  // Requests without a guest cookie are rejected and never spend the AI budget.
  for (let i = 0; i < 4; i++) assert.equal((await post(baseUrl, '/api/ai/master', { auth: false })).status, 401);

  // Authorised calls reach the route (400: empty telemetry) until the per-minute cap.
  assert.equal((await post(baseUrl, '/api/ai/master')).status, 400);
  assert.equal((await post(baseUrl, '/api/ai/master')).status, 400);
  const limited = await post(baseUrl, '/api/ai/MASTER/');
  assert.equal(limited.status, 429, 'case/trailing-slash variants must be counted too');
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(retryAfter >= 1 && retryAfter <= 60);
  const body = await limited.json();
  assert.equal(body.code, 'ai_rate_limited');
  assert.equal(body.scope, 'client-minute');
  assert.equal(body.fallback, 'local-dsp-planner');
  assert.match(body.error, /local DSP planner/);

  // Refine has its own minute budget.
  assert.equal((await post(baseUrl, '/api/ai/refine')).status, 400);
  assert.equal((await post(baseUrl, '/api/ai/refine')).status, 429);

  // Non-spending routes are untouched.
  assert.equal((await fetch(baseUrl + '/api/health')).status, 200);
});

test('AI spend limits: global daily cap answers 429 for every client', { timeout: 60_000 }, async (t) => {
  const baseUrl = await startServer(t, { SYN_AI_GLOBAL_PER_DAY: '2', SYN_AI_STRATEGY_PER_MINUTE: '10' });
  assert.equal((await post(baseUrl, '/api/ai/master')).status, 400);
  assert.equal((await post(baseUrl, '/api/ai/refine')).status, 400);
  const res = await post(baseUrl, '/api/ai/master');
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.scope, 'global-day');
  assert.ok(Number(res.headers.get('retry-after')) > 3600);
});
