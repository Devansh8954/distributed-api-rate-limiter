import { RedisClientType } from 'redis';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Token Bucket Strategy
 *
 * ─── How it works ───────────────────────────────────────────────────────────
 * A bucket has a max capacity of `limit` tokens.
 * Tokens are added to the bucket at a constant rate (limit / windowSeconds tokens/sec).
 * When a request arrives, 1 token is consumed.
 * If 0 tokens are remaining, the request is rejected with 429.
 *
 * ─── Redis Implementation ───────────────────────────────────────────────────
 * Key: tb:{key} holding a JSON object or Hash { tokens, lastRefill }
 * Fast, precise, handles dynamic burst traffic smoothly.
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

      // Calculate how many tokens should be added based on time elapsed
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

    // Save updated token state into Redis with TTL
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
