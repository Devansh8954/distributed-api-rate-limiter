import { RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Sliding Window Log Algorithm
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

    const pipeline = this.client.multi();
    pipeline.zRemRangeByScore(redisKey, 0, windowStartMs);
    pipeline.zCard(redisKey);
    pipeline.expire(redisKey, windowSeconds + 1);

    const results = await pipeline.exec();
    const currentCount = (results[1] as number) ?? 0;

    if (currentCount < limit) {
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
