import { RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Sliding Window Log Algorithm
 *
 * ─── How it works ───────────────────────────────────────────────────────────
 * Instead of fixed time buckets, we store a timestamped log of every request
 * in a Redis Sorted Set (`ZSET`). The window continuously slides with time.
 *
 *  Timeline: ──────────────────────────────────────────────────────────►
 *  Request at t=50s  → window is [t-60s .. t=50s] → prune old, count entries
 *  Request at t=61s  → window is [t=1s  .. t=61s] → old entries pruned automatically
 *
 * ─── Redis operations ───────────────────────────────────────────────────────
 *  • ZREMRANGEBYSCORE sw:{key} 0 {windowStart} → Prune old timestamps (O(log N))
 *  • ZCARD            sw:{key}                 → Count requests in current window (O(1))
 *  • ZADD             sw:{key} {now} {uuid}    → Add current request timestamp (O(log N))
 *  • EXPIRE           sw:{key} {window+1}      → Auto-clean inactive keys
 *
 *  All executed in a Redis Pipeline (`multi()`) for a single network round-trip.
 *
 * ─── Trade-offs ─────────────────────────────────────────────────────────────
 *  PRO: 100% precision. Zero boundary burst issues.
 *  CON: Higher Redis memory usage (stores full request log) and O(log N) operations.
 *
 *  Interview talking point:
 *  "I chose Sliding Window Log for high-security endpoints like /auth/login where
 *  sub-second precision is required to prevent credential stuffing attacks."
 */
export class SlidingWindowStrategy implements IRateLimiterStrategy {
  private readonly client: RedisClientType;
  private readonly defaultLimit: number;
  private readonly defaultWindowSeconds: number;

  constructor(client: RedisClientType, limit: number, windowSeconds: number) {
    this.client = client;
    this.defaultLimit = limit;
    this.defaultWindowSeconds = windowSeconds;
  }

  async consume(key: string, customLimit?: number, customWindowSeconds?: number): Promise<RateLimiterResult> {
    const limit = customLimit ?? this.defaultLimit;
    const windowSeconds = customWindowSeconds ?? this.defaultWindowSeconds;
    const redisKey = `sw:${key}`;
    const nowMs = Date.now();
    const windowStartMs = nowMs - windowSeconds * 1000;

    // Use Redis Pipeline (multi) to execute all commands in 1 network round trip
    const pipeline = this.client.multi();

    // Step 1: Remove all log entries older than current sliding window
    pipeline.zRemRangeByScore(redisKey, 0, windowStartMs);

    // Step 2: Count remaining active requests in the window
    pipeline.zCard(redisKey);

    // Step 3: Set TTL to auto-cleanup unused keys
    pipeline.expire(redisKey, windowSeconds + 1);

    const results = await pipeline.exec();
    const currentCount = (results[1] as number) ?? 0;

    if (currentCount < limit) {
      // Add current request timestamp to Sorted Set (UUID prevents collision)
      await this.client.zAdd(redisKey, {
        score: nowMs,
        value: uuidv4(),
      });

      return {
        allowed: true,
        limit,
        remaining: limit - currentCount - 1,
        resetInSeconds: windowSeconds,
      };
    }

    return {
      allowed: false,
      limit,
      remaining: 0,
      resetInSeconds: windowSeconds,
    };
  }
}
