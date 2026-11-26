import { createRateLimiter } from './requestLimiter.mjs';

/**
 * Budget guard for the server routes that spend the owner's GEMINI_API_KEY.
 * Cloud AI is on by default for FIX ALL, so every run can bill the owner. This sits
 * behind the generic /api/ai limiter and the access guard and adds:
 *   - per-client strategy calls per minute (POST /api/ai/master)
 *   - per-client refine calls per minute (POST /api/ai/refine)
 *   - per-client strategy calls per day and spending calls per day
 *   - one global spending cap per day for the whole server process
 * All checks run before any budget is consumed, so a rejected call never spends another
 * limit. State is process-local, like the existing limiter.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export const AI_SPEND_DEFAULTS = Object.freeze({
  strategyPerMinute: 3,
  refinePerMinute: 12,
  strategyPerDay: 40,
  clientPerDay: 250,
  globalPerDay: 2000,
});

const ENV_NAMES = Object.freeze({
  strategyPerMinute: 'SYN_AI_STRATEGY_PER_MINUTE',
  refinePerMinute: 'SYN_AI_REFINE_PER_MINUTE',
  strategyPerDay: 'SYN_AI_STRATEGY_PER_DAY',
  clientPerDay: 'SYN_AI_CLIENT_PER_DAY',
  globalPerDay: 'SYN_AI_GLOBAL_PER_DAY',
});

/** Reads limits from the environment; invalid or missing values keep the defaults. */
export function readAiSpendLimitsFromEnv(env = process.env) {
  const limits = { ...AI_SPEND_DEFAULTS };
  for (const [key, name] of Object.entries(ENV_NAMES)) {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 1 && value <= 1_000_000) limits[key] = value;
  }
  return limits;
}

const MESSAGES = {
  'client-minute': 'Cloud AI is cooling down for a moment. FIX ALL keeps working with the local DSP planner.',
  'client-day': 'You have used today\'s cloud AI allowance on this server. FIX ALL keeps working with the local DSP planner.',
  'global-day': 'This server has used today\'s shared cloud AI allowance. FIX ALL keeps working with the local DSP planner.',
};

/**
 * @param {{ limits?: Partial<typeof AI_SPEND_DEFAULTS>, now?: () => number, maxKeys?: number }} [options]
 */
export function createAiSpendLimiter(options = {}) {
  const limits = { ...AI_SPEND_DEFAULTS, ...(options.limits ?? {}) };
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 50_000;
  const strategyMinute = createRateLimiter({ limit: limits.strategyPerMinute, windowMs: MINUTE_MS, now, maxKeys });
  const refineMinute = createRateLimiter({ limit: limits.refinePerMinute, windowMs: MINUTE_MS, now, maxKeys });
  const strategyDay = createRateLimiter({ limit: limits.strategyPerDay, windowMs: DAY_MS, now, maxKeys });
  const clientDay = createRateLimiter({ limit: limits.clientPerDay, windowMs: DAY_MS, now, maxKeys });
  const globalDay = createRateLimiter({ limit: limits.globalPerDay, windowMs: DAY_MS, now, maxKeys: 1 });

  /**
   * @param {string} clientKey usually the client IP
   * @param {'strategy' | 'refine'} kind
   */
  function consume(clientKey, kind) {
    const key = String(clientKey || 'unknown');
    const checks = kind === 'strategy'
      ? [['client-minute', strategyMinute, key], ['client-day', strategyDay, key], ['client-day', clientDay, key], ['global-day', globalDay, 'global']]
      : [['client-minute', refineMinute, key], ['client-day', clientDay, key], ['global-day', globalDay, 'global']];
    for (const [scope, limiter, limiterKey] of checks) {
      const result = limiter.peek(limiterKey);
      if (!result.allowed) {
        return {
          allowed: false,
          scope,
          limit: limiter.limit,
          retryAfterMs: Math.max(1000, result.retryAfterMs),
          message: MESSAGES[scope],
        };
      }
    }
    let remaining = Infinity;
    for (const [, limiter, limiterKey] of checks) {
      const result = limiter(limiterKey);
      if (!result.allowed) {
        // Only reachable when the key table is full; fail closed.
        return { allowed: false, scope: 'global-day', limit: limiter.limit, retryAfterMs: Math.max(1000, result.retryAfterMs), message: MESSAGES['global-day'] };
      }
      remaining = Math.min(remaining, result.remaining);
    }
    return { allowed: true, remaining, retryAfterMs: 0 };
  }

  return { consume, limits };
}

/** Express middleware: counts POSTs to the spending routes and answers 429 when a cap is hit. */
export function createAiSpendMiddleware(limiter, { routes = { '/master': 'strategy', '/refine': 'refine' } } = {}) {
  return function aiSpendGuard(req, res, next) {
    // Express routing is case-insensitive and ignores a trailing slash, so normalise the
    // same way or '/MASTER/' would reach the handler without being counted.
    const routePath = String(req.path || '').toLowerCase().replace(/\/+$/, '');
    const kind = req.method === 'POST' && Object.hasOwn(routes, routePath) ? routes[routePath] : undefined;
    if (!kind) return next();
    const sessionId = String(res.locals?.guestSessionId ?? '');
    if (!sessionId) {
      res.status(401).json({ error: 'A valid Cloud AI guest session is required.' });
      return;
    }
    const result = limiter.consume(sessionId, kind);
    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      req.resume?.();
      res.status(429).json({
        error: result.message,
        code: 'ai_rate_limited',
        scope: result.scope,
        retryAfterSec,
        fallback: 'local-dsp-planner',
      });
      return;
    }
    res.setHeader('X-AI-Budget-Remaining', String(result.remaining));
    next();
  };
}
