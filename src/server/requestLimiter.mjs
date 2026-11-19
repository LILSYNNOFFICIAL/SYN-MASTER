/**
 * Small in-memory fixed-window limiter for protecting expensive AI endpoints.
 * State is process-local: use an external shared limiter if the app is scaled
 * across multiple instances.
 */
export function createRateLimiter({ limit = 20, windowMs = 60_000, now = Date.now } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
  if (!Number.isFinite(windowMs) || windowMs < 1) throw new TypeError('windowMs must be positive');

  const buckets = new Map();

  return function allow(key) {
    const currentTime = now();
    const normalizedKey = String(key || 'unknown');
    let bucket = buckets.get(normalizedKey);

    if (!bucket || currentTime - bucket.startedAt >= windowMs || currentTime < bucket.startedAt) {
      bucket = { startedAt: currentTime, count: 0 };
      buckets.set(normalizedKey, bucket);
    }

    // Opportunistically remove expired entries to prevent unbounded growth.
    if (buckets.size > 10_000) {
      for (const [entryKey, entry] of buckets) {
        if (currentTime - entry.startedAt >= windowMs || currentTime < entry.startedAt) {
          buckets.delete(entryKey);
        }
      }
    }

    if (bucket.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, windowMs - (currentTime - bucket.startedAt)),
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: limit - bucket.count,
      retryAfterMs: 0,
    };
  };
}
