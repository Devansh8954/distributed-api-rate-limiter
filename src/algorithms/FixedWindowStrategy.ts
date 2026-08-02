import { RedisClientType } from 'redis';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Fixed Window Counter
 * Time is split into fixed windows. Each IP gets one Redis INCR counter per window.
 *
 * Redis ops (all O(1)):  INCR fw:{key}  →  EXPIRE (first req only)  →  TTL
 * PRO: Extremely fast, ultra-low memory.
 * CON: Boundary-burst — client can fire 2× limit within 2 seconds across a window reset.
 */
export class FixedWindowStrategy implements IRateLimiterStrategy {
  constructor(
    private readonly client: RedisClientType,
    private readonly defaultLimit: number,
    private readonly defaultWindowSeconds: number
  ) {}

  async consume(key: string, customLimit?: number, customWindowSeconds?: number): Promise<RateLimiterResult> {
    const limit   = customLimit         ?? this.defaultLimit;
    const window  = customWindowSeconds ?? this.defaultWindowSeconds;
    const redisKey = `fw:${key}`;

    const count = await this.client.incr(redisKey);           // Atomic — safe across distributed nodes
    if (count === 1) await this.client.expire(redisKey, window); // Set TTL only on first request of window

    const ttl    = await this.client.ttl(redisKey);
    const resetIn = ttl > 0 ? ttl : window;

    return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetInSeconds: resetIn };
  }
}
