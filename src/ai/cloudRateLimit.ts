/**
 * Client side of the server's cloud AI spend limits. When the built-in Gemini routes answer
 * 429 the FIX ALL run keeps going on the local DSP planner, the user sees a friendly notice,
 * and the client stops calling the server until the Retry-After time has passed (so a
 * ten-pass run does not send ten more requests that would all be refused).
 */

import type { AiFallbackReason, AiTimeoutHit } from '../types/mastering.ts';
import { isAiUpstreamFailureCode, type AiUpstreamFailureCode } from './aiFailureCodes.ts';

export type CloudAiLimitScope = 'client-minute' | 'client-day' | 'global-day' | 'burst';

export class CloudAiRateLimitError extends Error {
  readonly scope: CloudAiLimitScope;
  readonly retryAfterSec: number;
  /** Set when the server says Gemini itself (not this app's spend limiter) answered 429. */
  readonly upstreamCode: AiUpstreamFailureCode | null;
  constructor(message: string, scope: CloudAiLimitScope, retryAfterSec: number, upstreamCode: AiUpstreamFailureCode | null = null) {
    super(message);
    this.name = 'CloudAiRateLimitError';
    this.scope = scope;
    this.retryAfterSec = retryAfterSec;
    this.upstreamCode = upstreamCode;
  }
}

export class CloudAiHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly fallbackReason: AiFallbackReason;
  readonly timeoutHit: AiTimeoutHit;
  /** The timeout limit (ms) that fired, when timeoutHit is set. */
  readonly timeoutMs: number | null;
  /** Safe short code from the server describing the real upstream failure. */
  readonly upstreamCode: AiUpstreamFailureCode | null;
  constructor(
    message: string,
    opts: {
      status: number;
      code?: string | null;
      fallbackReason: AiFallbackReason;
      timeoutHit?: AiTimeoutHit;
      timeoutMs?: number | null;
      upstreamCode?: AiUpstreamFailureCode | null;
    },
  ) {
    super(message);
    this.name = 'CloudAiHttpError';
    this.status = opts.status;
    this.code = opts.code ?? null;
    this.fallbackReason = opts.fallbackReason;
    this.timeoutHit = opts.timeoutHit ?? null;
    this.timeoutMs = opts.timeoutMs ?? null;
    this.upstreamCode = opts.upstreamCode ?? null;
  }
}

export const CLOUD_AI_TIMEOUT_MS = 70_000;

export interface CloudAiRequestSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  cancelled: () => boolean;
  cleanup: () => void;
}

/**
 * Combines the client's cloud AI timeout (CLOUD_AI_TIMEOUT_MS, longer than the server's
 * GEMINI_TIMEOUT_MS)
 * with an external cancel signal (such as the Stop button) so either aborts the fetch immediately.
 */
export function createCloudAiRequestSignal(
  timeoutMs = CLOUD_AI_TIMEOUT_MS,
  cancelSignal?: AbortSignal,
): CloudAiRequestSignal {
  const controller = new AbortController();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onCancel = () => {
    controller.abort(cancelSignal?.reason);
  };
  if (cancelSignal?.aborted) {
    controller.abort(cancelSignal.reason);
  } else {
    timer = setTimeout(() => {
      expired = true;
      controller.abort(new DOMException(`Cloud AI request timed out after ${Math.round(timeoutMs / 1000)}s.`, 'TimeoutError'));
    }, timeoutMs);
    cancelSignal?.addEventListener('abort', onCancel, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => expired,
    cancelled: () => Boolean(cancelSignal?.aborted && !expired),
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      cancelSignal?.removeEventListener('abort', onCancel);
    },
  };
}

let cooldownUntil = 0;

export function noteCloudAiRateLimited(err: CloudAiRateLimitError, now = Date.now()): void {
  cooldownUntil = Math.max(cooldownUntil, now + err.retryAfterSec * 1000);
}

export function cloudAiCooldownRemainingSec(now = Date.now()): number {
  return Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
}

export function resetCloudAiCooldown(): void {
  cooldownUntil = 0;
}

/** Throws a CloudAiRateLimitError without touching the network while the cooldown is active. */
export function assertCloudAiAvailable(now = Date.now()): void {
  const remaining = cloudAiCooldownRemainingSec(now);
  if (remaining > 0) {
    throw new CloudAiRateLimitError('Cloud AI is cooling down after hitting the server limit.', 'client-minute', remaining);
  }
}

function formatWait(sec: number): string {
  if (sec < 90) return `${sec} s`;
  if (sec < 90 * 60) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}

/** Plain-language notice shown near FIX ALL and in the AI Assistant. */
export function friendlyCloudAiLimitNotice(err: CloudAiRateLimitError): string {
  const wait = formatWait(Math.max(1, err.retryAfterSec));
  if (err.scope === 'global-day') {
    return `Cloud AI has reached this server's daily limit, so FIX ALL used the local DSP planner. Everything was still rendered and verified. Cloud AI is back in about ${wait}.`;
  }
  if (err.scope === 'client-day') {
    return `You've used today's cloud AI allowance, so FIX ALL used the local DSP planner. Everything was still rendered and verified. Cloud AI is back in about ${wait}.`;
  }
  return `Cloud AI is taking a short breather, so FIX ALL used the local DSP planner. Everything was still rendered and verified. Try cloud AI again in about ${wait}.`;
}

function parseScope(value: unknown): CloudAiLimitScope {
  return value === 'client-minute' || value === 'client-day' || value === 'global-day' ? value : 'burst';
}

/** Server's own Gemini timeout when an older server did not send timeoutMs (matches GEMINI_TIMEOUT_MS). */
const LEGACY_SERVER_TIMEOUT_MS = 60_000;

export function classifyBuiltinHttpFailure(
  status: number,
  data: Record<string, unknown>,
  message: string,
): { fallbackReason: AiFallbackReason; timeoutHit: AiTimeoutHit; timeoutMs: number | null; upstreamCode: AiUpstreamFailureCode | null } {
  const code = typeof data.code === 'string' ? data.code : '';
  const upstreamCode = isAiUpstreamFailureCode(data.fallbackDetail) ? data.fallbackDetail : null;
  const none = { timeoutHit: null, timeoutMs: null, upstreamCode } as const;
  if (status === 429 || code === 'ai_rate_limited') return { fallbackReason: '429', ...none };
  if (code === 'missing_key') return { fallbackReason: 'missing-key', ...none };
  if (code === 'guest_session' || status === 401 || status === 403) return { fallbackReason: 'guest-session', ...none };
  if (code === 'ai_timeout' || status === 504) {
    // Our server's own timer fired (explicit 'server', or a legacy 504 with no upstream code).
    const serverTimer = data.timeoutHit === 'server' || (status === 504 && upstreamCode === null);
    const bodyMs = Number(data.timeoutMs);
    return {
      fallbackReason: 'timeout',
      timeoutHit: serverTimer ? 'server' : null,
      timeoutMs: serverTimer ? (Number.isFinite(bodyMs) && bodyMs > 0 ? bodyMs : LEGACY_SERVER_TIMEOUT_MS) : null,
      upstreamCode,
    };
  }
  if (code === 'empty_response' || code === 'safety_block') return { fallbackReason: 'server-error', ...none };
  if (code === 'parse_error' || status === 502) return { fallbackReason: 'parse', ...none };
  if (code === 'validation_error' || status === 422) return { fallbackReason: 'validation', ...none };
  if (status === 503 && /not configured/i.test(message)) return { fallbackReason: 'missing-key', ...none };
  return { fallbackReason: 'server-error', ...none };
}

export interface ClassifiedBuiltinAiError {
  fallbackReason: AiFallbackReason;
  timeoutHit: AiTimeoutHit;
  /** The timeout limit (ms) that fired, when timeoutHit is set. */
  timeoutMs: number | null;
  /** Shown in the banner and diagnostic log: the safe upstream code when the server sent one. */
  fallbackDetail: string;
}

export function classifyBuiltinAiError(
  err: unknown,
  timedOut: boolean,
  clientTimeoutMs: number = CLOUD_AI_TIMEOUT_MS,
): ClassifiedBuiltinAiError {
  const msg = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  const clientTimeout: ClassifiedBuiltinAiError = {
    fallbackReason: 'timeout',
    timeoutHit: 'client',
    timeoutMs: clientTimeoutMs,
    fallbackDetail: `client timeout exceeded (${clientTimeoutMs} ms)`,
  };
  if (timedOut) return clientTimeout;
  if (err instanceof CloudAiRateLimitError) {
    return { fallbackReason: '429', timeoutHit: null, timeoutMs: null, fallbackDetail: err.upstreamCode ?? msg };
  }
  if (err instanceof CloudAiHttpError) {
    const fallbackDetail = err.timeoutHit === 'server' && err.timeoutMs !== null
      ? `${err.upstreamCode ?? 'upstream-timeout'}, server limit ${err.timeoutMs} ms`
      : err.upstreamCode ?? msg;
    return { fallbackReason: err.fallbackReason, timeoutHit: err.timeoutHit, timeoutMs: err.timeoutMs, fallbackDetail };
  }
  if (err instanceof DOMException && err.name === 'TimeoutError') return clientTimeout;
  return { fallbackReason: 'server-error', timeoutHit: null, timeoutMs: null, fallbackDetail: msg };
}

/**
 * Reads a built-in AI route response. Returns the JSON body on success, throws a
 * CloudAiRateLimitError on 429 (and starts the cooldown), and a CloudAiHttpError otherwise.
 */
// The body is validated downstream (normalizeStrategyResponse / inventory validation), as before.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readBuiltinAiResponse(res: Response, now = Date.now()): Promise<Record<string, any>> {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (res.status === 429) {
    const header = Number(res.headers.get('retry-after'));
    const bodyRetry = Number(data.retryAfterSec);
    const retryAfterSec = Math.max(1, Math.ceil(Number.isFinite(bodyRetry) && bodyRetry > 0 ? bodyRetry : Number.isFinite(header) && header > 0 ? header : 60));
    const err = new CloudAiRateLimitError(
      typeof data.error === 'string' ? data.error : 'Cloud AI rate limit reached.',
      parseScope(data.scope),
      retryAfterSec,
      isAiUpstreamFailureCode(data.fallbackDetail) ? data.fallbackDetail : null,
    );
    noteCloudAiRateLimited(err, now);
    throw err;
  }
  if (!res.ok) {
    const message = typeof data.error === 'string' ? data.error : `Server responded ${res.status}`;
    const classified = classifyBuiltinHttpFailure(res.status, data, message);
    throw new CloudAiHttpError(message, {
      status: res.status,
      code: typeof data.code === 'string' ? data.code : null,
      fallbackReason: classified.fallbackReason,
      timeoutHit: classified.timeoutHit,
      timeoutMs: classified.timeoutMs,
      upstreamCode: classified.upstreamCode,
    });
  }
  return data;
}
