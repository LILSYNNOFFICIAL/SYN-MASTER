/**
 * Routes the AI *suggestion* step to the active provider. The verification loop (render,
 * re-measure, objective gate, pass/fail) lives in the director and never sees which provider
 * made a suggestion: a provider can only propose a chain; it can never mark a pass as done.
 *
 * Built-in Gemini (the default) is called exactly as before through the app server.
 * Any other provider: same prompts, same schema, same validation; on any failure the pass falls
 * back to built-in Gemini and a notice says why. Cancelling skips AI for that step instead.
 */
import {
  AiValidationError,
  SYSTEM_PROMPT,
  STRATEGY_JSON_SCHEMA,
  buildRefineUserPrompt,
  buildStrategyUserPrompt,
  normalizeRefineResponse,
  normalizeStrategyResponse,
  parseAiChain,
  PROCESSOR_JSON_SCHEMA,
  type RefinePromptInput,
  type StrategyPromptInput,
} from './masteringPrompt.ts';
import { callProvider, describeProvider, modelWarning, ProviderError, redactSecrets, type CallOptions, type ProviderConfig } from './providerAdapters.ts';
import { BUILTIN_PROVIDER_ID, getPreset } from './providerPresets.ts';
import type { ProcessorType } from '../types/mastering.ts';

export const BUILTIN_LABEL = 'Built-in Gemini';

export interface ProviderCallMeta {
  source: 'gemini-cloud' | 'byo-provider';
  modelName: string | null;
  responseTimeMs: number | null;
  promptChars: number | null;
  aiReturnedModules: ProcessorType[];
}

export interface ProviderRunResult<T> {
  result: T | null;
  /** Label of the provider whose output was used (null when none was). */
  producedBy: string | null;
  notices: string[];
  fellBack: boolean;
  cancelled: boolean;
  meta?: ProviderCallMeta;
}

type StrategyResult = ReturnType<typeof normalizeStrategyResponse>;
type RefineResult = ReturnType<typeof normalizeRefineResponse>;

function errorText(err: unknown, config: ProviderConfig): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(msg, [config.apiKey]);
}

function rawModuleTypesFromPayload(data: Record<string, unknown>): ProcessorType[] {
  if (!Array.isArray(data.processors)) return [];
  return data.processors
    .map((p) => (p && typeof p === 'object' ? String((p as { type?: unknown }).type ?? '') : ''))
    .filter(Boolean) as ProcessorType[];
}

async function runWithFallback<T>(
  config: ProviderConfig,
  userPrompt: string,
  viaProvider: () => Promise<{ normalized: T; aiReturnedModules: ProcessorType[] }>,
  viaBuiltin: () => Promise<T>,
): Promise<ProviderRunResult<T>> {
  const preset = getPreset(config.presetId);
  const promptChars = SYSTEM_PROMPT.length + userPrompt.length;
  if (preset.id === BUILTIN_PROVIDER_ID) {
    const startedMs = performance.now();
    const result = await viaBuiltin();
    return {
      result,
      producedBy: BUILTIN_LABEL,
      notices: [],
      fellBack: false,
      cancelled: false,
      meta: {
        source: 'gemini-cloud',
        modelName: null,
        responseTimeMs: Math.max(0, Math.round(performance.now() - startedMs)),
        promptChars,
        aiReturnedModules: [],
      },
    };
  }
  const modelName = describeProvider(config).model;
  const label = `${preset.label} (${modelName})`;
  const warning = modelWarning(config);
  const baseNotices = warning ? [`${label}: ${warning}`] : [];
  const startedMs = performance.now();
  try {
    const out = await viaProvider();
    return {
      result: out.normalized,
      producedBy: label,
      notices: baseNotices,
      fellBack: false,
      cancelled: false,
      meta: {
        source: 'byo-provider',
        modelName,
        responseTimeMs: Math.max(0, Math.round(performance.now() - startedMs)),
        promptChars,
        aiReturnedModules: out.aiReturnedModules,
      },
    };
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'cancelled') {
      return { result: null, producedBy: null, notices: [...baseNotices, `${label}: cancelled by user; AI suggestion skipped for this step.`], fellBack: false, cancelled: true };
    }
    const kind = err instanceof AiValidationError || (err instanceof ProviderError && err.code === 'parse') ? 'output failed validation' : 'request failed';
    const notice = `${label} ${kind}: ${errorText(err, config)} Falling back to ${BUILTIN_LABEL} for this pass.`;
    const builtinStartedMs = performance.now();
    const result = await viaBuiltin();
    return {
      result,
      producedBy: BUILTIN_LABEL,
      notices: [...baseNotices, notice],
      fellBack: true,
      cancelled: false,
      meta: {
        source: 'gemini-cloud',
        modelName: null,
        responseTimeMs: Math.max(0, Math.round(performance.now() - builtinStartedMs)),
        promptChars,
        aiReturnedModules: [],
      },
    };
  }
}

export async function requestStrategy(
  config: ProviderConfig,
  input: StrategyPromptInput,
  builtin: () => Promise<StrategyResult>,
  opts: CallOptions = {},
): Promise<ProviderRunResult<StrategyResult>> {
  const userPrompt = buildStrategyUserPrompt(input);
  return runWithFallback(
    config,
    userPrompt,
    async () => {
      const data = await callProvider(
        config,
        { kind: 'strategy', systemPrompt: SYSTEM_PROMPT, userPrompt, measurements: input, schema: STRATEGY_JSON_SCHEMA },
        opts,
      );
      return {
        normalized: normalizeStrategyResponse(data, input),
        aiReturnedModules: rawModuleTypesFromPayload(data),
      };
    },
    builtin,
  );
}

export async function requestRefine(
  config: ProviderConfig,
  input: RefinePromptInput,
  builtin: () => Promise<RefineResult>,
  opts: CallOptions = {},
): Promise<ProviderRunResult<RefineResult>> {
  const userPrompt = buildRefineUserPrompt(input);
  return runWithFallback(
    config,
    userPrompt,
    async () => {
      const data = await callProvider(
        config,
        { kind: 'refine', systemPrompt: SYSTEM_PROMPT, userPrompt, measurements: input, schema: STRATEGY_JSON_SCHEMA },
        opts,
      );
      return {
        normalized: normalizeRefineResponse(data, input.currentChain),
        aiReturnedModules: rawModuleTypesFromPayload(data),
      };
    },
    builtin,
  );
}

/** Tiny validated round-trip for the "Test connection" button. */
export async function testProviderConnection(config: ProviderConfig, opts: CallOptions = {}): Promise<{ ok: true; message: string } | { ok: false; message: string; code: string }> {
  const preset = getPreset(config.presetId);
  if (preset.id === BUILTIN_PROVIDER_ID) return { ok: true, message: 'Built-in Gemini runs on the app server.' };
  const started = Date.now();
  try {
    const data = await callProvider(
      config,
      {
        kind: 'connection-test',
        systemPrompt: 'You are a connectivity check for SYN MASTER. Reply with JSON only.',
        userPrompt: 'Return exactly {"ok": true, "processors": []}',
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, processors: { type: 'array', items: PROCESSOR_JSON_SCHEMA } }, required: ['ok', 'processors'] },
      },
      opts,
    );
    if (data.ok !== true) throw new ProviderError('parse', 'Reply was JSON but "ok" was not true.');
    parseAiChain(Array.isArray(data.processors) ? (data.processors as Parameters<typeof parseAiChain>[0]) : []);
    const warning = modelWarning(config);
    return { ok: true, message: `Connected: valid JSON reply in ${((Date.now() - started) / 1000).toFixed(1)} s.${warning ? ` Warning: ${warning}` : ''}` };
  } catch (err) {
    const code = err instanceof ProviderError ? err.code : 'parse';
    const prefix: Record<string, string> = {
      network: 'Network / CORS blocked',
      auth: 'Key or token rejected',
      model: 'Model not accepted',
      timeout: 'Timed out',
      http: 'Server error',
      parse: 'Reply was not valid JSON',
      config: 'Settings incomplete',
      cancelled: 'Cancelled',
    };
    return { ok: false, code, message: `${prefix[code] ?? 'Failed'}: ${errorText(err, config)}` };
  }
}
