/**
 * Bring-your-own-AI: per-provider request/response shape and error handling with a mocked fetch
 * (no real keys or network), plus the model-name sanity check and current default model ids.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { callProvider, looksLikeModelError, modelWarning, ProviderError, validateConfig, type AiCallRequest, type ProviderConfig } from './providerAdapters.ts';
import { testProviderConnection } from './masteringClient.ts';
import { checkModelName, presetFamily } from './modelNames.ts';
import { getPreset, PROVIDER_PRESETS } from './providerPresets.ts';
import { STRATEGY_JSON_SCHEMA, SYSTEM_PROMPT } from './masteringPrompt.ts';

const KEY = 'sk-test-SECRET1234567890abcdef';
const NOW = new Date('2026-11-25T12:00:00Z');

const cfg = (presetId: string, extra: Partial<ProviderConfig> = {}): ProviderConfig => {
  const p = getPreset(presetId);
  return { presetId, model: p.defaultModel, baseUrl: p.defaultBaseUrl ?? '', apiKey: KEY, agentic: p.agentic, timeoutSec: p.defaultTimeoutSec, ...extra };
};

const REQ: AiCallRequest = { kind: 'strategy', systemPrompt: SYSTEM_PROMPT, userPrompt: 'measurements…', schema: STRATEGY_JSON_SCHEMA };
const DECISION = { genre: 'Electropop', processors: [] as unknown[], strategySummary: 'ok' };

function mockFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fn, calls };
}

const body = (call: { init: RequestInit }) => JSON.parse(String(call.init.body));
const headers = (call: { init: RequestInit }) => call.init.headers as Record<string, string>;

async function rejectsWith(p: Promise<unknown>, code: string, re?: RegExp): Promise<ProviderError> {
  let caught: ProviderError | null = null;
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ProviderError, `expected ProviderError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    assert.ok(!e.message.includes(KEY), 'error leaked the key');
    caught = e;
    return true;
  });
  return caught!;
}

// ---------------------------------------------------------------------------------------------
// Current defaults
// ---------------------------------------------------------------------------------------------

test('native presets default to current model ids (checked 2026-11-25)', () => {
  assert.equal(getPreset('anthropic').defaultModel, 'claude-sonnet-5-5');
  assert.equal(getPreset('openai').defaultModel, 'gpt-6.2-sol');
  assert.equal(getPreset('gemini').defaultModel, 'gemini-4-hydrogen');
  assert.equal(getPreset('xai').defaultModel, 'grok-4.7');
  // Built-in Gemini still uses the server default; nothing about it changes.
  assert.equal(getPreset('builtin-gemini').defaultModel, '(server default)');
});

test('every preset default passes the model-name sanity check without errors or warnings', () => {
  for (const p of PROVIDER_PRESETS) {
    if (!p.defaultModel || p.adapter === 'builtin-gemini' || p.adapter === 'webhook') continue;
    const c = checkModelName(p.id, '', NOW);
    assert.equal(c.level, 'ok', `${p.id}: ${c.message}`);
    assert.equal(c.model, p.defaultModel);
  }
});

// ---------------------------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------------------------

test('Anthropic: request shape (headers, version, tool, auto tool_choice, max_tokens)', async () => {
  const m = mockFetch([{ body: { type: 'message', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'submit_mastering_strategy', input: DECISION }] } }]);
  const out = await callProvider(cfg('anthropic'), REQ, { fetchImpl: m.fn });
  assert.equal(out.genre, 'Electropop');
  const c = m.calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.init.method, 'POST');
  assert.equal(headers(c)['x-api-key'], KEY);
  assert.equal(headers(c)['anthropic-version'], '2023-06-01');
  assert.equal(headers(c)['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(headers(c).Authorization, undefined);
  const b = body(c);
  assert.equal(b.model, 'claude-sonnet-5-5');
  assert.equal(b.system, SYSTEM_PROMPT);
  assert.ok(b.max_tokens > 0);
  assert.deepEqual(b.tool_choice, { type: 'auto' });
  assert.equal(b.temperature, undefined, 'sampling params are rejected by current Claude models');
});

test('Anthropic: plain-text JSON reply (no tool call) is accepted', async () => {
  const m = mockFetch([{ body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here you go:\n```json\n' + JSON.stringify(DECISION) + '\n```' }] } }]);
  assert.equal((await callProvider(cfg('anthropic'), REQ, { fetchImpl: m.fn })).genre, 'Electropop');
});

test('Anthropic: retired model 404, max_tokens truncation, refusal, overloaded', async () => {
  let m = mockFetch([{ status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'model: claude-sonnet-9' } } }]);
  const e = await rejectsWith(callProvider(cfg('anthropic', { model: 'claude-sonnet-9' }), REQ, { fetchImpl: m.fn }), 'model', /claude-sonnet-9/);
  assert.match(e.message, /claude-sonnet-5-5/, 'suggests the current default');
  assert.equal(e.status, 404);

  m = mockFetch([{ body: { stop_reason: 'max_tokens', content: [] } }]);
  await rejectsWith(callProvider(cfg('anthropic'), REQ, { fetchImpl: m.fn }), 'parse', /max_tokens/);

  m = mockFetch([{ body: { stop_reason: 'refusal', content: [{ type: 'text', text: 'no' }] } }]);
  await rejectsWith(callProvider(cfg('anthropic'), REQ, { fetchImpl: m.fn }), 'parse', /refusal/);

  m = mockFetch([{ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }]);
  await rejectsWith(callProvider(cfg('anthropic'), REQ, { fetchImpl: m.fn }), 'http', /HTTP 529.*Overloaded/);
});

// ---------------------------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------------------------

test('OpenAI: request shape (bearer, chat/completions, json_schema) and response', async () => {
  const m = mockFetch([{ body: { id: 'c1', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(DECISION), refusal: null } }] } }]);
  assert.equal((await callProvider(cfg('openai'), REQ, { fetchImpl: m.fn })).genre, 'Electropop');
  const c = m.calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(headers(c).Authorization, `Bearer ${KEY}`);
  const b = body(c);
  assert.equal(b.model, 'gpt-6.2-sol');
  assert.equal(b.messages[0].role, 'system');
  assert.equal(b.response_format.type, 'json_schema');
  assert.equal(b.response_format.json_schema.name, 'mastering_strategy');
  assert.equal(b.reasoning_effort, undefined, 'gpt-6.2-sol rejects reasoning_effort none; we send none at all');
});

test('OpenAI: model_not_found, 429 quota, refusal, length truncation', async () => {
  let m = mockFetch([{ status: 404, body: { error: { message: 'The model `gpt-9` does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found' } } }]);
  await rejectsWith(callProvider(cfg('openai', { model: 'gpt-9' }), REQ, { fetchImpl: m.fn }), 'model', /gpt-9.*gpt-6\.2-sol/s);

  m = mockFetch([{ status: 429, body: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } } }]);
  await rejectsWith(callProvider(cfg('openai'), REQ, { fetchImpl: m.fn }), 'http', /HTTP 429.*quota/s);

  m = mockFetch([{ body: { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I cannot help with that.' } }] } }]);
  await rejectsWith(callProvider(cfg('openai'), REQ, { fetchImpl: m.fn }), 'parse', /refused/);

  m = mockFetch([{ body: { choices: [{ finish_reason: 'length', message: { content: '' } }] } }]);
  await rejectsWith(callProvider(cfg('openai'), REQ, { fetchImpl: m.fn }), 'parse', /length/);

  m = mockFetch([{ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}` } } }]);
  await rejectsWith(callProvider(cfg('openai'), REQ, { fetchImpl: m.fn }), 'auth', /HTTP 401/);
});

// ---------------------------------------------------------------------------------------------
// Gemini (own key)
// ---------------------------------------------------------------------------------------------

test('Gemini: request shape (x-goog-api-key header, generateContent, responseSchema) and response', async () => {
  const m = mockFetch([{ body: { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: '…', thought: true }, { text: JSON.stringify(DECISION) }] } }] } }]);
  assert.equal((await callProvider(cfg('gemini'), REQ, { fetchImpl: m.fn })).genre, 'Electropop');
  const c = m.calls[0];
  assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent');
  assert.ok(!c.url.includes(KEY));
  assert.equal(headers(c)['x-goog-api-key'], KEY);
  const b = body(c);
  assert.equal(b.generationConfig.responseMimeType, 'application/json');
  assert.equal(b.generationConfig.responseSchema.type, 'OBJECT');
});

test('Gemini: "models/" prefix is stripped; unknown model 404; blocked prompt; MAX_TOKENS', async () => {
  let m = mockFetch([{ body: { candidates: [{ content: { parts: [{ text: JSON.stringify(DECISION) }] } }] } }]);
  await callProvider(cfg('gemini', { model: 'models/gemini-4-neon' }), REQ, { fetchImpl: m.fn });
  assert.match(m.calls[0].url, /\/models\/gemini-4-neon:generateContent$/);

  m = mockFetch([{ status: 404, body: { error: { code: 404, message: 'models/gemini-9 is not found for API version v1beta', status: 'NOT_FOUND' } } }]);
  await rejectsWith(callProvider(cfg('gemini', { model: 'gemini-9' }), REQ, { fetchImpl: m.fn }), 'model', /gemini-9.*gemini-4-hydrogen/s);

  m = mockFetch([{ body: { promptFeedback: { blockReason: 'SAFETY' } } }]);
  await rejectsWith(callProvider(cfg('gemini'), REQ, { fetchImpl: m.fn }), 'parse', /SAFETY/);

  m = mockFetch([{ body: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] } }]);
  await rejectsWith(callProvider(cfg('gemini'), REQ, { fetchImpl: m.fn }), 'parse', /MAX_TOKENS/);

  m = mockFetch([{ status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } } }]);
  await rejectsWith(callProvider(cfg('gemini'), REQ, { fetchImpl: m.fn }), 'auth', /rejected the key.*API key not valid/s);
});

// ---------------------------------------------------------------------------------------------
// xAI (OpenAI-compatible adapter)
// ---------------------------------------------------------------------------------------------

test('xAI: request shape (bearer, api.x.ai chat/completions, json_object) and response', async () => {
  const m = mockFetch([{ body: { object: 'chat.completion', model: 'grok-4.7', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(DECISION), refusal: null } }] } }]);
  assert.equal((await callProvider(cfg('xai'), REQ, { fetchImpl: m.fn })).genre, 'Electropop');
  const c = m.calls[0];
  assert.equal(c.url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(headers(c).Authorization, `Bearer ${KEY}`);
  const b = body(c);
  assert.equal(b.model, 'grok-4.7');
  assert.equal(b.response_format.type, 'json_object');
  assert.match(b.messages[1].content, /JSON Schema/);
});

test('xAI: unknown model 400 is reported as a model problem; response_format rejection retries once', async () => {
  let m = mockFetch([{ status: 400, body: { code: 'Client specified an invalid argument', error: 'The model grok-99 does not exist or your team does not have access to it.' } }]);
  await rejectsWith(callProvider(cfg('xai', { model: 'grok-99' }), REQ, { fetchImpl: m.fn }), 'model', /grok-99.*grok-4\.7/s);

  m = mockFetch([
    { status: 400, body: { error: 'response_format json_object is not supported for this model' } },
    { body: { choices: [{ message: { content: JSON.stringify(DECISION) } }] } },
  ]);
  assert.equal((await callProvider(cfg('xai'), REQ, { fetchImpl: m.fn })).genre, 'Electropop');
  assert.equal(m.calls.length, 2);
  assert.equal(body(m.calls[1]).response_format, undefined);
});

// ---------------------------------------------------------------------------------------------
// Shared error handling
// ---------------------------------------------------------------------------------------------

test('network failure, cancellation and non-JSON replies are classified for every native provider', async () => {
  for (const id of ['anthropic', 'openai', 'gemini', 'xai']) {
    await rejectsWith(
      callProvider(cfg(id), REQ, {
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
      'network',
      /CORS/,
    );
    const ac = new AbortController();
    ac.abort();
    await rejectsWith(
      callProvider(cfg(id), REQ, {
        signal: ac.signal,
        fetchImpl: async (_u, init) => {
          if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
          throw new Error('not aborted');
        },
      }),
      'cancelled',
    );
    const html = mockFetch([{ body: '<html>gateway error</html>' }]);
    await rejectsWith(callProvider(cfg(id), REQ, { fetchImpl: html.fn }), 'parse', /did not return JSON/);
  }
});

test('a 404 on a custom OpenAI-compatible base URL points at the URL, not the model', async () => {
  const m = mockFetch([{ status: 404, body: 'Cannot POST /chat/completions' }]);
  await rejectsWith(callProvider(cfg('openai-compatible', { baseUrl: 'https://gw.example/api', model: 'my-model' }), REQ, { fetchImpl: m.fn }), 'http', /base URL/);
});

test('looksLikeModelError heuristics', () => {
  assert.equal(looksLikeModelError(404, 'anything', true), true);
  assert.equal(looksLikeModelError(404, 'Not Found', false), false);
  assert.equal(looksLikeModelError(400, 'The model `x` does not exist', false), true);
  assert.equal(looksLikeModelError(400, 'invalid model id', false), true);
  assert.equal(looksLikeModelError(400, 'messages: field required', false), false);
  assert.equal(looksLikeModelError(500, 'model not found', true), false);
});

// ---------------------------------------------------------------------------------------------
// Model-name sanity check
// ---------------------------------------------------------------------------------------------

test('model check: blank uses the preset default; malformed names are rejected', () => {
  assert.deepEqual(checkModelName('anthropic', '  ', NOW), { level: 'ok', model: 'claude-sonnet-5-5' });
  assert.equal(checkModelName('openai', 'gpt 6.2 sol', NOW).level, 'error');
  assert.equal(checkModelName('openai', 'https://api.openai.com/v1', NOW).level, 'error');
  const key = checkModelName('openai', KEY, NOW);
  assert.equal(key.level, 'error');
  assert.match(key.message!, /API key/);
  assert.ok(!key.message!.includes(KEY), 'never echo a key-looking value');
  assert.equal(checkModelName('custom-agent', '', NOW).level, 'error');
});

test('model check: a model from another provider is rejected with a suggestion', () => {
  const a = checkModelName('anthropic', 'gpt-6.2-sol', NOW);
  assert.equal(a.level, 'error');
  assert.match(a.message!, /OpenAI model.*Anthropic/);
  assert.equal(a.suggestion, 'claude-sonnet-5-5');
  assert.equal(checkModelName('openai', 'claude-sonnet-5-5', NOW).level, 'error');
  assert.equal(checkModelName('gemini', 'grok-4.7', NOW).level, 'error');
  assert.equal(checkModelName('xai', 'gemini-4-neon', NOW).level, 'error');
  assert.equal(checkModelName('xai', 'llama-3.3-70b', NOW).level, 'error');
  // Free-form gateways accept any vendor's names.
  assert.equal(checkModelName('openrouter', 'anthropic/claude-sonnet-5-5', NOW).level, 'ok');
  assert.equal(checkModelName('ollama', 'llama3.1', NOW).level, 'ok');
  assert.equal(presetFamily('groq'), null);
});

test('model check: deprecated ids warn, retired ids block (date aware)', () => {
  const sonnet45 = checkModelName('anthropic', 'claude-sonnet-4-5', NOW);
  assert.equal(sonnet45.level, 'warning');
  assert.match(sonnet45.message!, /2026-11-30.*claude-sonnet-5-5/);
  const after = checkModelName('anthropic', 'claude-sonnet-4-5', new Date('2026-12-01T00:00:00Z'));
  assert.equal(after.level, 'error');
  assert.match(after.message!, /retired/);

  assert.equal(checkModelName('anthropic', 'claude-3-5-sonnet-20241022', NOW).level, 'error');
  assert.equal(checkModelName('openai', 'gpt-4.1', NOW).level, 'warning');
  assert.equal(checkModelName('openai', 'o1', NOW).level, 'error');
  assert.equal(checkModelName('gemini', 'gemini-2.5-pro', NOW).level, 'warning');
  assert.equal(checkModelName('gemini', 'gemini-2.0-flash', NOW).level, 'error');
  const grok4 = checkModelName('xai', 'grok-4', NOW);
  assert.equal(grok4.level, 'warning', 'retired xAI slugs still resolve (redirected)');
  assert.match(grok4.message!, /grok-4\.3/);
  assert.equal(checkModelName('xai', 'grok-4.7', NOW).level, 'ok');
  assert.equal(checkModelName('xai', 'grok-4.7-latest', NOW).level, 'ok');
});

test('validateConfig blocks model errors before any request is sent', async () => {
  assert.match(validateConfig(cfg('anthropic', { model: 'gpt-6.2-sol' }))!, /Anthropic/);
  assert.equal(validateConfig(cfg('anthropic')), null);
  let called = false;
  await rejectsWith(
    callProvider(cfg('gemini', { model: 'gemini-2.0-flash' }), REQ, {
      fetchImpl: async () => {
        called = true;
        return new Response('{}');
      },
    }),
    'config',
    /retired.*gemini-4-hydrogen/,
  );
  assert.equal(called, false);
});

test('deprecated model: the request still runs and carries a warning', async () => {
  assert.match(modelWarning(cfg('openai', { model: 'gpt-4.1' }))!, /gpt-6-luna/);
  assert.equal(modelWarning(cfg('openai')), null);
  assert.equal(modelWarning(cfg('builtin-gemini', { model: 'gpt-4.1' })), null);

  const t = await testProviderConnection(cfg('openai', { model: 'gpt-4.1' }), { fetchImpl: mockFetch([{ body: { choices: [{ message: { content: '{"ok":true,"processors":[]}' } }] } }]).fn });
  assert.equal(t.ok, true);
  assert.match(t.message, /Warning: .*deprecated/);
});

test('connection test labels model errors', async () => {
  const r = await testProviderConnection(cfg('openai', { model: 'gpt-9' }), {
    fetchImpl: mockFetch([{ status: 404, body: { error: { message: 'The model `gpt-9` does not exist', code: 'model_not_found' } } }]).fn,
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /^Model not accepted: /);
});
