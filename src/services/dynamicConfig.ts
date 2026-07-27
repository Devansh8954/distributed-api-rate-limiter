import { RedisClientType } from 'redis';
import { IRateLimiterStrategy } from '../algorithms/IRateLimiterStrategy';
import { FixedWindowStrategy } from '../algorithms/FixedWindowStrategy';
import { SlidingWindowStrategy } from '../algorithms/SlidingWindowStrategy';
import { TokenBucketStrategy } from '../algorithms/TokenBucketStrategy';
import { SlidingWindowCounterLuaStrategy } from '../algorithms/SlidingWindowCounterLuaStrategy';
import config from '../config';

/**
 * The four supported algorithm names.
 * Used as keys in the strategy registry and as values in config / API requests.
 */
export type StrategyType =
  | 'fixed-window'
  | 'sliding-window'
  | 'token-bucket'
  | 'sliding-window-counter';

/**
 * Shape of a single client tier's rate-limit policy.
 */
export interface TierConfig {
  name:          string; // Display name (e.g. "Free Tier")
  limit:         number; // Max requests per window for this tier
  windowSeconds: number; // Window duration in seconds for this tier
}

/**
 * DynamicConfigService — the central brain of the gateway.
 *
 * Responsibilities:
 *  1. Holds all 4 rate-limiting algorithm instances (pre-instantiated at startup).
 *  2. Tracks which algorithm is currently active.
 *  3. Provides multi-tenant tier configs (Free / Pro / Enterprise).
 *  4. Allows hot-swapping the active algorithm at runtime — NO server restart needed.
 *
 * ─── Why pre-instantiate all strategies? ────────────────────────────────────
 * Instantiating a class is cheap, but connecting to Redis is not.
 * By creating all strategies at boot time (all sharing the same Redis connection),
 * switching algorithms is instant — it's just swapping a variable reference.
 */
export class DynamicConfigService {
  private activeStrategyName: StrategyType;
  private defaultLimit:         number;
  private defaultWindowSeconds: number;

  // All 4 strategies are created once and reused forever
  private readonly strategies: Record<StrategyType, IRateLimiterStrategy>;

  // Multi-tenant tier definitions — each tier overrides the default limit/window
  private readonly tiers: Record<string, TierConfig> = {
    free:       { name: 'Free Tier',       limit: 10,  windowSeconds: 60 },
    pro:        { name: 'Pro Tier',        limit: 60,  windowSeconds: 60 },
    enterprise: { name: 'Enterprise Tier', limit: 300, windowSeconds: 60 },
  };

  constructor(redisClient: RedisClientType) {
    this.activeStrategyName  = (config.rateLimit.strategy as StrategyType) || 'fixed-window';
    this.defaultLimit        = config.rateLimit.limit        || 10;
    this.defaultWindowSeconds = config.rateLimit.windowSeconds || 60;

    // Pre-instantiate all 4 strategies using the shared Redis connection
    this.strategies = {
      'fixed-window':           new FixedWindowStrategy(           redisClient, this.defaultLimit, this.defaultWindowSeconds),
      'sliding-window':         new SlidingWindowStrategy(         redisClient, this.defaultLimit, this.defaultWindowSeconds),
      'token-bucket':           new TokenBucketStrategy(           redisClient, this.defaultLimit, this.defaultWindowSeconds),
      'sliding-window-counter': new SlidingWindowCounterLuaStrategy(redisClient, this.defaultLimit, this.defaultWindowSeconds),
    };
  }

  /**
   * Returns the currently active strategy instance + its name.
   * Called by the rate limiter middleware on every single request.
   */
  getActiveStrategy(): { name: StrategyType; strategy: IRateLimiterStrategy } {
    return {
      name:     this.activeStrategyName,
      strategy: this.strategies[this.activeStrategyName],
    };
  }

  /**
   * Switches the active algorithm. Takes effect on the VERY NEXT request.
   * This is how the dashboard's algorithm toggle works — no restart needed.
   */
  updateActiveStrategy(name: StrategyType): void {
    if (this.strategies[name]) {
      this.activeStrategyName = name;
    }
  }

  /** Returns the current default fallback limit + window used when no tier matches. */
  getGlobalDefaults(): { limit: number; windowSeconds: number } {
    return { limit: this.defaultLimit, windowSeconds: this.defaultWindowSeconds };
  }

  /** Updates global default limits. Does NOT affect existing Redis keys — only future requests. */
  updateGlobalDefaults(limit: number, windowSeconds: number): void {
    this.defaultLimit         = limit;
    this.defaultWindowSeconds = windowSeconds;
  }

  /**
   * Resolves the tier config for a client.
   *
   * The middleware sends the x-client-tier or x-api-key header value here.
   * If no match → defaults to 'Free Tier' limits.
   *
   * Examples:
   *   getTierConfig('pro')        → { name: 'Pro Tier', limit: 60, windowSeconds: 60 }
   *   getTierConfig('ENTERPRISE') → { name: 'Enterprise Tier', limit: 300, windowSeconds: 60 }
   *   getTierConfig(undefined)    → { name: 'Free Tier', limit: 10, windowSeconds: 60 }
   */
  getTierConfig(tierKey?: string): TierConfig {
    const normalized = (tierKey || 'free').toLowerCase();
    return this.tiers[normalized] ?? this.tiers['free'];
  }

  /** Returns all tier definitions — used by the admin config endpoint and dashboard. */
  getAllTiers(): Record<string, TierConfig> {
    return this.tiers;
  }
}
