/**
 * Client side of the server's cloud AI spend limits. When the built-in Gemini routes answer
 * 429 the FIX ALL run keeps going on the local DSP planner, the user sees a friendly notice,
 * and the client stops calling the server until the Retry-After time has passed (so a
 * ten-pass run does not send ten more requests that would all be refused).
 */

import type { AiFallbackReason, AiTimeoutHit } from '../types/mastering.ts';

export type CloudAiLimitScope = 'client-minute' | 'client-day' | 'global-day' | 'burst';

export class CloudAiRateLimitError extends Error {
  readonly scope: CloudAiLimitScope;
  readonly retryAfterSec: number;
  constructor(message: string, scope: CloudAiLimitScope, retryAfterSec: number) {
    super(message);
    this.name = 'CloudAiRateLimitError';
    this.scope = scope;
    this.retryAfterSec = retryAfterSec;
  }
}

export class CloudAiHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly fallbackReason: AiFallbackReason;
  readonly timeoutHit: AiTimeoutHit;
  constructor(
    message: string,
    opts: {
      status: number;
      code?: string | null;
      fallbackReason: AiFallbackReason;
      timeoutHit?: AiTimeoutHit;
    },
  ) {
    super(message);
    this.name = 'CloudAiHttpError';
    this.status = opts.status;
    this.code = opts.code ?? null;
    this.fallbackReason = opts.fallbackReason;
    this.timeoutHit = opts.timeoutHit ?? null;
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
 * Combines the client's 30 s cloud AI timeout (longer than the server's 25 s Gemini timeout)
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

export function classifyBuiltinHttpFailure(
  status: number,
  data: Record<string, unknown>,
  message: string,
): { fallbackReason: AiFallbackReason; timeoutHit: AiTimeoutHit } {
  const code = typeof data.code === 'string' ? data.code : '';
  if (status === 429 || code === 'ai_rate_limited') return { fallbackReason: '429', timeoutHit: null };
  if (code === 'missing_key') return { fallbackReason: 'missing-key', timeoutHit: null };
  if (code === 'guest_session' || status === 401 || status === 403) return { fallbackReason: 'guest-session', timeoutHit: null };
  if (code === 'ai_timeout' || status === 504) return { fallbackReason: 'timeout', timeoutHit: data.timeoutHit === 'server-25s' || status === 504 ? 'server-25s' : null };
  if (code === 'parse_error' || status === 502) return { fallbackReason: 'parse', timeoutHit: null };
  if (code === 'validation_error' || status === 422) return { fallbackReason: 'validation', timeoutHit: null };
  if (status === 503 && /not configured/i.test(message)) return { fallbackReason: 'missing-key', timeoutHit: null };
  return { fallbackReason: 'server-error', timeoutHit: null };
}

export function classifyBuiltinAiError(
  err: unknown,
  timedOut: boolean,
): { fallbackReason: AiFallbackReason; timeoutHit: AiTimeoutHit; fallbackDetail: string } {
  const msg = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  if (timedOut) {
    return { fallbackReason: 'timeout', timeoutHit: 'client-30s', fallbackDetail: 'client 30s timeout exceeded' };
  }
  if (err instanceof CloudAiRateLimitError) {
    return { fallbackReason: '429', timeoutHit: null, fallbackDetail: msg };
  }
  if (err instanceof CloudAiHttpError) {
    return { fallbackReason: err.fallbackReason, timeoutHit: err.timeoutHit, fallbackDetail: msg };
  }
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return { fallbackReason: 'timeout', timeoutHit: 'client-30s', fallbackDetail: msg };
  }
  return { fallbackReason: 'server-error', timeoutHit: null, fallbackDetail: msg };
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
    });
  }
  return data;
}
