import "server-only";

/**
 * In-memory token buckets, keyed by client IP and route class. The app runs as a single Node
 * process, so memory is the right place for this. A restart resets the buckets, which is harmless.
 */

export type RouteClass = "create" | "read" | "save" | "claim" | "plugin" | "meta";

interface Limit {
  /** Bucket size, so the largest burst allowed. */
  burst: number;
  /** Tokens refilled per minute. */
  perMinute: number;
}

export const LIMITS: Record<RouteClass, Limit> = {
  create: { burst: 10, perMinute: 6 }, // a plugin opening editors
  read: { burst: 60, perMinute: 60 }, // browsers loading an editor
  save: { burst: 20, perMinute: 12 }, // browsers saving
  claim: { burst: 10, perMinute: 5 }, // plugins claiming codes; failures cost extra
  plugin: { burst: 30, perMinute: 30 }, // applied / discard
  meta: { burst: 60, perMinute: 120 }, // info / health
};

interface Bucket {
  tokens: number;
  updated: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limits: Record<RouteClass, Limit> = LIMITS,
    private readonly maxKeys = 100_000,
  ) {}

  /** Takes `cost` tokens. Returns the seconds to wait if the bucket is empty, or 0 if allowed. */
  take(route: RouteClass, ip: string, now: number, cost = 1): number {
    const limit = this.limits[route];
    const key = `${route}|${ip}`;
    const ratePerMs = limit.perMinute / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: limit.burst, updated: now };
    bucket.tokens = Math.min(limit.burst, bucket.tokens + (now - bucket.updated) * ratePerMs);
    bucket.updated = now;
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.set(key, bucket);
      return 0;
    }
    this.set(key, bucket);
    return Math.max(1, Math.ceil((cost - bucket.tokens) / ratePerMs / 1000));
  }

  /** Charges extra tokens without checking, e.g. after a failed claim. */
  penalize(route: RouteClass, ip: string, now: number, cost: number) {
    const limit = this.limits[route];
    const key = `${route}|${ip}`;
    const bucket = this.buckets.get(key) ?? { tokens: limit.burst, updated: now };
    bucket.tokens = Math.max(-limit.burst, bucket.tokens - cost);
    this.set(key, bucket);
  }

  /** Drops buckets that have refilled completely; they hold no information. */
  prune(now: number) {
    for (const [key, bucket] of this.buckets) {
      const limit = this.limits[key.slice(0, key.indexOf("|")) as RouteClass];
      if (bucket.tokens + (now - bucket.updated) * (limit.perMinute / 60_000) >= limit.burst) this.buckets.delete(key);
    }
  }

  get size() {
    return this.buckets.size;
  }

  private set(key: string, bucket: Bucket) {
    // Map keeps insertion order. Re-inserting moves the key to the end, which gives cheap LRU
    // eviction if a flood of distinct IPs tries to grow the map without bound.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
  }
}

const globalForLimiter = globalThis as unknown as { kaizenLimiter?: RateLimiter };
export const limiter = (): RateLimiter => (globalForLimiter.kaizenLimiter ??= new RateLimiter());
