import { RedisClientType } from 'redis';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Fixed Window Counter Algorithm
 *
 * ─── How it works ───────────────────────────────────────────────────────────
 * Time is divided into fixed windows (e.g. every 60 seconds).
 * Each IP gets one Redis key that holds a counter.
 *
 *  Window 1: 0s ──────────────────── 60s
 *            [req1][req2]...[req10]  → 10 allowed, 11th blocked
 *
 *  Window 2: 60s ─────────────────── 120s
 *            Counter resets to 0, 10 more allowed
 *
 * ─── Redis operations ───────────────────────────────────────────────────────
 *  INCR  fw:{ip}        → atomically increment counter (O(1))
 *  EXPIRE fw:{ip} 60    → only set on first request (locks the window)
 *  TTL   fw:{ip}        → get seconds until key expires
 *
 * ─── Trade-offs ─────────────────────────────────────────────────────────────
 *  PRO:  O(1) time & space. Extremely fast. Works great at high throughput.
 *  CON:  "Boundary burst" problem — a client can fire 20 requests at the
 *        window boundary (10 at second 59 + 10 at second 61). Not perfectly
 *        accurate.
 *
 *  Use this when: throughput matters more than perfect accuracy.
 */
export class FixedWindowStrategy implements IRateLimiterStrategy {
  private readonly client: RedisClientType;
  private readonly limit: number;
  private readonly windowSeconds: number;

  constructor(client: RedisClientType, limit: number, windowSeconds: number) {
    this.client = client;
    this.limit = limit;
    this.windowSeconds = windowSeconds;
  }

  async consume(key: string): Promise<RateLimiterResult> {
    const redisKey = `fw:${key}`; // "fw:" prefix to avoid key collisions

    // INCR is atomic — safe even when multiple server instances run concurrently
    // If the key doesn't exist yet, Redis creates it with value 0 then increments to 1
    const count = await this.client.incr(redisKey);

    // Only set the TTL on the VERY FIRST request of a window.
    // If we set EXPIRE on every request, we'd keep resetting the window — wrong!
    if (count === 1) {
      await this.client.expire(redisKey, this.windowSeconds);
    }

    // Get remaining TTL so we can tell the client when the window resets
    const ttl = await this.client.ttl(redisKey);
    const resetIn = ttl > 0 ? ttl : this.windowSeconds;

    return {
      allowed: count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - count),
      resetInSeconds: resetIn,
    };
  }
}
