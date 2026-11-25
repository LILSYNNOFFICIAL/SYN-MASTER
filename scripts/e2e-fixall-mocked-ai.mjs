// Browser end-to-end check of FIX ALL with a mocked AI provider (no real AI or Gemini call).
// Runs the production build (npm run build first) through server.ts, imports a short WAV,
// points the BYO provider at a mocked OpenAI-compatible endpoint, enables cloud reasoning,
// presses FIX ALL and checks that:
//   - the strategy request contains the "Mode: <mode> — <meaning>" line,
//   - the verification loop re-measures and asks the AI to refine at least once,
//   - the run ends with a measured verdict in the UI (Verified / Not fully verified).
// Usage: node scripts/e2e-fixall-mocked-ai.mjs   (needs `playwright` + Chromium installed)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = process.env.SYN_E2E_PORT ?? '4181';
const baseUrl = `http://127.0.0.1:${port}`;
const MOCK_ORIGIN = 'https://mock-ai.invalid';

const server = spawn(process.execPath, ['server.ts'], {
  stdio: 'ignore',
  env: { ...process.env, NODE_ENV: 'production', PORT: port, HOST: '127.0.0.1', SYN_MASTER_AI_ACCESS_TOKEN: 'e2e-fixall-check-token-0123456789abcdef', GEMINI_API_KEY: '' },
});

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`server exited with ${server.exitCode}`);
    try {
      if ((await fetch(baseUrl)).ok) return;
    } catch { /* starting */ }
    await delay(500);
  }
  throw new Error('server did not start');
}

function toneWav(sampleRate = 44100, seconds = 2) {
  const frames = Math.floor(sampleRate * seconds);
  const data = frames * 8;
  const wav = Buffer.alloc(44 + data);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + data, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 8, 28); wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34); wav.write('data', 36); wav.writeUInt32LE(data, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const env = 0.65 + 0.35 * Math.sin(2 * Math.PI * 2 * t);
    const s = 0.05 * env * (0.48 * Math.sin(2 * Math.PI * 65 * t) + 0.32 * Math.sin(2 * Math.PI * 220 * t) + 0.24 * Math.sin(2 * Math.PI * 880 * t) + 0.16 * Math.sin(2 * Math.PI * 2800 * t));
    wav.writeFloatLE(s, 44 + i * 8);
    wav.writeFloatLE(s * 0.97, 48 + i * 8);
  }
  return wav;
}

const STRATEGY = {
  genre: 'Electropop', musicalStyle: 'electronic', instrumentationSummary: 'synths', vocalPresence: 'none', tonalCharacteristics: 'balanced',
  issuesDetected: ['low loudness'], strategySummary: 'mocked: light EQ only', targetLufs: -14, targetTruePeakDb: -1,
  processors: [{ type: 'parametric-eq', name: 'Mock EQ', intensity: 100, wetDry: 100, reason: 'mocked AI', paramsJson: JSON.stringify({ bands: [{ id: 'b1', enabled: true, type: 'bell', freq: 3000, gainDb: 0.5, q: 1 }] }) }],
};
const REFINE = {
  ...STRATEGY,
  strategySummary: 'mocked: add limiter',
  processors: [...STRATEGY.processors, { type: 'limiter', name: 'Mock Limiter', intensity: 100, wetDry: 100, inputGainDb: 12, reason: 'mocked refine', paramsJson: JSON.stringify({ ceilingDb: -1, thresholdDb: -3, releaseMs: 80, lookaheadMs: 5, truePeak: true, oversampling: 4 }) }],
};

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };

try {
  await waitForServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    sessionStorage.setItem('syn-master.ai-provider.v1', JSON.stringify({
      presetId: 'openai-compatible',
      overrides: { 'openai-compatible': { model: 'mock-model', baseUrl: 'https://mock-ai.invalid/v1' } },
      keys: { 'openai-compatible': 'sk-mock-e2e-0123456789' },
      serverAccessToken: '',
      remember: false,
    }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const aiCalls = [];
  const builtinCalls = [];
  await page.route(`${MOCK_ORIGIN}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(req.postData() ?? '{}');
    const user = (body.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const kind = /^Mode: /m.test(user) ? 'strategy' : 'refine';
    aiCalls.push({ kind, user });
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(kind === 'strategy' ? STRATEGY : REFINE) } }] }) });
  });
  await page.route('**/api/ai/**', (route) => { builtinCalls.push(route.request().url()); return route.fulfill({ status: 500, body: '{}' }); });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="syn-console"]').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('input[type="file"][accept*="audio"]').first().setInputFiles({ name: 'fixall-e2e.wav', mimeType: 'audio/wav', buffer: toneWav() });
  await page.locator('.syn-fixai:not([disabled])').waitFor({ timeout: 30000 });

  // Turn on cloud AI reasoning (off by default) in the AI workspace.
  await page.locator('.syn-primary-nav-more').click();
  await page.locator('.syn-workspace-menu-item').filter({ hasText: 'AI Director' }).click();
  await page.getByRole('button', { name: /Safeguards & Cloud/ }).click();
  const cloud = page.getByLabel(/Include cloud AI reasoning/);
  await cloud.check();
  assert.equal(await cloud.isChecked(), true);
  await page.locator('.syn-primary-nav-item').filter({ hasText: 'Dashboard' }).click();

  const started = Date.now();
  await page.locator('.syn-fixai').click();
  await page.locator('.syn2-result-title').waitFor({ state: 'visible', timeout: 100000 });
  const verdict = (await page.locator('.syn2-result-title').innerText()).trim();
  console.log(`Fix All finished in ${((Date.now() - started) / 1000).toFixed(1)} s: ${verdict}`);

  const strategy = aiCalls.find((c) => c.kind === 'strategy');
  assert.ok(strategy, 'the mocked provider received a strategy request');
  const modeLine = strategy.user.match(/^Mode: ([a-z-]+) — (.+)$/m);
  assert.ok(modeLine && modeLine[2].length > 8, 'strategy request must carry "Mode: <mode> — <meaning>"');
  console.log(`PASS strategy request carries: ${modeLine[0]}`);
  assert.ok(aiCalls.some((c) => c.kind === 'refine'), `verification loop must request at least one AI refinement (calls: ${aiCalls.map((c) => c.kind).join(',')})`);
  console.log(`PASS verification loop asked the AI to refine (${aiCalls.filter((c) => c.kind === 'refine').length}x)`);
  assert.deepEqual(builtinCalls, [], 'built-in Gemini must not be called when the mocked provider answers');
  assert.match(verdict, /Verified master: every target passed|Master not fully verified/);
  assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
  console.log('PASS Fix All end to end with mocked AI');
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
