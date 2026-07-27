import { RedisClientType } from 'redis';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Fixed Window Counter Algorithm
 *
 * ─── How it works ───────────────────────────────────────────────────────────
 * Time is divided into fixed windows (e.g., every 60 seconds).
 * Each client IP gets one Redis key holding a simple counter.
 *
 *  Window 1: 0s ──────────────────── 60s
 *            [req1][req2]...[req10]  → 10 allowed, 11th blocked (HTTP 429)
 *
 *  Window 2: 60s ─────────────────── 120s
 *            Counter resets to 0, 10 more allowed
 *
 * ─── Redis operations ───────────────────────────────────────────────────────
 *  • INCR  fw:{key}     → Atomically increment counter (O(1))
 *  • EXPIRE fw:{key} 60 → Set TTL on first request of window (O(1))
 *  • TTL   fw:{key}     → Get seconds remaining in window (O(1))
 *
 * ─── Trade-offs ─────────────────────────────────────────────────────────────
 *  PRO: Extremely fast (O(1) time & space). Ultra-low memory usage.
 *  CON: "Boundary burst" problem — a client can fire 10 requests at sec 59
 *       and 10 requests at sec 61 (20 requests in 2 seconds!).
 *
 *  Interview talking point:
 *  "I implemented Fixed Window as the base high-throughput algorithm when O(1)
 *  performance matters more than sub-second precision."
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
    const redisKey = `fw:${key}`; // Prefix prevents key collisions in Redis

    // INCR is atomic in Redis — safe under multi-node Express deployment
    const count = await this.client.incr(redisKey);

    // Only set TTL on the VERY FIRST request of a new window
    if (count === 1) {
      await this.client.expire(redisKey, windowSeconds);
    }

    // Retrieve remaining window TTL
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
