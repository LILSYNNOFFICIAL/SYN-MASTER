/** Process-local concurrency gate for expensive AI work. */
export function createConcurrencyLimiter({ maxTotal = 8, maxPerKey = 2 } = {}) {
  if (!Number.isInteger(maxTotal) || maxTotal < 1) throw new RangeError('maxTotal must be a positive integer');
  if (!Number.isInteger(maxPerKey) || maxPerKey < 1) throw new RangeError('maxPerKey must be a positive integer');
  let activeTotal = 0;
  const activeByKey = new Map();

  return function acquire(key) {
    const clientKey = String(key ?? '').trim();
    if (!clientKey || activeTotal >= maxTotal || (activeByKey.get(clientKey) ?? 0) >= maxPerKey) {
      return { allowed: false, release() {} };
    }
    activeTotal += 1;
    activeByKey.set(clientKey, (activeByKey.get(clientKey) ?? 0) + 1);
    let released = false;
    return {
      allowed: true,
      release() {
        if (released) return;
        released = true;
        activeTotal = Math.max(0, activeTotal - 1);
        const remaining = Math.max(0, (activeByKey.get(clientKey) ?? 1) - 1);
        if (remaining) activeByKey.set(clientKey, remaining);
        else activeByKey.delete(clientKey);
      },
    };
  };
}
