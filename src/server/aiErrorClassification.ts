/**
 * Turns any error thrown by the built-in Gemini routes into a safe HTTP response.
 * The body carries a fixed, human-readable message plus a short `fallbackDetail` code
 * (see src/ai/aiFailureCodes.ts). It never includes the API key, the request body,
 * the upstream response body or a stack trace.
 */
import type { AiUpstreamFailureCode } from '../ai/aiFailureCodes.ts';
import { AiValidationError } from '../ai/masteringPrompt.ts';
import { AiConfigError, AiTimeoutError, AiUpstreamResponseError, GEMINI_TIMEOUT_MS } from './aiMastering.ts';

export interface SanitizedAiErrorBody {
  error: string;
  code: string;
  fallbackDetail?: AiUpstreamFailureCode;
  timeoutHit?: 'server';
  timeoutMs?: number;
}

export interface SanitizedAiErrorResponse {
  status: number;
  body: SanitizedAiErrorBody;
  /** One-line, key-redacted text for the server console (no stack). */
  logLine: string | null;
}

function upstreamStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function redact(msg: string): string {
  return msg.replace(/key=[^&\s"']+/gi, 'key=***').replace(/AIza[0-9A-Za-z_-]{10,}/g, '***').slice(0, 200);
}

/** Classifies a non-local upstream failure (SDK ApiError, network error, ...) into a safe code. */
export function classifyUpstreamAiFailure(err: unknown): AiUpstreamFailureCode {
  if (err instanceof AiTimeoutError) return 'upstream-timeout';
  if (err instanceof AiUpstreamResponseError) return err.failureCode;
  if (err instanceof SyntaxError) return 'json-parse';
  if (err instanceof AiValidationError) return 'schema-validation';
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const status = upstreamStatus(err);
  if (/SAFETY|PROHIBITED_CONTENT|BLOCKLIST|blockReason/i.test(msg)) return 'upstream-safety-block';
  if (status === 429 || /\b429\b|RESOURCE_EXHAUSTED|quota|rate.*limit/i.test(msg)) return 'upstream-429';
  if (status === 504 || /DEADLINE_EXCEEDED|ETIMEDOUT|timed? ?out/i.test(msg)) return 'upstream-timeout';
  if ((status !== null && status >= 500 && status <= 599) || /\b50[0-9]\b|UNAVAILABLE|INTERNAL|high demand|overloaded/i.test(msg)) {
    return 'upstream-5xx';
  }
  return 'unknown';
}

export function buildSanitizedAiErrorResponse(err: unknown): SanitizedAiErrorResponse {
  if (err instanceof AiConfigError) {
    return { status: 503, body: { error: err.message, code: 'missing_key' }, logLine: null };
  }
  const fallbackDetail = classifyUpstreamAiFailure(err);
  const rawMsg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const logLine = `[SYN-AI] Endpoint error (${fallbackDetail}): ${redact(rawMsg) || 'no message'}`;
  if (err instanceof AiTimeoutError) {
    return {
      status: 504,
      body: {
        error: `Cloud AI did not answer within the server's ${GEMINI_TIMEOUT_MS / 1000} s limit.`,
        code: 'ai_timeout',
        fallbackDetail,
        timeoutHit: 'server',
        timeoutMs: GEMINI_TIMEOUT_MS,
      },
      logLine,
    };
  }
  if (err instanceof AiValidationError) {
    return { status: 422, body: { error: err.message, code: 'validation_error', fallbackDetail }, logLine };
  }
  switch (fallbackDetail) {
    case 'json-parse':
      return { status: 502, body: { error: 'AI returned malformed strategy JSON.', code: 'parse_error', fallbackDetail }, logLine };
    case 'empty-response':
      return { status: 502, body: { error: 'Cloud AI returned an empty response.', code: 'empty_response', fallbackDetail }, logLine };
    case 'upstream-safety-block':
      return { status: 502, body: { error: 'Cloud AI declined to answer (safety filter).', code: 'safety_block', fallbackDetail }, logLine };
    case 'upstream-429':
      return { status: 429, body: { error: 'Cloud AI rate limit reached. Retrying or using local DSP.', code: 'ai_rate_limited', fallbackDetail }, logLine };
    case 'upstream-5xx':
      return { status: 503, body: { error: 'Cloud AI model is temporarily experiencing high demand. Please try again shortly.', code: 'server_error', fallbackDetail }, logLine };
    case 'upstream-timeout':
      // Gemini's own deadline (not this server's timer), so no timeoutHit/timeoutMs.
      return { status: 504, body: { error: 'Cloud AI timed out upstream.', code: 'ai_timeout', fallbackDetail }, logLine };
    default:
      return { status: 500, body: { error: 'AI mastering service could not complete the request.', code: 'server_error', fallbackDetail: 'unknown' }, logLine };
  }
}
