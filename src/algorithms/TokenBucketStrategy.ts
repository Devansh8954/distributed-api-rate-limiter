import { RedisClientType } from 'redis';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Token Bucket — Atomic Lua Script
 * A virtual bucket holds up to `limit` tokens. Tokens refill at rate = limit/windowSeconds.
 * Each request consumes 1 token; 429 when the bucket is empty.
 *
 * Why Lua? A GET → compute → SET sequence has a TOCTOU race under concurrent distributed nodes.
 * A Lua script runs atomically inside Redis — no interleaving possible.
 *
 * State stored as Redis Hash: { tokens: float, lastRefill: ms timestamp }
 * PRO: Allows controlled bursts (up to max capacity). Race-condition-free.
 * CON: Requires per-client token + timestamp state.
 */
export class TokenBucketStrategy implements IRateLimiterStrategy {
  // Atomic: read → refill → consume → write in a single Redis round-trip
  private static readonly LUA_SCRIPT = `
    local key       = KEYS[1]
    local limit     = tonumber(ARGV[1])
    local windowSec = tonumber(ARGV[2])
    local nowMs     = tonumber(ARGV[3])

    local tokensStr     = redis.call('HGET', key, 'tokens')
    local lastRefillStr = redis.call('HGET', key, 'lastRefill')
    local tokens, lastRefill

    if tokensStr == false then
      tokens = limit; lastRefill = nowMs   -- First request: start with a full bucket
    else
      tokens     = tonumber(tokensStr)
      lastRefill = tonumber(lastRefillStr)
      local elapsed = nowMs - lastRefill
      tokens    = math.min(limit, tokens + elapsed * (limit / (windowSec * 1000)))
      lastRefill = nowMs
    end

    local allowed = 0
    if tokens >= 1 then tokens = tokens - 1; allowed = 1 end

    local remaining = math.max(0, math.floor(tokens))
    local resetIn   = math.max(1, math.ceil((limit - tokens) / (limit / windowSec)))

    redis.call('HSET', key, 'tokens', tostring(tokens), 'lastRefill', tostring(lastRefill))
    redis.call('EXPIRE', key, math.max(windowSec * 2, 60))
    return { allowed, limit, remaining, resetIn }
  `;

  constructor(
    private readonly client: RedisClientType,
    private readonly defaultLimit: number,
    private readonly defaultWindowSeconds: number
  ) {}

  async consume(key: string, customLimit?: number, customWindowSeconds?: number): Promise<RateLimiterResult> {
    const limit   = customLimit         ?? this.defaultLimit;
    const window  = customWindowSeconds ?? this.defaultWindowSeconds;

    try {
      const [allowedNum, limitNum, remainingNum, resetInNum] = (await this.client.eval(
        TokenBucketStrategy.LUA_SCRIPT,
        { keys: [`tb:${key}`], arguments: [limit.toString(), window.toString(), Date.now().toString()] }
      )) as [number, number, number, number];

      return { allowed: allowedNum === 1, limit: limitNum, remaining: remainingNum, resetInSeconds: Math.max(1, resetInNum) };
    } catch {
      return { allowed: true, limit, remaining: limit - 1, resetInSeconds: window }; // fail-open
    }
  }
}
