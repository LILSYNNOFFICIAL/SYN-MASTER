/**
 * Client side of the server's cloud AI spend limits. When the built-in Gemini routes answer
 * 429 the FIX ALL run keeps going on the local DSP planner, the user sees a friendly notice,
 * and the client stops calling the server until the Retry-After time has passed (so a
 * ten-pass run does not send ten more requests that would all be refused).
 */

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

/**
 * Reads a built-in AI route response. Returns the JSON body on success, throws a
 * CloudAiRateLimitError on 429 (and starts the cooldown), and a plain Error otherwise.
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
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `Server responded ${res.status}`);
  return data;
}
