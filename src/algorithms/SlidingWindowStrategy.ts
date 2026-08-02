import { RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Sliding Window Log
 * Stores every request timestamp in a Redis Sorted Set (ZSET). The window slides continuously.
 *
 * Redis pipeline (one round-trip):
 *   ZREMRANGEBYSCORE → prune old entries (O(log N))
 *   ZCARD            → count in-window requests (O(1))
 *   EXPIRE           → auto-cleanup idle keys
 *
 * PRO: 100% accurate, zero boundary-burst.
 * CON: O(log N) ops, higher memory (stores full request log per IP).
 */
export class SlidingWindowStrategy implements IRateLimiterStrategy {
  constructor(
    private readonly client: RedisClientType,
    private readonly defaultLimit: number,
    private readonly defaultWindowSeconds: number
  ) {}

  async consume(key: string, customLimit?: number, customWindowSeconds?: number): Promise<RateLimiterResult> {
    const limit       = customLimit         ?? this.defaultLimit;
    const window      = customWindowSeconds ?? this.defaultWindowSeconds;
    const redisKey    = `sw:${key}`;
    const nowMs       = Date.now();
    const windowStart = nowMs - window * 1000;

    // Execute prune + count + TTL in a single Redis pipeline
    const pipeline = this.client.multi();
    pipeline.zRemRangeByScore(redisKey, 0, windowStart);
    pipeline.zCard(redisKey);
    pipeline.expire(redisKey, window + 1);
    const results      = await pipeline.exec();
    const currentCount = (results[1] as number) ?? 0;

    if (currentCount < limit) {
      await this.client.zAdd(redisKey, { score: nowMs, value: uuidv4() });
      return { allowed: true, limit, remaining: limit - currentCount - 1, resetInSeconds: window };
    }

    return { allowed: false, limit, remaining: 0, resetInSeconds: window };
  }
}
