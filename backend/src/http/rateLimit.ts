/**
 * Rate limiting for sensitive endpoints (PRD §8.1).
 *
 * In-memory and per-process, which is honest about what it is: enough to blunt
 * credential stuffing against a single instance, not a distributed limiter. A
 * multi-instance deployment needs this backed by Redis, and the interface is
 * shaped so that swap touches only this file.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export interface Limiter {
  /** Returns false when the caller has exhausted its allowance. */
  take(key: string, now?: number): boolean;
  /** Called on success, so a legitimate sign-in clears the counter. */
  reset(key: string): void;
  size(): number;
}

export function createLimiter(max: number, windowMs: number): Limiter {
  const buckets = new Map<string, Bucket>();

  const sweep = (now: number) => {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  };

  return {
    take(key, now = Date.now()) {
      // Opportunistic cleanup keeps an unbounded key space from leaking memory
      // — the keys include user-supplied email addresses.
      if (buckets.size > 5000) sweep(now);

      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (bucket.count >= max) return false;
      bucket.count += 1;
      return true;
    },

    reset(key) {
      buckets.delete(key);
    },

    size: () => buckets.size,
  };
}
