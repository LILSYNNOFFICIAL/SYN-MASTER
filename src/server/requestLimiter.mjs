/**
 * Small in-memory fixed-window limiter for protecting expensive AI endpoints.
 * State is process-local: use an external shared limiter if the app is scaled
 * across multiple instances.
 */
export function createRateLimiter({ limit = 20, windowMs = 60_000, now = Date.now, maxKeys = 10_000 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
  if (!Number.isFinite(windowMs) || windowMs < 1) throw new TypeError('windowMs must be positive');
  if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new TypeError('maxKeys must be a positive integer');

  const buckets = new Map();

  return function allow(key) {
    const currentTime = now();
    const normalizedKey = String(key || 'unknown');
    let bucket = buckets.get(normalizedKey);

    if (!bucket || currentTime - bucket.startedAt >= windowMs || currentTime < bucket.startedAt) {
      if (!bucket && buckets.size >= maxKeys) {
        for (const [entryKey, entry] of buckets) {
          if (currentTime - entry.startedAt >= windowMs || currentTime < entry.startedAt) {
            buckets.delete(entryKey);
          }
        }
        // Never evict an active client's bucket to make room for a new key.
        // Otherwise an attacker rotating source IPs could erase earlier limits.
        if (buckets.size >= maxKeys) {
          const earliestExpiry = Math.min(...Array.from(buckets.values(), entry => entry.startedAt + windowMs));
          return {
            allowed: false,
            remaining: 0,
            retryAfterMs: Math.max(1, earliestExpiry - currentTime),
          };
        }
      }
      bucket = { startedAt: currentTime, count: 0 };
      buckets.set(normalizedKey, bucket);
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
