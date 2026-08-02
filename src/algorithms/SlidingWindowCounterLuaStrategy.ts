import { RedisClientType } from 'redis';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Sliding Window Counter — Atomic Lua Script (Cloudflare/Stripe pattern)
 * Combines Fixed Window O(1) memory with Sliding Window Log accuracy via a weighted estimate:
 *
 *   weight        = (windowMs - timeIntoCurrentWindow) / windowMs
 *   estimatedCount = (prevWindowCount × weight) + currentWindowCount
 *
 * Two Redis keys track current + previous window counters (both expire automatically).
 * Single Lua EVAL = atomic execution, one round-trip, zero race conditions.
 *
 * PRO: O(1) memory per IP, sub-millisecond latency, no boundary-burst.
 * CON: Estimate (not exact), but accuracy is >99% in practice.
 */
export class SlidingWindowCounterLuaStrategy implements IRateLimiterStrategy {
  private static readonly LUA_SCRIPT = `
    local currentKey = KEYS[1]
    local prevKey    = KEYS[2]
    local limit      = tonumber(ARGV[1])
    local windowSec  = tonumber(ARGV[2])
    local nowMs      = tonumber(ARGV[3])

    local windowMs              = windowSec * 1000
    local currentWindowStart    = nowMs - (nowMs % windowMs)
    local timeIntoCurrentWindow = nowMs - currentWindowStart

    local currentCount = tonumber(redis.call('GET', currentKey) or '0')
    local prevCount    = tonumber(redis.call('GET', prevKey)    or '0')

    local weight         = (windowMs - timeIntoCurrentWindow) / windowMs
    local estimatedCount = (prevCount * weight) + currentCount
    local resetIn        = math.ceil((windowMs - timeIntoCurrentWindow) / 1000)

    if estimatedCount < limit then
      currentCount = redis.call('INCR', currentKey)
      if currentCount == 1 then redis.call('EXPIRE', currentKey, windowSec * 2) end
      local remaining = math.max(0, limit - math.floor((prevCount * weight) + currentCount))
      return { 1, limit, remaining, resetIn }
    else
      return { 0, limit, 0, resetIn }
    end
  `;

  constructor(
    private readonly client: RedisClientType,
    private readonly defaultLimit: number,
    private readonly defaultWindowSeconds: number
  ) {}

  async consume(key: string, customLimit?: number, customWindowSeconds?: number): Promise<RateLimiterResult> {
    const limit   = customLimit         ?? this.defaultLimit;
    const window  = customWindowSeconds ?? this.defaultWindowSeconds;
    const nowMs   = Date.now();
    const windowId = Math.floor(nowMs / (window * 1000));

    try {
      const [allowedNum, limitNum, remainingNum, resetInNum] = (await this.client.eval(
        SlidingWindowCounterLuaStrategy.LUA_SCRIPT,
        {
          keys:      [`swc:${key}:${windowId}`, `swc:${key}:${windowId - 1}`],
          arguments: [limit.toString(), window.toString(), nowMs.toString()],
        }
      )) as [number, number, number, number];

      return { allowed: allowedNum === 1, limit: limitNum, remaining: remainingNum, resetInSeconds: Math.max(1, resetInNum) };
    } catch {
      return { allowed: true, limit, remaining: limit - 1, resetInSeconds: window }; // fail-open
    }
  }
}
