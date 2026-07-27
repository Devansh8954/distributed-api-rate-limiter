import { RedisClientType } from 'redis';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Token Bucket Algorithm
 *
 * ─── How it works ───────────────────────────────────────────────────────────
 * A virtual bucket holds a maximum capacity of `limit` tokens.
 * Tokens are continuously refilled into the bucket at a constant rate:
 *
 *     Refill Rate = limit / windowSeconds (tokens/sec)
 *
 * When a request arrives:
 *  1. Calculate time elapsed since last request.
 *  2. Add refilled tokens to the bucket (capped at max capacity).
 *  3. If tokens ≥ 1: consume 1 token, allow request (200 OK).
 *  4. If tokens < 1: block request (429 Too Many Requests).
 *
 * ─── Trade-offs ─────────────────────────────────────────────────────────────
 *  PRO: Ideal for handling bursty traffic (allows brief burst up to max capacity).
 *  CON: Requires tracking token state + last refill timestamp per client.
 *
 *  Interview talking point:
 *  "Token Bucket is widely used in API Gateways (like AWS API Gateway and Stripe)
 *  because it smoothly supports legitimate client burst traffic while enforcing
 *  a strict sustained rate."
 */
export class TokenBucketStrategy implements IRateLimiterStrategy {
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
    const redisKey = `tb:${key}`;
    const now = Date.now();

    const rawData = await this.client.get(redisKey);
    let tokens = limit;
    let lastRefill = now;

    if (rawData) {
      try {
        const parsed = JSON.parse(rawData);
        tokens = typeof parsed.tokens === 'number' ? parsed.tokens : limit;
        lastRefill = typeof parsed.lastRefill === 'number' ? parsed.lastRefill : now;
      } catch {
        tokens = limit;
        lastRefill = now;
      }

      // Calculate newly refilled tokens based on time elapsed
      const timeElapsedSeconds = (now - lastRefill) / 1000;
      const refillRate = limit / windowSeconds;
      const tokensToAdd = timeElapsedSeconds * refillRate;

      tokens = Math.min(limit, tokens + tokensToAdd);
      lastRefill = now;
    }

    const allowed = tokens >= 1;
    if (allowed) {
      tokens -= 1;
    }

    const resetInSeconds = Math.max(1, Math.ceil((limit - tokens) / (limit / windowSeconds)));

    // Persist updated token bucket state into Redis
    await this.client.set(
      redisKey,
      JSON.stringify({ tokens, lastRefill }),
      { EX: Math.max(windowSeconds * 2, 60) }
    );

    return {
      allowed,
      limit,
      remaining: Math.max(0, Math.floor(tokens)),
      resetInSeconds,
    };
  }
}
