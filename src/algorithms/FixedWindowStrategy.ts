import { RedisClientType } from 'redis';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Fixed Window Counter Algorithm
 */
export class FixedWindowStrategy implements IRateLimiterStrategy {
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
    const redisKey = `fw:${key}`;

    const count = await this.client.incr(redisKey);

    if (count === 1) {
      await this.client.expire(redisKey, windowSeconds);
    }

    const ttl = await this.client.ttl(redisKey);
    const resetIn = ttl > 0 ? ttl : windowSeconds;

    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetInSeconds: resetIn,
    };
  }
}
