import { RedisClientType } from 'redis';
import { IRateLimiterStrategy } from '../algorithms/IRateLimiterStrategy';
import { FixedWindowStrategy } from '../algorithms/FixedWindowStrategy';
import { SlidingWindowStrategy } from '../algorithms/SlidingWindowStrategy';
import { TokenBucketStrategy } from '../algorithms/TokenBucketStrategy';
import { SlidingWindowCounterLuaStrategy } from '../algorithms/SlidingWindowCounterLuaStrategy';
import config from '../config';

export type StrategyType = 'fixed-window' | 'sliding-window' | 'token-bucket' | 'sliding-window-counter';

export interface TierConfig {
  name: string;          // Display name, e.g. "Free Tier"
  limit: number;         // Max requests per window
  windowSeconds: number; // Window duration in seconds
}

/**
 * DynamicConfigService — the central brain of the gateway.
 * Holds all 4 algorithm instances (pre-wired to Redis) and tracks which is active.
 * Hot-swapping the algorithm is a single reference swap — no restart needed.
 */
export class DynamicConfigService {
  private activeStrategyName: StrategyType;
  private defaultLimit: number;
  private defaultWindowSeconds: number;

  // All strategies are instantiated once at boot, sharing the same Redis connection
  private readonly strategies: Record<StrategyType, IRateLimiterStrategy>;

  // Multi-tenant rate-limit tiers
  private readonly tiers: Record<string, TierConfig> = {
    free:       { name: 'Free Tier',       limit: 10,  windowSeconds: 60 },
    pro:        { name: 'Pro Tier',        limit: 60,  windowSeconds: 60 },
    enterprise: { name: 'Enterprise Tier', limit: 300, windowSeconds: 60 },
  };

  constructor(redisClient: RedisClientType) {
    this.activeStrategyName  = (config.rateLimit.strategy as StrategyType) || 'fixed-window';
    this.defaultLimit        = config.rateLimit.limit        || 10;
    this.defaultWindowSeconds = config.rateLimit.windowSeconds || 60;

    const args: [RedisClientType, number, number] = [redisClient, this.defaultLimit, this.defaultWindowSeconds];
    this.strategies = {
      'fixed-window':           new FixedWindowStrategy(...args),
      'sliding-window':         new SlidingWindowStrategy(...args),
      'token-bucket':           new TokenBucketStrategy(...args),
      'sliding-window-counter': new SlidingWindowCounterLuaStrategy(...args),
    };
  }

  /** Returns the active strategy instance + its name. Called on every request. */
  getActiveStrategy(): { name: StrategyType; strategy: IRateLimiterStrategy } {
    return { name: this.activeStrategyName, strategy: this.strategies[this.activeStrategyName] };
  }

  /** Hot-swaps the active algorithm; takes effect on the very next request. */
  updateActiveStrategy(name: StrategyType): void {
    if (this.strategies[name]) this.activeStrategyName = name;
  }

  getGlobalDefaults(): { limit: number; windowSeconds: number } {
    return { limit: this.defaultLimit, windowSeconds: this.defaultWindowSeconds };
  }

  updateGlobalDefaults(limit: number, windowSeconds: number): void {
    this.defaultLimit = limit;
    this.defaultWindowSeconds = windowSeconds;
  }

  /** Resolves tier config from a client header; falls back to Free Tier. */
  getTierConfig(tierKey?: string): TierConfig {
    return this.tiers[(tierKey || 'free').toLowerCase()] ?? this.tiers['free'];
  }

  getAllTiers(): Record<string, TierConfig> { return this.tiers; }
}
