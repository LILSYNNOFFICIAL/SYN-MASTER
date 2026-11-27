import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROCESSOR_PARAM_LIMITS } from '../dsp/chainValidation';
import {
  AI_PROCESSOR_TYPES,
  normalizeRefineResponse,
  normalizeStrategyResponse,
  parseAiChain,
  PROCESSOR_JSON_SCHEMA,
  type RawAiProcessor,
} from './masteringPrompt';
import { PROCESSOR_SCHEMA } from '../server/aiMastering';
import { requestStrategy } from './masteringClient';
import type { ProviderConfig } from './providerAdapters';
import { analyzeAudioBuffer } from '../dsp/analyzer';
import { buildDiagnosticLog, diagnosticLogToText } from '../director/diagnosticLog';
import { resolveObjectiveTarget } from '../director/directorEngine';
import type { AiPassTrace } from '../types/mastering';
import { clearAiChainProvenance, takeAiChainProvenance } from './aiProvenance';

function proc(over: Partial<RawAiProcessor> & { params?: unknown }): RawAiProcessor {
  const { params, ...rest } = over;
  return {
    type: 'compressor',
    name: 'Glue',
    intensity: 100,
    wetDry: 100,
    reason: 'test',
    paramsJson: JSON.stringify(params ?? {}),
    ...rest,
  };
}

const LIMIT_TYPES = Object.keys(PROCESSOR_PARAM_LIMITS).filter((k) => k !== 'module').sort();

test('E2: both response schemas expose type as an enum of every PROCESSOR_PARAM_LIMITS processor, plus enabled/bypassed/rationale and the reason alias', () => {
  assert.deepEqual([...AI_PROCESSOR_TYPES].sort(), LIMIT_TYPES);
  const shared = PROCESSOR_JSON_SCHEMA.properties;
  assert.deepEqual([...shared.type.enum].sort(), LIMIT_TYPES);
  assert.equal(shared.enabled.type, 'boolean');
  assert.equal(shared.bypassed.type, 'boolean');
  assert.equal(shared.rationale.type, 'string');
  assert.equal(shared.reason.type, 'string');
  assert.equal(shared.paramsJson.type, 'string', 'paramsJson stays a JSON string (no nested typed schemas)');
  const server = PROCESSOR_SCHEMA.properties as Record<string, { type: string; enum?: string[] }>;
  assert.deepEqual([...(server.type.enum ?? [])].sort(), LIMIT_TYPES);
  assert.equal(server.enabled.type, 'BOOLEAN');
  assert.equal(server.bypassed.type, 'BOOLEAN');
  assert.equal(server.rationale.type, 'STRING');
  assert.equal(server.reason.type, 'STRING');
  assert.equal(server.paramsJson.type, 'STRING');
});

test('E2: parseAiChain honors enabled/bypassed and carries rationale (reason stays an accepted alias)', () => {
  const { chain, reasoning, paramCorrections } = parseAiChain([
    proc({ name: 'Off comp', enabled: false, rationale: 'kept but switched off: crest already low', params: { thresholdDb: -18, ratio: 2 } }),
    proc({ type: 'limiter', name: 'Lim', bypassed: true, reason: 'legacy reason field', params: { ceilingDb: -1 } }),
    proc({ type: 'saturation', name: 'Sat', params: { drive: 20 } }),
  ]);
  assert.equal(chain[0].enabled, false);
  assert.equal(chain[0].bypassed, false);
  assert.equal(chain[1].bypassed, true);
  assert.equal(chain[1].enabled, true);
  assert.equal(chain[2].enabled, true);
  assert.equal(chain[2].bypassed, false);
  assert.equal(reasoning[0].rationale, 'kept but switched off: crest already low');
  assert.equal(reasoning[0].reason, 'kept but switched off: crest already low');
  assert.equal(reasoning[1].reason, 'legacy reason field');
  assert.equal(reasoning[1].rationale, undefined);
  assert.deepEqual(paramCorrections, [], 'in-range values produce no corrections');
});

test('E2: malformed paramsJson and clamped / reset / unknown values are recorded (module, parameter, AI value, final value)', () => {
  const { chain, paramCorrections } = parseAiChain([
    proc({ name: 'Broken', paramsJson: '{"thresholdDb": -20, ratio: 4' }),
    proc({ name: 'Hot', params: { thresholdDb: -20, ratio: 50, mode: 'sideways', notAParam: 3 } }),
    proc({ type: 'dynamic-eq', name: 'De-Harsh', wetDry: 140, params: { bands: [{ id: 'd1', enabled: true, freq: 3200, q: 2, thresholdDb: -80, maxCutDb: -4, ratio: 3, mode: 'cut', attackMs: 5, releaseMs: 120 }] } }),
  ]);
  assert.equal(chain.length, 3, 'validation and clamping unchanged: the chain still validates');
  const find = (module: RegExp, parameter: string) => paramCorrections.find((c) => module.test(c.module) && c.parameter === parameter);

  const malformed = find(/Broken/, 'paramsJson');
  assert.ok(malformed, 'malformed paramsJson is recorded');
  assert.equal(malformed.kind, 'malformed-json');
  assert.match(malformed.aiValue, /thresholdDb/);

  const ratio = find(/Hot/, 'params.ratio');
  assert.ok(ratio);
  assert.equal(ratio.kind, 'clamped');
  assert.equal(ratio.aiValue, '50');
  assert.equal(ratio.finalValue, String(PROCESSOR_PARAM_LIMITS.compressor.ratio[1]));
  assert.equal(ratio.moduleType, 'compressor');
  assert.equal(ratio.moduleId, chain[1].id);

  assert.equal(find(/Hot/, 'params.mode')?.kind, 'reset');
  assert.equal(find(/Hot/, 'params.notAParam')?.kind, 'dropped', 'an unknown field is no longer silently ignored');
  assert.equal(find(/Hot/, 'params.thresholdDb'), undefined, 'a valid value is not reported');

  assert.equal(find(/De-Harsh/, 'wetDry')?.finalValue, '100');
  const thr = find(/De-Harsh/, 'params.bands[0].thresholdDb');
  assert.ok(thr, 'dynamic EQ band threshold clamp is recorded');
  assert.equal(thr.aiValue, '-80');
  assert.equal(thr.finalValue, String(PROCESSOR_PARAM_LIMITS['dynamic-eq'].band.thresholdDb[0]));
});

test('E2: normalize* (every provider adapter path) parses the new fields and returns the corrections', () => {
  const data = {
    processors: [
      // Some providers send params as an object instead of a JSON string.
      { type: 'compressor', name: 'C', intensity: 100, wetDry: 100, enabled: false, rationale: 'r1', paramsJson: { ratio: 99 } },
      { type: 'limiter', name: 'L', intensity: 100, wetDry: 100, bypassed: true, reason: 'r2', params: { ceilingDb: -1 } },
    ],
  };
  const s = normalizeStrategyResponse(data, { objective: 'streaming', mode: 'ai-auto' });
  assert.equal(s.chain[0].enabled, false);
  assert.equal(s.chain[1].bypassed, true);
  assert.equal(s.reasoningPerProcessor[0].reason, 'r1');
  assert.ok(s.paramCorrections?.some((c) => c.parameter === 'params.ratio' && c.aiValue === '99'));
  const r = normalizeRefineResponse(data, []);
  assert.equal(r.chain[0].enabled, false);
  assert.ok(r.paramCorrections?.some((c) => c.parameter === 'params.ratio'));
  const clean = normalizeRefineResponse({ processors: [{ type: 'limiter', name: 'L', intensity: 100, wetDry: 100, reason: 'ok', paramsJson: '{"ceilingDb":-1}' }] }, []);
  assert.equal(clean.paramCorrections, undefined, 'no corrections key when nothing was changed');
});

test('E2: a BYO provider strategy records its corrections for the Director (provenance registry)', async () => {
  clearAiChainProvenance();
  const sr = 44100;
  const ch = new Float32Array(sr).map((_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / sr));
  const analysis = analyzeAudioBuffer([ch, ch], sr);
  const provider: ProviderConfig = { presetId: 'openai-compatible', model: 'mock', baseUrl: 'https://mock-ai.invalid/v1', apiKey: 'sk-mock-0123456789', agentic: false, timeoutSec: 30 };
  const body = { genre: 'x', musicalStyle: 'x', instrumentationSummary: '', vocalPresence: '', tonalCharacteristics: '', issuesDetected: [], strategySummary: '', targetLufs: -14, targetTruePeakDb: -1, processors: [{ type: 'compressor', name: 'C', intensity: 100, wetDry: 100, reason: 'r', paramsJson: '{"ratio":77}' }] };
  const run = await requestStrategy(provider, { analysis, mode: 'ai-auto', objective: 'streaming' }, async () => { throw new Error('no fallback'); }, {
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const prov = takeAiChainProvenance(run.result!.chain);
  assert.ok(prov, 'AI chain is recorded');
  assert.equal(prov.snapshots.size, 1);
  assert.ok(prov.corrections.some((c) => c.parameter === 'params.ratio' && c.aiValue === '77'));
  assert.equal(takeAiChainProvenance(run.result!.chain), null, 'taking forgets the entry (bounded memory)');
});

test('E2: diagnostic log shows "== AI parameter corrections ==" in text and JSON', () => {
  const sr = 48000;
  const ch = new Float32Array(sr).map((_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / sr));
  const analysis = analyzeAudioBuffer([ch, ch], sr);
  const { paramCorrections } = parseAiChain([proc({ name: 'Hot', params: { ratio: 50 } })]);
  const aiPass: AiPassTrace = {
    pass: 0, stage: 'strategy', source: 'gemini-cloud', fallbackReason: null, modelName: 'm', responseTimeMs: 1, promptChars: 1,
    timeoutHit: null, aiReturnedModules: ['compressor'], finalRenderedModules: ['compressor'], paramCorrections,
  };
  const log = buildDiagnosticLog({ trackName: 't', objective: resolveObjectiveTarget('streaming'), source: analysis, findings: [], chain: [], aiPasses: [aiPass] });
  assert.equal(log.aiParamCorrections.length, 1);
  assert.equal(log.aiParamCorrections[0].parameter, 'params.ratio');
  assert.equal(log.aiParamCorrections[0].aiValue, '50');
  assert.equal(log.aiParamCorrections[0].pass, 0);
  const text = diagnosticLogToText(log);
  assert.match(text, /== AI parameter corrections ==\n  Strategy: compressor #1 \(Hot\) params\.ratio: AI 50 → final 12 \[clamped\]/);
  assert.ok(JSON.parse(JSON.stringify(log)).aiParamCorrections[0].finalValue === '12');

  const cleanLog = buildDiagnosticLog({ trackName: 't', objective: resolveObjectiveTarget('streaming'), source: analysis, findings: [], chain: [], aiPasses: [{ ...aiPass, paramCorrections: undefined }] });
  assert.match(diagnosticLogToText(cleanLog), /== AI parameter corrections ==\n  none/);
});

test('E2: /api/ai/master applies the same objective/mode allowlist as /api/ai/refine', () => {
  const server = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
  const master = server.slice(server.indexOf("app.post('/api/ai/master'"), server.indexOf("app.post('/api/ai/refine'"));
  assert.match(master, /sanitizeMasteringMode\(mode\)/);
  assert.match(master, /sanitizeObjectiveId\(objective\)/);
  assert.match(master, /objective: safeObjective/);
  assert.match(master, /mode: safeMode/);
  assert.doesNotMatch(master, /mode: mode \?\?/);
});
