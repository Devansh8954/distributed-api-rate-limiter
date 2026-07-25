import { RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Sliding Window Log Algorithm
 *
 * ─── How it works ───────────────────────────────────────────────────────────
 * Instead of fixed time buckets, we store a timestamped log of every request
 * in a Redis Sorted Set. The "window" slides with every request.
 *
 *  Timeline: ──────────────────────────────────────────────────────────►
 *  Request at t=50s  → window is [t-50s .. t=50s] → count entries in range
 *  Request at t=61s  → window is [t=1s  .. t=61s] → old entries auto-pruned
 *
 * ─── Redis operations ───────────────────────────────────────────────────────
 *  ZREMRANGEBYSCORE sw:{ip} 0 {windowStart}  → prune old entries  (O(log N))
 *  ZCARD            sw:{ip}                  → count entries       (O(1))
 *  ZADD             sw:{ip} {now} {uuid}     → add new entry       (O(log N))
 *  EXPIRE           sw:{ip} {window}         → prevent memory leak
 *
 *  All executed in a pipeline (single Redis round-trip).
 *
 * ─── Trade-offs ─────────────────────────────────────────────────────────────
 *  PRO:  No boundary burst problem. Perfectly accurate.
 *  CON:  O(log N) per request. More Redis memory (stores full log).
 *        N = requests in the current window.
 *
 *  Use this when: accuracy is critical (auth endpoints, payment APIs).
 */
export class SlidingWindowStrategy implements IRateLimiterStrategy {
  private readonly client: RedisClientType;
  private readonly limit: number;
  private readonly windowSeconds: number;

  constructor(client: RedisClientType, limit: number, windowSeconds: number) {
    this.client = client;
    this.limit = limit;
    this.windowSeconds = windowSeconds;
  }

  async consume(key: string): Promise<RateLimiterResult> {
    const redisKey = `sw:${key}`; // "sw:" prefix separates from fixed-window keys
    const nowMs = Date.now();
    const windowStartMs = nowMs - this.windowSeconds * 1000;

    // Use a pipeline to batch multiple Redis commands into one network round-trip
    const pipeline = this.client.multi();

    // Step 1: Remove all entries older than the current window
    pipeline.zRemRangeByScore(redisKey, 0, windowStartMs);

    // Step 2: Count how many requests remain in the window
    pipeline.zCard(redisKey);

    // Step 3: Set TTL on the key so it auto-cleans from Redis memory
    pipeline.expire(redisKey, this.windowSeconds + 1);

    const results = await pipeline.exec();
    const currentCount = (results[1] as number) ?? 0;

    if (currentCount < this.limit) {
      // Add this request to the log with current timestamp as score
      // uuid as member ensures uniqueness even if two requests arrive at same millisecond
      await this.client.zAdd(redisKey, {
        score: nowMs,
        value: uuidv4(),
      });

      return {
        allowed: true,
        limit: this.limit,
        remaining: this.limit - currentCount - 1,
        resetInSeconds: this.windowSeconds,
      };
    }

    return {
      allowed: false,
      limit: this.limit,
      remaining: 0,
      resetInSeconds: this.windowSeconds,
    };
  }
}
