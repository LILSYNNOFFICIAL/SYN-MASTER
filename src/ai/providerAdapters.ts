/**
 * Browser-side bring-your-own-AI adapters. Every adapter sends the SAME system prompt and user
 * prompt (src/ai/masteringPrompt.ts), asks for the SAME JSON schema (structured output / JSON mode
 * where the provider supports it), and returns a parsed JSON object that the caller runs through
 * the SAME validation as the built-in Gemini route.
 *
 * Keys: passed in per call, sent only to the provider the user picked, never logged, and scrubbed
 * from every error message (redactSecrets) before it can reach the UI, the diagnostic log or telemetry.
 */
import { getPreset, MAX_AGENT_TIMEOUT_SEC, MIN_TIMEOUT_SEC, type ProviderPreset } from './providerPresets.ts';
import { toGeminiSchema } from './masteringPrompt.ts';
import { checkModelName } from './modelNames.ts';

export interface ProviderConfig {
  presetId: string;
  model: string;
  /** openai-compatible base URL or webhook URL. Ignored by native adapters. */
  baseUrl: string;
  apiKey: string;
  /** Agent mode: long timeout + tolerant JSON. Defaults to the preset's value. */
  agentic: boolean;
  timeoutSec: number;
}

export interface AiCallRequest {
  kind: 'strategy' | 'refine' | 'connection-test';
  systemPrompt: string;
  userPrompt: string;
  /** Structured measurements (only sent to webhook agents, which may want raw numbers). */
  measurements?: unknown;
  schema: unknown;
}

export type ProviderErrorCode = 'config' | 'network' | 'auth' | 'model' | 'http' | 'timeout' | 'cancelled' | 'parse';

export class ProviderError extends Error {
  code: ProviderErrorCode;
  status?: number;
  constructor(code: ProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CallOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_*-]{8,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /gsk_[A-Za-z0-9]{8,}/g,
  /xai-[A-Za-z0-9]{8,}/g,
  /pplx-[A-Za-z0-9]{8,}/g,
  /(Bearer\s+)[^\s"',]+/gi,
  /((?:x-api-key|x-goog-api-key|api[_-]?key|token|password)["']?\s*[:=]\s*["']?)[^\s"',&]+/gi,
];

/** Remove the user's key (and anything that looks like a key or bearer token) from text. */
export function redactSecrets(text: string, secrets: Array<string | undefined | null> = []): string {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, prefix?: string) => (typeof prefix === 'string' ? `${prefix}[redacted]` : '[redacted]'));
  }
  return out;
}

/** Display form of a key: first 3 and last 4 characters only. */
export function maskKey(key: string | undefined | null): string {
  if (!key) return '';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------------------------

function balancedObjects(text: string): string[] {
  const found: string[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          found.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return found;
}

/**
 * Tolerant JSON extraction for chatty models and agents: plain JSON, ```json fences, or prose
 * with JSON inside. Returns the LAST complete top-level object that parses, preferring one that
 * has a "processors" (or "ok") key.
 */
export function extractJsonObject(text: string): Record<string, unknown> {
  const raw = String(text ?? '').trim();
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(raw);
  if (direct) return direct;

  const candidates: string[] = [];
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  for (let m = fence.exec(raw); m; m = fence.exec(raw)) candidates.push(m[1].trim());
  candidates.push(...balancedObjects(raw));

  const parsed = candidates.map(tryParse).filter((v): v is Record<string, unknown> => v !== null);
  // Keep only outermost objects (drop ones nested inside a later/earlier candidate's text is not
  // needed: balancedObjects already scans every start; prefer the last one with the expected key).
  const preferred = parsed.filter((v) => 'processors' in v || 'ok' in v);
  const pick = (preferred.length ? preferred : parsed).at(-1);
  if (!pick) throw new ProviderError('parse', 'The AI reply did not contain a JSON object.');
  return pick;
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------

export function effectiveTimeoutSec(config: ProviderConfig, preset: ProviderPreset = getPreset(config.presetId)): number {
  const max = config.agentic || preset.agentic ? MAX_AGENT_TIMEOUT_SEC : 120;
  const v = Number.isFinite(config.timeoutSec) && config.timeoutSec > 0 ? config.timeoutSec : preset.defaultTimeoutSec;
  return Math.min(max, Math.max(MIN_TIMEOUT_SEC, Math.round(v)));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

async function readErrorDetail(res: Response, secrets: string[]): Promise<string> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  let detail = body;
  try {
    const j = JSON.parse(body);
    detail = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail ?? body;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    /* not JSON */
  }
  return redactSecrets(String(detail).slice(0, 300), secrets);
}

async function doFetch(
  url: string,
  init: RequestInit,
  config: ProviderConfig,
  opts: CallOptions,
): Promise<Response> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = effectiveTimeoutSec(config) * 1000;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new ProviderError('timeout', `No reply from ${hostOf(url)} within ${timeoutMs / 1000} s.`);
    if (opts.signal?.aborted) throw new ProviderError('cancelled', 'Cancelled.');
    // fetch() rejects with a TypeError for CORS blocks, private-network blocks, DNS and refused connections.
    throw new ProviderError(
      'network',
      `Could not reach ${hostOf(url)}. The browser blocked the request (CORS / private-network rules) or the server is not running. ` +
        `Check the URL, that the server is up, and that it allows this app's origin.`,
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

const MODEL_ERROR_RE = /model[^.]{0,80}(not[ _]found|does not exist|not exist|unknown|invalid|not supported|unsupported|not available|no access|deprecated|retired)|(unknown|invalid|unsupported)[ _]model|not_found_error/i;

/** True when an HTTP error is about the model name rather than the URL, key or payload. */
export function looksLikeModelError(status: number, detail: string, nativeEndpoint: boolean): boolean {
  if (status === 404 && nativeEndpoint) return true;
  return (status === 400 || status === 404 || status === 422) && MODEL_ERROR_RE.test(detail);
}

interface ErrorContext {
  /** Model id that was sent, for model errors. */
  model?: string;
  /** Preset default to suggest, for model errors. */
  defaultModel?: string;
  /** The endpoint path is fixed by the adapter, so a 404 can only be the model. */
  nativeEndpoint?: boolean;
}

async function ensureOk(res: Response, url: string, secrets: string[], ctx: ErrorContext = {}): Promise<void> {
  if (res.ok) return;
  const detail = await readErrorDetail(res, secrets);
  // Gemini answers a bad key with HTTP 400 INVALID_ARGUMENT rather than 401.
  if (res.status === 401 || res.status === 403 || (res.status === 400 && /api[ _-]?key (not valid|invalid|is invalid)|invalid (x-)?api[ _-]?key|incorrect api key/i.test(detail))) {
    throw new ProviderError('auth', `${hostOf(url)} rejected the key/token (HTTP ${res.status}). ${detail}`.trim(), res.status);
  }
  if (ctx.model !== undefined && looksLikeModelError(res.status, detail, Boolean(ctx.nativeEndpoint))) {
    const hint =
      ctx.defaultModel && ctx.defaultModel !== ctx.model
        ? ` Check the model name in Settings → AI Provider (the current default is ${ctx.defaultModel}).`
        : ' Check the model name in Settings → AI Provider against the provider\'s model list.';
    throw new ProviderError('model', `${hostOf(url)} does not accept the model "${ctx.model}" (HTTP ${res.status}).${hint} ${detail}`.trim(), res.status);
  }
  if (res.status === 404) {
    throw new ProviderError('http', `${hostOf(url)} returned HTTP 404: the URL was not found. Check the base URL (it usually ends in /v1). ${detail}`.trim(), res.status);
  }
  if (res.status === 429) {
    throw new ProviderError('http', `${hostOf(url)} is rate-limiting or out of quota (HTTP 429). Wait and retry, or check the account's billing/limits. ${detail}`.trim(), res.status);
  }
  throw new ProviderError('http', `${hostOf(url)} returned HTTP ${res.status}. ${detail}`.trim(), res.status);
}

// ---------------------------------------------------------------------------------------------
// Request shaping (exported for tests)
// ---------------------------------------------------------------------------------------------

export interface ShapedRequest {
  url: string;
  init: RequestInit & { headers: Record<string, string>; body: string };
}

const ANTHROPIC_TOOL = 'submit_mastering_strategy';
const ANTHROPIC_TOOL_INSTRUCTION = `Return your answer by calling the ${ANTHROPIC_TOOL} tool once with the complete JSON decision. Do not answer in prose.`;

export function shapeRequest(config: ProviderConfig, req: AiCallRequest, opts: { withResponseFormat?: boolean } = {}): ShapedRequest {
  const preset = getPreset(config.presetId);
  const model = checkModelName(config.presetId, config.model).model || config.model.trim() || preset.defaultModel;
  const withFormat = opts.withResponseFormat !== false;
  switch (preset.adapter) {
    case 'gemini': {
      const base = preset.defaultBaseUrl!;
      return {
        url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
        init: {
          method: 'POST',
          // Header (not ?key=) so the key never appears in URLs, history or logs.
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: req.systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: req.userPrompt }] }],
            generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(req.schema) },
          }),
        },
      };
    }
    case 'anthropic': {
      return {
        url: `${preset.defaultBaseUrl}/messages`,
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model,
            max_tokens: 8192,
            system: req.systemPrompt,
            messages: [{ role: 'user', content: `${req.userPrompt}\n\n${ANTHROPIC_TOOL_INSTRUCTION}` }],
            // Structured output via a tool whose input_schema is the strategy schema. tool_choice stays
            // "auto": current Claude models (Sonnet 5.5, Opus 5.5, ...) reject a forced tool_choice with
            // HTTP 400, so the prompt asks for the tool and the parser also accepts a plain JSON reply.
            tools: [{ name: ANTHROPIC_TOOL, description: 'Return the mastering decision as structured JSON. Always call this exactly once with the complete decision.', input_schema: req.schema }],
            tool_choice: { type: 'auto' },
          }),
        },
      };
    }
    case 'openai':
    case 'openai-compatible': {
      const base = preset.adapter === 'openai' ? preset.defaultBaseUrl! : (config.baseUrl.trim() || preset.defaultBaseUrl || '');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      const jsonHint =
        '\n\nRespond with ONLY one JSON object that matches this JSON Schema (no prose, no code fences):\n' +
        JSON.stringify(req.schema);
      const promptOnly = !withFormat || preset.jsonMode === 'none';
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: promptOnly || preset.jsonMode === 'json_object' ? req.userPrompt + jsonHint : req.userPrompt },
        ],
      };
      if (!promptOnly) {
        body.response_format =
          preset.jsonMode === 'json_object'
            ? { type: 'json_object' }
            : { type: 'json_schema', json_schema: { name: 'mastering_strategy', schema: req.schema, strict: false } };
      }
      return { url: joinUrl(base, '/chat/completions'), init: { method: 'POST', headers, body: JSON.stringify(body) } };
    }
    case 'webhook': {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      return {
        url: config.baseUrl.trim(),
        init: {
          method: 'POST',
          headers,
          body: JSON.stringify({
            app: 'syn-master',
            schemaVersion: 1,
            kind: req.kind,
            systemPrompt: req.systemPrompt,
            userPrompt: req.userPrompt,
            measurements: req.measurements ?? null,
            responseSchema: req.schema,
          }),
        },
      };
    }
    default:
      throw new ProviderError('config', 'The built-in provider is called through the app server, not an adapter.');
  }
}

// ---------------------------------------------------------------------------------------------
// Response parsing (exported for tests)
// ---------------------------------------------------------------------------------------------

function textFromWebhook(payload: unknown): Record<string, unknown> {
  if (typeof payload === 'string') return extractJsonObject(payload);
  if (!payload || typeof payload !== 'object') throw new ProviderError('parse', 'The webhook returned no JSON object.');
  const obj = (Array.isArray(payload) ? payload[0] : payload) as Record<string, unknown>;
  if (obj && typeof obj === 'object') {
    if ('processors' in obj || 'ok' in obj) return obj;
    for (const k of ['strategy', 'suggestion', 'result', 'data', 'output', 'json', 'response', 'text', 'content']) {
      const v = obj[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) return textFromWebhook(v);
      if (typeof v === 'string' && v.includes('{')) return extractJsonObject(v);
    }
  }
  throw new ProviderError('parse', 'The webhook reply did not contain the suggestion JSON.');
}

export function parseProviderResponse(config: ProviderConfig, payload: unknown): Record<string, unknown> {
  const preset = getPreset(config.presetId);
  const p = payload as Record<string, any>;
  switch (preset.adapter) {
    case 'gemini': {
      if (p?.promptFeedback?.blockReason) throw new ProviderError('parse', `Gemini blocked the request (blockReason: ${String(p.promptFeedback.blockReason)}).`);
      const parts: Array<{ text?: string; thought?: boolean }> = p?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.filter((x) => typeof x.text === 'string' && !x.thought).map((x) => x.text).join('');
      if (!text) {
        const reason = p?.candidates?.[0]?.finishReason ?? 'unknown';
        const hint = reason === 'MAX_TOKENS' ? ' The reply hit the output-token limit.' : '';
        throw new ProviderError('parse', `Gemini returned no text (finishReason: ${reason}).${hint}`);
      }
      return extractJsonObject(text);
    }
    case 'anthropic': {
      const blocks: Array<{ type: string; name?: string; input?: unknown; text?: string }> = p?.content ?? [];
      const tool = blocks.find((b) => b.type === 'tool_use' && b.name === ANTHROPIC_TOOL);
      if (tool && tool.input && typeof tool.input === 'object') return tool.input as Record<string, unknown>;
      if (p?.stop_reason === 'refusal') throw new ProviderError('parse', 'Claude declined to answer (stop_reason: refusal).');
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      if (!text.trim()) {
        const hint = p?.stop_reason === 'max_tokens' ? ' The reply hit max_tokens before the JSON was written.' : '';
        throw new ProviderError('parse', `Claude returned no tool call or text (stop_reason: ${p?.stop_reason ?? 'unknown'}).${hint}`);
      }
      return extractJsonObject(text);
    }
    case 'openai':
    case 'openai-compatible': {
      const msg = p?.choices?.[0]?.message;
      let content: unknown = msg?.content;
      if (Array.isArray(content)) content = content.map((c: { text?: string }) => c?.text ?? '').join('');
      if (typeof content !== 'string' || !content.trim()) {
        if (msg?.refusal) throw new ProviderError('parse', `The model refused: ${String(msg.refusal).slice(0, 200)}`);
        const finish = p?.choices?.[0]?.finish_reason;
        const hint = finish === 'length' ? ' The reply hit the output-token limit (finish_reason: length).' : finish ? ` (finish_reason: ${finish})` : '';
        throw new ProviderError('parse', `The model returned an empty message.${hint}`);
      }
      return extractJsonObject(content);
    }
    case 'webhook':
      return textFromWebhook(payload);
    default:
      throw new ProviderError('config', 'Unsupported adapter.');
  }
}

function looksLikeResponseFormatRejection(status: number, detail: string): boolean {
  return (status === 400 || status === 422) && /response_format|json_schema|json_object|json mode|structured/i.test(detail);
}

// ---------------------------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------------------------

export function validateConfig(config: ProviderConfig): string | null {
  const preset = getPreset(config.presetId);
  if (preset.adapter === 'builtin-gemini') return null;
  if (preset.key === 'required' && !config.apiKey.trim()) return `${preset.label} needs ${preset.keyLabel ?? 'an API key'}.`;
  if ((preset.adapter === 'openai-compatible' || preset.adapter === 'webhook') && preset.baseUrlEditable) {
    const url = config.baseUrl.trim() || preset.defaultBaseUrl || '';
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The URL must start with http:// or https://.';
      if (!u.hostname) return 'Enter a full URL.';
    } catch {
      return 'Enter a full URL (for example https://host/v1).';
    }
  }
  if (preset.adapter === 'openai-compatible' && !(config.model.trim() || preset.defaultModel)) return 'Enter a model name.';
  const modelCheck = checkModelName(config.presetId, config.model);
  if (modelCheck.level === 'error') return modelCheck.message ?? 'Check the model name.';
  return null;
}

/** Non-blocking model notice (deprecated id, redirected slug), or null. */
export function modelWarning(config: ProviderConfig): string | null {
  const preset = getPreset(config.presetId);
  if (preset.adapter === 'builtin-gemini') return null;
  const c = checkModelName(config.presetId, config.model);
  return c.level === 'warning' ? (c.message ?? null) : null;
}

/** Send one request to the configured provider and return the extracted JSON object. */
export async function callProvider(config: ProviderConfig, req: AiCallRequest, opts: CallOptions = {}): Promise<Record<string, unknown>> {
  const problem = validateConfig(config);
  if (problem) throw new ProviderError('config', problem);
  const preset = getPreset(config.presetId);
  const secrets = [config.apiKey];
  let shaped = shapeRequest(config, req);
  let res = await doFetch(shaped.url, shaped.init, config, opts);
  if (!res.ok && preset.adapter === 'openai-compatible' && preset.jsonMode !== 'none') {
    const detail = await readErrorDetail(res.clone(), secrets);
    if (looksLikeResponseFormatRejection(res.status, detail)) {
      // Some servers (LM Studio, older Ollama, some gateways) reject response_format: retry with JSON-by-prompt.
      shaped = shapeRequest(config, req, { withResponseFormat: false });
      res = await doFetch(shaped.url, shaped.init, config, opts);
    }
  }
  await ensureOk(res, shaped.url, secrets, {
    model: preset.adapter === 'webhook' ? undefined : checkModelName(config.presetId, config.model).model,
    defaultModel: preset.defaultModel || undefined,
    nativeEndpoint: preset.adapter === 'gemini' || preset.adapter === 'openai' || preset.adapter === 'anthropic' || preset.id === 'xai',
  });
  let payload: unknown;
  const text = await res.text();
  try {
    payload = JSON.parse(text);
  } catch {
    if (preset.adapter === 'webhook') payload = text;
    else throw new ProviderError('parse', `${hostOf(shaped.url)} did not return JSON.`);
  }
  try {
    return parseProviderResponse(config, payload);
  } catch (err) {
    if (err instanceof ProviderError) throw new ProviderError(err.code, redactSecrets(err.message, secrets), err.status);
    throw err;
  }
}

/** GET {baseUrl}/models for OpenAI-compatible servers (OpenClaw, Ollama, LM Studio, ...). */
export async function listModels(config: ProviderConfig, opts: CallOptions = {}): Promise<string[]> {
  const preset = getPreset(config.presetId);
  if (preset.adapter !== 'openai-compatible') return [];
  const base = config.baseUrl.trim() || preset.defaultBaseUrl || '';
  const headers: Record<string, string> = {};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const url = joinUrl(base, '/models');
  const res = await doFetch(url, { method: 'GET', headers }, { ...config, timeoutSec: 10, agentic: false }, opts);
  await ensureOk(res, url, [config.apiKey]);
  const data = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string; name?: string }> };
  const list = data.data ?? data.models ?? [];
  return list.map((m) => String((m as { id?: string; name?: string }).id ?? (m as { name?: string }).name ?? '')).filter(Boolean);
}

/** Human-readable description for logs/telemetry. Never includes the key. */
export function describeProvider(config: ProviderConfig): { id: string; label: string; model: string; host: string | null; agentic: boolean } {
  const preset = getPreset(config.presetId);
  const editable = preset.adapter === 'openai-compatible' || preset.adapter === 'webhook';
  return {
    id: preset.id,
    label: preset.label,
    model: preset.adapter === 'builtin-gemini' ? 'server default' : config.model.trim() || preset.defaultModel,
    host: preset.adapter === 'builtin-gemini' ? null : hostOf(editable ? config.baseUrl || preset.defaultBaseUrl || '' : preset.defaultBaseUrl || ''),
    agentic: preset.adapter !== 'builtin-gemini' && (config.agentic || preset.agentic),
  };
}
