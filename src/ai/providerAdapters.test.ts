import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callProvider,
  describeProvider,
  extractJsonObject,
  listModels,
  maskKey,
  parseProviderResponse,
  ProviderError,
  redactSecrets,
  shapeRequest,
  type AiCallRequest,
  type ProviderConfig,
} from './providerAdapters.ts';
import { requestRefine, testProviderConnection } from './masteringClient.ts';
import { STRATEGY_JSON_SCHEMA, SYSTEM_PROMPT, toGeminiSchema, normalizeStrategyResponse } from './masteringPrompt.ts';
import { PROVIDER_PRESETS, getPreset } from './providerPresets.ts';
import type { AudioAnalysis } from '../types/mastering.ts';
import { STRATEGY_SCHEMA as SERVER_GEMINI_SCHEMA } from '../server/aiMastering.ts';

function validAnalysis(): AudioAnalysis {
  return {
    durationSec: 120,
    sampleRate: 48000,
    channels: 2,
    integratedLufs: -14,
    shortTermLufsMax: -10,
    momentaryLufsMax: -8,
    loudnessRangeLu: 6,
    rmsDb: -16,
    samplePeakDb: -1,
    truePeakDb: -0.8,
    dynamicRangeDb: 8,
    crestFactorDb: 10,
    plrDb: 13,
    transientDensity: 0.2,
    spectralCentroidHz: 2400,
    spectralSlopeDbPerOct: -2,
    zoneEnergyDb: { sub: -32, bass: -24, lowMid: -27, mid: -25, highMid: -28, presence: -33, air: -42 },
    spectrumBinsFreq: [20, 40, 80],
    spectrumBinsDb: [-40, -35, -28],
    resonances: [{ freqHz: 4200, excessDb: 3.2, severity: 'low' }],
    stereoWidth: 0.8,
    midSideRatioDb: -6,
    phaseCorrelation: 0.9,
    lowEndCorrelation: 0.95,
    lrBalanceDb: 0.1,
    monoCompatibilityScore: 92,
    clippedSamples: 0,
    interSamplePeaks: 0,
    thdEstimatePercent: 0.4,
    noiseFloorDb: -66,
    dcOffset: 0.0001,
    loudnessHistoryLufs: [-15, -14, -13],
  };
}

const KEY = 'sk-test-SECRET1234567890abcdef';

const cfg = (presetId: string, extra: Partial<ProviderConfig> = {}): ProviderConfig => {
  const p = getPreset(presetId);
  return { presetId, model: p.defaultModel, baseUrl: p.defaultBaseUrl ?? '', apiKey: KEY, agentic: p.agentic, timeoutSec: p.defaultTimeoutSec, ...extra };
};

const REQ: AiCallRequest = { kind: 'strategy', systemPrompt: SYSTEM_PROMPT, userPrompt: 'measurements…', schema: STRATEGY_JSON_SCHEMA };

const STRATEGY = {
  genre: 'Electropop',
  musicalStyle: 'electronic',
  instrumentationSummary: 'synths',
  vocalPresence: 'lead',
  tonalCharacteristics: 'bright',
  issuesDetected: ['low loudness'],
  strategySummary: 'raise level',
  targetLufs: -14,
  targetTruePeakDb: -1,
  processors: [
    {
      type: 'limiter',
      name: 'SYN Limiter',
      intensity: 60,
      wetDry: 100,
      reason: 'LUFS -15.9 vs -14 target',
      paramsJson: JSON.stringify({ ceilingDb: -1, thresholdDb: -3, releaseMs: 80, lookaheadMs: 5, truePeak: true, oversampling: 4 }),
    },
  ],
};

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

test('server Gemini schema and shared JSON schema are the same schema', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(SERVER_GEMINI_SCHEMA)), toGeminiSchema(STRATEGY_JSON_SCHEMA));
});

test('presets are unique and well-formed (data-driven list)', () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(PROVIDER_PRESETS[0].id, 'builtin-gemini');
  for (const p of PROVIDER_PRESETS) {
    if (p.adapter === 'openai-compatible' || p.adapter === 'webhook') assert.ok(p.defaultBaseUrl, p.id);
  }
  assert.equal(getPreset('openclaw').defaultBaseUrl, 'http://127.0.0.1:18789/v1');
  assert.equal(getPreset('nope').id, 'builtin-gemini');
});

test('OpenAI request: json_schema response_format, bearer key, same system prompt', () => {
  const { url, init } = shapeRequest(cfg('openai'), REQ);
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'gpt-6.2-sol');
  assert.equal(body.messages[0].content, SYSTEM_PROMPT);
  assert.equal(body.response_format.type, 'json_schema');
  assert.deepEqual(body.response_format.json_schema.schema, JSON.parse(JSON.stringify(STRATEGY_JSON_SCHEMA)));
});

test('Anthropic request: browser header, strategy-schema tool with auto tool_choice', () => {
  const { url, init } = shapeRequest(cfg('anthropic'), REQ);
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(init.headers['x-api-key'], KEY);
  const body = JSON.parse(init.body);
  assert.equal(body.system, SYSTEM_PROMPT);
  // Current Claude models reject a forced tool_choice; "auto" + an explicit instruction is used.
  assert.deepEqual(body.tool_choice, { type: 'auto' });
  assert.equal(body.tools[0].name, 'submit_mastering_strategy');
  assert.match(body.messages[0].content, /submit_mastering_strategy/);
  assert.deepEqual(body.tools[0].input_schema, JSON.parse(JSON.stringify(STRATEGY_JSON_SCHEMA)));
});

test('Gemini (own key) request: key in header not URL, upper-case responseSchema', () => {
  const { url, init } = shapeRequest(cfg('gemini'), REQ);
  assert.ok(!url.includes(KEY));
  assert.match(url, /models\/gemini-4-hydrogen:generateContent$/);
  assert.equal(init.headers['x-goog-api-key'], KEY);
  const body = JSON.parse(init.body);
  assert.equal(body.generationConfig.responseSchema.type, 'OBJECT');
  assert.equal(body.systemInstruction.parts[0].text, SYSTEM_PROMPT);
});

test('OpenClaw preset: prompt-only JSON (no response_format), custom base URL', () => {
  const { url, init } = shapeRequest(cfg('openclaw', { baseUrl: 'http://127.0.0.1:18789/v1/' }), REQ);
  assert.equal(url, 'http://127.0.0.1:18789/v1/chat/completions');
  const body = JSON.parse(init.body);
  assert.equal(body.response_format, undefined);
  assert.match(body.messages[1].content, /JSON Schema/);
});

test('webhook request carries prompt, measurements and schema with optional bearer', () => {
  const { url, init } = shapeRequest(cfg('webhook-agent', { baseUrl: 'https://n8n.example/webhook/x' }), { ...REQ, measurements: { a: 1 } });
  assert.equal(url, 'https://n8n.example/webhook/x');
  const body = JSON.parse(init.body);
  assert.equal(body.kind, 'strategy');
  assert.deepEqual(body.measurements, { a: 1 });
  assert.equal(body.systemPrompt, SYSTEM_PROMPT);
  assert.ok(body.responseSchema);
});

test('response parsing for each adapter', () => {
  const s = JSON.stringify(STRATEGY);
  assert.equal(parseProviderResponse(cfg('openai'), { choices: [{ message: { content: s } }] }).genre, 'Electropop');
  assert.equal(parseProviderResponse(cfg('anthropic'), { content: [{ type: 'tool_use', name: 'submit_mastering_strategy', input: STRATEGY }] }).genre, 'Electropop');
  assert.equal(parseProviderResponse(cfg('gemini'), { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: s }] } }] }).genre, 'Electropop');
  assert.equal(parseProviderResponse(cfg('webhook-agent'), { output: 'Done! ```json\n' + s + '\n```' }).genre, 'Electropop');
  assert.equal(parseProviderResponse(cfg('webhook-agent'), { strategy: STRATEGY }).genre, 'Electropop');
});

test('tolerant JSON extraction: preamble, fences, takes the last valid object', () => {
  const text = 'I looked at the track {not json}. Draft: {"processors": [], "v": 1}\nFinal answer:\n```json\n{"processors": [], "v": 2, "note": "a } brace in a string"}\n```';
  assert.equal(extractJsonObject(text).v, 2);
  assert.throws(() => extractJsonObject('no json here'), ProviderError);
});

test('callProvider retries without response_format when a server rejects it', async () => {
  const m = mockFetch([
    { status: 400, body: { error: { message: "'response_format.type' must be 'json_schema'" } } },
    { body: { choices: [{ message: { content: JSON.stringify(STRATEGY) } }] } },
  ]);
  const out = await callProvider(cfg('ollama', { apiKey: '' }), REQ, { fetchImpl: m.fn });
  assert.equal(out.genre, 'Electropop');
  assert.equal(m.calls.length, 2);
  assert.equal(JSON.parse(String(m.calls[1].init.body)).response_format, undefined);
});

test('auth vs network errors are distinguished and never contain the key', async () => {
  const m = mockFetch([{ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}` } } }]);
  await assert.rejects(callProvider(cfg('openai'), REQ, { fetchImpl: m.fn }), (e: unknown) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.code, 'auth');
    assert.ok(!e.message.includes(KEY));
    return true;
  });
  const failing = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(callProvider(cfg('openclaw'), REQ, { fetchImpl: failing }), (e: unknown) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.code, 'network');
    assert.match(e.message, /CORS/);
    return true;
  });
});

test('listModels reads GET /models (OpenClaw model prefill)', async () => {
  const m = mockFetch([{ body: { data: [{ id: 'openclaw' }, { id: 'openclaw/main' }] } }]);
  assert.deepEqual(await listModels(cfg('openclaw'), { fetchImpl: m.fn }), ['openclaw', 'openclaw/main']);
  assert.equal(m.calls[0].url, 'http://127.0.0.1:18789/v1/models');
});

test('invalid provider output falls back to built-in Gemini and the log names who produced the pass', async () => {
  const bad = { ...STRATEGY, processors: [{ ...STRATEGY.processors[0], type: 'rm-rf' }] };
  const m = mockFetch([{ body: { choices: [{ message: { content: JSON.stringify(bad) } }] } }]);
  let builtinCalls = 0;
  const builtinRefined = { strategySummary: 'builtin', issuesDetected: [], reasoningPerProcessor: [], chain: [] };
  const run = await requestRefine(
    cfg('groq'),
    { preAnalysis: validAnalysis(), postAnalysis: validAnalysis(), currentChain: [], targetLufs: -14, targetTruePeakDb: -1, preserveDynamics: true, qcReport: null },
    async () => {
      builtinCalls++;
      return builtinRefined;
    },
    { fetchImpl: m.fn },
  ).catch((e) => {
    throw e;
  });
  assert.equal(builtinCalls, 1);
  assert.equal(run.fellBack, true);
  assert.equal(run.producedBy, 'Built-in Gemini');
  assert.match(run.notices[0], /failed validation/);
  assert.ok(!run.notices[0].includes(KEY));
});

test('valid provider output passes the same validation as the built-in route', () => {
  const s = normalizeStrategyResponse(extractJsonObject(JSON.stringify(STRATEGY)), { mode: 'ai-auto' as never, targetLufs: -14 });
  assert.equal(s.chain.length, 1);
  assert.equal(s.chain[0].type, 'limiter');
});

test('connection test reports CORS/network failure specifically', async () => {
  const r = await testProviderConnection(cfg('lmstudio', { apiKey: '' }), {
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /^Network \/ CORS blocked/);
  const ok = await testProviderConnection(cfg('openai'), { fetchImpl: mockFetch([{ body: { choices: [{ message: { content: '{"ok":true,"processors":[]}' } }] } }]).fn });
  assert.equal(ok.ok, true);
});

test('key redaction and masking', () => {
  assert.equal(maskKey(KEY), 'sk-…cdef');
  assert.equal(maskKey(''), '');
  const leaked = `bad key ${KEY} and Bearer abc.def.ghi and AIzaSyA1234567890123456789012345 x-api-key: sk-ant-api03-zzzzzzzzzzzz`;
  const out = redactSecrets(leaked, [KEY]);
  assert.ok(!out.includes(KEY));
  assert.ok(!out.includes('abc.def.ghi'));
  assert.ok(!out.includes('AIzaSy'));
  assert.ok(!out.includes('sk-ant-api03'));
  const d = describeProvider(cfg('openai'));
  assert.ok(!JSON.stringify(d).includes(KEY));
});
