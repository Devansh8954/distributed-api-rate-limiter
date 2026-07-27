import { RedisClientType } from 'redis';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Token Bucket Algorithm — Atomic Lua Script Implementation
 *
 * ─── How it works ───────────────────────────────────────────────────────────
 * A virtual bucket holds a maximum capacity of `limit` tokens.
 * Tokens are continuously refilled into the bucket at a constant rate:
 *
 *     Refill Rate = limit / windowSeconds  (tokens/sec)
 *
 * When a request arrives:
 *  1. Calculate time elapsed since last request.
 *  2. Add refilled tokens (capped at max capacity).
 *  3. tokens ≥ 1 → consume 1 token, allow request (200 OK).
 *  4. tokens < 1 → block request (429).
 *
 * ─── Why Lua Script? ────────────────────────────────────────────────────────
 * The previous implementation used GET → compute → SET, which has a TOCTOU
 * (Time-Of-Check-Time-Of-Use) race condition: two concurrent requests across
 * distributed nodes can both read the same token count, both decide they are
 * allowed, and both decrement — letting 2 requests through for 1 token.
 *
 * A Lua script executes atomically inside the Redis engine — no interleaving
 * is possible, even across multiple distributed app nodes.
 *
 * State is stored as a Redis Hash (HSET) with two fields:
 *   tokens    → current token count (float string)
 *   lastRefill → last update timestamp in ms (int string)
 *
 * ─── Trade-offs ─────────────────────────────────────────────────────────────
 *  PRO: Ideal for bursty traffic (allows brief bursts up to max capacity).
 *  PRO: Atomic — race-condition-free in any distributed setup.
 *  CON: Requires tracking token state + last refill timestamp per client.
 *
 *  Interview talking point:
 *  "Token Bucket is widely used in API Gateways (AWS API Gateway, Stripe).
 *   I replaced the naive GET/SET pattern with an atomic Lua script to eliminate
 *   the TOCTOU race condition that would appear under concurrent distributed load."
 */
export class TokenBucketStrategy implements IRateLimiterStrategy {
  private readonly client: RedisClientType;
  private readonly defaultLimit: number;
  private readonly defaultWindowSeconds: number;

  // Atomic Lua script: read → refill → consume → write in one Redis round-trip
  private static readonly LUA_SCRIPT = `
    local key       = KEYS[1]
    local limit     = tonumber(ARGV[1])
    local windowSec = tonumber(ARGV[2])
    local nowMs     = tonumber(ARGV[3])

    local tokensStr     = redis.call('HGET', key, 'tokens')
    local lastRefillStr = redis.call('HGET', key, 'lastRefill')

    local tokens
    local lastRefill

    if tokensStr == false then
      -- First request: bucket starts full
      tokens     = limit
      lastRefill = nowMs
    else
      tokens     = tonumber(tokensStr)
      lastRefill = tonumber(lastRefillStr)

      -- Refill tokens proportional to time elapsed
      local refillRatePerMs = limit / (windowSec * 1000)
      local elapsed         = nowMs - lastRefill
      tokens    = math.min(limit, tokens + elapsed * refillRatePerMs)
      lastRefill = nowMs
    end

    -- Attempt to consume 1 token
    local allowed = 0
    if tokens >= 1 then
      tokens  = tokens - 1
      allowed = 1
    end

    local remaining = math.max(0, math.floor(tokens))
    local resetIn   = math.max(1, math.ceil((limit - tokens) / (limit / windowSec)))

    -- Persist updated state atomically in the same script
    redis.call('HSET', key, 'tokens', tostring(tokens), 'lastRefill', tostring(lastRefill))
    redis.call('EXPIRE', key, math.max(windowSec * 2, 60))

    return { allowed, limit, remaining, resetIn }
  `;

  constructor(client: RedisClientType, limit: number, windowSeconds: number) {
    this.client = client;
    this.defaultLimit = limit;
    this.defaultWindowSeconds = windowSeconds;
  }

  async consume(key: string, customLimit?: number, customWindowSeconds?: number): Promise<RateLimiterResult> {
    const limit         = customLimit         ?? this.defaultLimit;
    const windowSeconds = customWindowSeconds ?? this.defaultWindowSeconds;
    const redisKey      = `tb:${key}`;
    const nowMs         = Date.now();

    try {
      const result = (await this.client.eval(TokenBucketStrategy.LUA_SCRIPT, {
        keys:      [redisKey],
        arguments: [limit.toString(), windowSeconds.toString(), nowMs.toString()],
      })) as [number, number, number, number];

      const [allowedNum, limitNum, remainingNum, resetInNum] = result;

      return {
        allowed:        allowedNum === 1,
        limit:          limitNum,
        remaining:      remainingNum,
        resetInSeconds: Math.max(1, resetInNum),
      };
    } catch {
      // Fail-open: if Redis is unavailable, allow the request
      return {
        allowed:        true,
        limit,
        remaining:      limit - 1,
        resetInSeconds: windowSeconds,
      };
    }
  }
}
