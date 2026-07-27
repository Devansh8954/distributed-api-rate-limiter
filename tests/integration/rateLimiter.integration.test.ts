import request from 'supertest';
import express from 'express';
import { RedisClientType } from 'redis';
import { createRateLimiterMiddleware } from '../../src/middleware/rateLimiter';
import { createApiRouter } from '../../src/routes/api';
import { DynamicConfigService } from '../../src/services/dynamicConfig';

/**
 * Integration Test: Rate Limiter Middleware
 *
 * Uses a hand-rolled in-memory mock for the Redis client — no real Redis needed.
 *
 * ─── Why not use `jest.createMockFromModule` or `ioredis-mock`? ──────────────
 * `RedisClientType` from the `redis` package is a deeply complex TypeScript type
 * with hundreds of overloaded methods. Trying to satisfy it structurally causes
 * hundreds of type errors for irrelevant methods.
 *
 * The correct pattern:
 *   1. Build a plain object that implements ONLY the methods our code actually calls.
 *   2. Cast it to `unknown` first, then to `RedisClientType` at the usage boundary.
 *   3. TypeScript allows this double-cast (unknown → T) without the "overlap" error.
 *
 * This is the standard approach used in production TypeScript test suites.
 */

// ─── Mock Redis factory ───────────────────────────────────────────────────────
function createMockRedisClient() {
  const counters: Record<string, number> = {};
  const ttls:     Record<string, number> = {};
  const store:    Record<string, string> = {};
  const zsets:    Record<string, number[]> = {};

  return {
    // ── Fixed Window ─────────────────────────────────────────────────────────
    incr: jest.fn(async (key: string) => {
      counters[key] = (counters[key] || 0) + 1;
      return counters[key];
    }),
    expire: jest.fn(async (key: string, seconds: number) => {
      ttls[key] = seconds;
      return 1;
    }),
    ttl: jest.fn(async (key: string) => ttls[key] ?? 60),

    // ── Token Bucket (now uses eval like Lua Counter) ─────────────────────────
    get: jest.fn(async (_key: string): Promise<string | null> => null),
    set: jest.fn(async (_key: string, _val: string): Promise<string | null> => 'OK'),

    // ── Sliding Window Log (uses multi/pipeline) ──────────────────────────────
    zRemRangeByScore: jest.fn(async () => 0),
    zCard: jest.fn(async (key: string) => zsets[key]?.length ?? 0),
    zAdd: jest.fn(async (key: string) => {
      if (!zsets[key]) zsets[key] = [];
      zsets[key].push(Date.now());
      return 1;
    }),
    multi: jest.fn(function buildPipeline() {
      const ops: Array<() => Promise<unknown>> = [];

      type MockPipeline = {
        zRemRangeByScore: jest.Mock;
        zCard: jest.Mock;
        expire: jest.Mock;
        exec: jest.Mock;
      };

      const pipeline: MockPipeline = {
        zRemRangeByScore: jest.fn(function (): MockPipeline { ops.push(async () => 0); return pipeline; }),
        zCard:            jest.fn(function (key: string): MockPipeline { ops.push(async () => zsets[key]?.length ?? 0); return pipeline; }),
        expire:           jest.fn(function (): MockPipeline { ops.push(async () => 1); return pipeline; }),
        exec:             jest.fn(async function () {
          const results: unknown[] = [];
          for (const op of ops) results.push(await op());
          return results;
        }),
      };

      return pipeline;
    }),

    // ── Sliding Window Counter + Token Bucket (Lua scripts) ───────────────────
    // Returns [allowed=1, limit=10, remaining=9, resetInSeconds=60]
    eval: jest.fn(async () => [1, 10, 9, 60]),

    // ── Redis Key Inspector (used by admin router) ────────────────────────────
    scan: jest.fn(async () => ({ cursor: 0, keys: [] as string[] })),
    type: jest.fn(async () => 'string' as const),

    // ── Health check ──────────────────────────────────────────────────────────
    ping: jest.fn(async () => 'PONG' as const),

    // ── Test helper ───────────────────────────────────────────────────────────
    _reset(): void {
      for (const k of Object.keys(counters)) delete counters[k];
      for (const k of Object.keys(ttls))     delete ttls[k];
      for (const k of Object.keys(store))    delete store[k];
      for (const k of Object.keys(zsets))    delete zsets[k];
      jest.clearAllMocks();
    },
  };
}

function asRedis(mock: ReturnType<typeof createMockRedisClient>): RedisClientType {
  return mock as unknown as RedisClientType;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Rate Limiter Integration', () => {
  let app: express.Application;
  let mockRedis: ReturnType<typeof createMockRedisClient>;
  // Hoisted so tests that need to inspect or mutate config can access it
  let dynamicConfigService: DynamicConfigService;

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    mockRedis._reset();

    dynamicConfigService = new DynamicConfigService(asRedis(mockRedis));
    const rateLimiter = createRateLimiterMiddleware(dynamicConfigService);

    app = express();
    app.set('trust proxy', 1);
    app.use('/api/v1', rateLimiter, createApiRouter(asRedis(mockRedis)));
    app.use('/api',    createApiRouter(asRedis(mockRedis)));
  });

  // ── GET /api/v1/data ─────────────────────────────────────────────────────────

  describe('GET /api/v1/data', () => {
    it('should return 200 for the first request', async () => {
      const res = await request(app).get('/api/v1/data');
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Success! Here is your data.');
    });

    it('should include all X-RateLimit-* headers on every response', async () => {
      const res = await request(app).get('/api/v1/data');
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
      expect(res.headers['x-ratelimit-strategy']).toBeDefined();
    });

    it('should allow first 10 requests then block the 11th (Fixed Window default)', async () => {
      const statuses: number[] = [];

      for (let i = 0; i < 11; i++) {
        const res = await request(app).get('/api/v1/data');
        statuses.push(res.status);
      }

      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it('should return 429 with structured error body when limit is exceeded', async () => {
      for (let i = 0; i < 10; i++) await request(app).get('/api/v1/data');

      const res = await request(app).get('/api/v1/data');
      expect(res.status).toBe(429);
      expect(res.body.error).toBe('Too Many Requests');
      expect(typeof res.body.retryAfter).toBe('number');
    });

    it('should set Retry-After header on 429 responses', async () => {
      for (let i = 0; i < 10; i++) await request(app).get('/api/v1/data');

      const res = await request(app).get('/api/v1/data');
      expect(res.headers['retry-after']).toBeDefined();
    });
  });

  // ── GET /api/health ──────────────────────────────────────────────────────────

  describe('GET /api/health', () => {
    it('should always return 200 — health check is never rate limited', async () => {
      for (let i = 0; i < 20; i++) {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
      }
    });
  });

  // ── Tier-based rate limiting ─────────────────────────────────────────────────

  describe('Tier-based rate limiting', () => {
    it('should return X-RateLimit-Tier: Free Tier for unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/data');
      expect(res.headers['x-ratelimit-tier']).toBe('Free Tier');
    });

    it('should apply Pro Tier label when x-client-tier: pro header is sent', async () => {
      const res = await request(app).get('/api/v1/data').set('x-client-tier', 'pro');
      // Pro tier has a 60 req/min limit — mock incr returns 1 so it's allowed
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-tier']).toBe('Pro Tier');
    });

    it('should block Pro Tier request when incr exceeds 60 req/min limit', async () => {
      // Mock incr to return 61 — over the Pro tier limit
      mockRedis.incr.mockResolvedValue(61);
      mockRedis.ttl.mockResolvedValue(30);

      const res = await request(app).get('/api/v1/data').set('x-client-tier', 'pro');
      expect(res.status).toBe(429);
      expect(res.body.tier).toBe('Pro Tier');
    });

    it('should apply Enterprise Tier label when x-client-tier: enterprise header is sent', async () => {
      const res = await request(app).get('/api/v1/data').set('x-client-tier', 'enterprise');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-tier']).toBe('Enterprise Tier');
    });
  });

  // ── Runtime strategy switching ───────────────────────────────────────────────

  describe('Runtime strategy switching', () => {
    it('should report fixed-window strategy in headers by default', async () => {
      const res = await request(app).get('/api/v1/data');
      expect(res.headers['x-ratelimit-strategy']).toBe('fixed-window');
    });

    it('should immediately use new strategy after updateActiveStrategy() — no restart needed', async () => {
      dynamicConfigService.updateActiveStrategy('sliding-window-counter');

      // eval mock returns [1, 10, 9, 60] → allowed
      const res = await request(app).get('/api/v1/data');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-strategy']).toBe('sliding-window-counter');
    });

    it('should use sliding-window strategy when switched', async () => {
      dynamicConfigService.updateActiveStrategy('sliding-window');

      const res = await request(app).get('/api/v1/data');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-strategy']).toBe('sliding-window');
    });
  });

  // ── Fail-open behavior ───────────────────────────────────────────────────────

  describe('Fail-open behavior', () => {
    it('should return 200 (fail open) when the active strategy throws a Redis error', async () => {
      const { strategy } = dynamicConfigService.getActiveStrategy();
      jest.spyOn(strategy, 'consume').mockRejectedValueOnce(new Error('Redis connection lost'));

      // Even though the rate limiter threw, the middleware must let the request through
      const res = await request(app).get('/api/v1/data');
      expect(res.status).toBe(200);
    });

    it('should NOT set X-RateLimit-* headers on fail-open requests', async () => {
      const { strategy } = dynamicConfigService.getActiveStrategy();
      jest.spyOn(strategy, 'consume').mockRejectedValueOnce(new Error('Redis down'));

      const res = await request(app).get('/api/v1/data');
      // Headers are set before next() is called — they won't exist on fail-open path
      expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
    });
  });
});
