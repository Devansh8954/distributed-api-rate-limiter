import { RedisClientType } from 'redis';
import { IRateLimiterStrategy, RateLimiterResult } from './IRateLimiterStrategy';

/**
 * Sliding Window Counter Algorithm using Redis Lua Script
 *
 * ─── How it works ───────────────────────────────────────────────────────────
 * Enterprise rate-limiting pattern used by Cloudflare and Stripe.
 * Combines the memory efficiency of Fixed Window ($O(1)$) with the boundary-burst
 * smooth accuracy of Sliding Window Log.
 *
 * Instead of storing individual request logs in memory, it tracks request counts
 * in two adjacent fixed windows (Current Window & Previous Window) and computes a
 * weighted estimate of requests in the sliding time window:
 *
 *   Weight = (WindowSeconds - TimeIntoCurrentWindow) / WindowSeconds
 *   EstimatedCount = (PrevWindowCount × Weight) + CurrentWindowCount
 *
 * ─── Why Lua Script? ────────────────────────────────────────────────────────
 * Executing this calculation via a single atomic Lua script (`EVAL`) directly
 * inside Redis guarantees:
 *   1. Zero race conditions across distributed server nodes.
 *   2. Single network round-trip (<1ms latency overhead).
 *   3. $O(1)$ fixed memory overhead per IP.
 *
 *  Interview talking point:
 *  "I implemented Sliding Window Counter with Redis Lua scripting to achieve
 *  sub-millisecond execution and linear scale without maintaining full request logs."
 */
export class SlidingWindowCounterLuaStrategy implements IRateLimiterStrategy {
  private readonly client: RedisClientType;
  private readonly defaultLimit: number;
  private readonly defaultWindowSeconds: number;

  // Atomic Lua script executed inside Redis engine
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
      // Fail-open fallback if Redis script execution encounters an unexpected error
      return {
        allowed: true,
        limit,
        remaining: limit - 1,
        resetInSeconds: windowSeconds,
      };
    }
  }
}
