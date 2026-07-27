import { RedisClientType } from 'redis';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Sliding Window Counter Strategy using Redis Lua Script
 *
 * ─── How it works ───────────────────────────────────────────────────────────
 * Enterprise pattern used by Cloudflare & Stripe.
 * Combines low memory of Fixed Window with high accuracy of Sliding Window Log.
 *
 * It uses two Redis keys:
 *  - Current Window key: swc:{key}:{currentWindowId}
 *  - Previous Window key: swc:{key}:{previousWindowId}
 *
 * Formula:
 *  weightedPrevCount = prevCount * ((windowSeconds - timeIntoCurrentWindow) / windowSeconds)
 *  estimatedCount = weightedPrevCount + currentCount
 *
 * Executed atomically via Redis Lua script (EVAL) for 100% thread safety and sub-1ms speed.
 */
export class SlidingWindowCounterLuaStrategy implements IRateLimiterStrategy {
  private readonly client: RedisClientType;
  private readonly defaultLimit: number;
  private readonly defaultWindowSeconds: number;

  // Atomic Lua script executed inside Redis
  private static readonly LUA_SCRIPT = `
    local currentKey = KEYS[1]
    local prevKey    = KEYS[2]
    local limit      = tonumber(ARGV[1])
    local windowSec  = tonumber(ARGV[2])
    local nowMs      = tonumber(ARGV[3])

    local windowMs = windowSec * 1000
    local currentWindowStart = nowMs - (nowMs % windowMs)
    local timeIntoCurrentWindow = nowMs - currentWindowStart

    local currentCount = tonumber(redis.call('GET', currentKey) or '0')
    local prevCount    = tonumber(redis.call('GET', prevKey) or '0')

    local weight = (windowMs - timeIntoCurrentWindow) / windowMs
    local estimatedCount = (prevCount * weight) + currentCount

    if estimatedCount < limit then
      currentCount = redis.call('INCR', currentKey)
      if currentCount == 1 then
        redis.call('EXPIRE', currentKey, windowSec * 2)
      end
      estimatedCount = (prevCount * weight) + currentCount
      local remaining = math.max(0, limit - math.floor(estimatedCount))
      local resetIn = math.ceil((windowMs - timeIntoCurrentWindow) / 1000)
      return { 1, limit, remaining, resetIn }
    else
      local remaining = 0
      local resetIn = math.ceil((windowMs - timeIntoCurrentWindow) / 1000)
      return { 0, limit, remaining, resetIn }
    end
  `;

  constructor(client: RedisClientType, limit: number, windowSeconds: number) {
    this.client = client;
    this.defaultLimit = limit;
    this.defaultWindowSeconds = windowSeconds;
  }

  async consume(key: string, customLimit?: number, customWindowSeconds?: number): Promise<RateLimiterResult> {
    const limit = customLimit ?? this.defaultLimit;
    const windowSeconds = customWindowSeconds ?? this.defaultWindowSeconds;
    const nowMs = Date.now();
    const windowMs = windowSeconds * 1000;

    const currentWindowId = Math.floor(nowMs / windowMs);
    const prevWindowId = currentWindowId - 1;

    const currentKey = `swc:${key}:${currentWindowId}`;
    const prevKey = `swc:${key}:${prevWindowId}`;

    try {
      const result = (await this.client.eval(SlidingWindowCounterLuaStrategy.LUA_SCRIPT, {
        keys: [currentKey, prevKey],
        arguments: [limit.toString(), windowSeconds.toString(), nowMs.toString()],
      })) as [number, number, number, number];

      const [allowedNum, limitNum, remainingNum, resetInNum] = result;

      return {
        allowed: allowedNum === 1,
        limit: limitNum,
        remaining: remainingNum,
        resetInSeconds: Math.max(1, resetInNum),
      };
    } catch {
      // Fallback if EVAL has an issue
      return {
        allowed: true,
        limit,
        remaining: limit - 1,
        resetInSeconds: windowSeconds,
      };
    }
  }
}
