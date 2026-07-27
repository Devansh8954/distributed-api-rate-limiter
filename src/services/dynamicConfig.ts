import { RedisClientType } from 'redis';
import { IRateLimiterStrategy } from '../algorithms/IRateLimiterStrategy';
import { FixedWindowStrategy } from '../algorithms/FixedWindowStrategy';
import { SlidingWindowStrategy } from '../algorithms/SlidingWindowStrategy';
import { TokenBucketStrategy } from '../algorithms/TokenBucketStrategy';
import { SlidingWindowCounterLuaStrategy } from '../algorithms/SlidingWindowCounterLuaStrategy';
import config from '../config';

export type StrategyType = 'fixed-window' | 'sliding-window' | 'token-bucket' | 'sliding-window-counter';

export interface TierConfig {
  name: string;
  limit: number;
  windowSeconds: number;
}

export class DynamicConfigService {
  private activeStrategyName: StrategyType;
  private defaultLimit: number;
  private defaultWindowSeconds: number;

  private readonly strategies: Record<StrategyType, IRateLimiterStrategy>;
  private readonly tiers: Record<string, TierConfig> = {
    free: { name: 'Free Tier', limit: 10, windowSeconds: 60 },
    pro: { name: 'Pro Tier', limit: 60, windowSeconds: 60 },
    enterprise: { name: 'Enterprise Tier', limit: 300, windowSeconds: 60 },
  };

  constructor(redisClient: RedisClientType) {
    this.activeStrategyName = (config.rateLimit.strategy as StrategyType) || 'fixed-window';
    this.defaultLimit = config.rateLimit.limit || 10;
    this.defaultWindowSeconds = config.rateLimit.windowSeconds || 60;

    this.strategies = {
      'fixed-window': new FixedWindowStrategy(redisClient, this.defaultLimit, this.defaultWindowSeconds),
      'sliding-window': new SlidingWindowStrategy(redisClient, this.defaultLimit, this.defaultWindowSeconds),
      'token-bucket': new TokenBucketStrategy(redisClient, this.defaultLimit, this.defaultWindowSeconds),
      'sliding-window-counter': new SlidingWindowCounterLuaStrategy(redisClient, this.defaultLimit, this.defaultWindowSeconds),
    };
  }

  getActiveStrategy(): { name: StrategyType; strategy: IRateLimiterStrategy } {
    const strategy = this.strategies[this.activeStrategyName] || this.strategies['fixed-window'];
    return { name: this.activeStrategyName, strategy };
  }

  updateActiveStrategy(name: StrategyType): void {
    if (this.strategies[name]) {
      this.activeStrategyName = name;
    }
  }

  getGlobalDefaults(): { limit: number; windowSeconds: number } {
    return { limit: this.defaultLimit, windowSeconds: this.defaultWindowSeconds };
  }

  updateGlobalDefaults(limit: number, windowSeconds: number): void {
    this.defaultLimit = limit;
    this.defaultWindowSeconds = windowSeconds;
  }

  getTierConfig(tierKey?: string): TierConfig {
    const normalized = (tierKey || 'free').toLowerCase();
    return this.tiers[normalized] || this.tiers['free'];
  }

  getAllTiers(): Record<string, TierConfig> {
    return this.tiers;
  }
}
