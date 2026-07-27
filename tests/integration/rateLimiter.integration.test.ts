import request from 'supertest';
import express from 'express';
import { createRateLimiterMiddleware } from '../../src/middleware/rateLimiter';
import { createApiRouter } from '../../src/routes/api';
import { DynamicConfigService } from '../../src/services/dynamicConfig';

/**
 * Integration Test: Rate Limiter Middleware
 *
 * Uses an in-memory mock Redis client — no real Redis needed.
 * Tests the FULL request → middleware → route handler flow via supertest.
 */

// Full mock Redis client matching all methods used by strategies + admin router
function createMockRedisClient() {
  const counters: Record<string, number> = {};
  const ttls: Record<string, number> = {};
  const store: Record<string, string> = {};
  const zsets: Record<string, number[]> = {};

  const client = {
    // Fixed Window: INCR + EXPIRE + TTL
    incr: jest.fn(async (key: string) => {
      counters[key] = (counters[key] || 0) + 1;
      return counters[key];
    }),
    expire: jest.fn(async (key: string, seconds: number) => {
      ttls[key] = seconds;
      return 1;
    }),
    ttl: jest.fn(async (key: string) => {
      return ttls[key] || 60;
    }),

    // Token Bucket: GET + SET
    get: jest.fn(async (_key: string) => null as string | null),
    set: jest.fn(async (_key: string, _val: string, _opts?: object) => 'OK' as string | null),

    // Sliding Window Log: ZREMRANGEBYSCORE + ZCARD + ZADD + EXPIRE (via multi/pipeline)
    zRemRangeByScore: jest.fn(async () => 0),
    zCard: jest.fn(async (key: string) => zsets[key]?.length ?? 0),
    zAdd: jest.fn(async (key: string) => {
      zsets[key] = zsets[key] || [];
      zsets[key].push(Date.now());
      return 1;
    }),
    multi: jest.fn(() => {
      const pipeline: Record<string, jest.Mock> = {};
      const ops: Array<() => Promise<unknown>> = [];

      pipeline.zRemRangeByScore = jest.fn(() => {
        ops.push(async () => 0);
        return pipeline;
      });
      pipeline.zCard = jest.fn((key: string) => {
        ops.push(async () => zsets[key]?.length ?? 0);
        return pipeline;
      });
      pipeline.expire = jest.fn(() => {
        ops.push(async () => 1);
        return pipeline;
      });
      pipeline.exec = jest.fn(async () => {
        const results: unknown[] = [];
        for (const op of ops) results.push(await op());
        return results;
      });

      return pipeline;
    }),

    // Sliding Window Counter Lua: EVAL
    eval: jest.fn(async (_script: string, _opts: { keys: string[]; arguments: string[] }) => {
      // Default: allow request, return [allowed=1, limit=10, remaining=9, resetIn=60]
      return [1, 10, 9, 60];
    }),

    // Redis Key Inspector (admin router)
    scan: jest.fn(async () => ({ cursor: 0, keys: [] })),
    type: jest.fn(async () => 'string'),

    // Health check
    ping: jest.fn(async () => 'PONG'),

    // Test helper: resets all internal state for isolation
    _reset: () => {
      Object.keys(counters).forEach((k) => delete counters[k]);
      Object.keys(ttls).forEach((k) => delete ttls[k]);
      Object.keys(store).forEach((k) => delete store[k]);
      Object.keys(zsets).forEach((k) => delete zsets[k]);
      jest.clearAllMocks();
    },
  };

  return client;
}

describe('Rate Limiter Integration', () => {
  let app: express.Application;
  let mockRedis: ReturnType<typeof createMockRedisClient>;
  let dynamicConfigService: DynamicConfigService;

  beforeEach(() => {
    mockRedis = createMockRedisClient();

    dynamicConfigService = new DynamicConfigService(mockRedis as never);
    const rateLimiter = createRateLimiterMiddleware(dynamicConfigService);

    app = express();
    app.set('trust proxy', 1);
    app.use('/api/v1', rateLimiter, createApiRouter(mockRedis as never));
    app.use('/api', createApiRouter(mockRedis as never));
  });

  // ------------------------------------------------------------------
  // GET /api/v1/data
  // ------------------------------------------------------------------
  describe('GET /api/v1/data', () => {
    it('should return 200 for the first request', async () => {
      const res = await request(app).get('/api/v1/data');
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Success! Here is your data.');
    });

    it('should include rate limit headers on every response', async () => {
      const res = await request(app).get('/api/v1/data');
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
      expect(res.headers['x-ratelimit-strategy']).toBeDefined();
    });

    it('should allow first 10 requests and block the 11th (Fixed Window)', async () => {
      const statuses: number[] = [];

      for (let i = 0; i < 11; i++) {
        const res = await request(app).get('/api/v1/data');
        statuses.push(res.status);
      }

      // First 10 → 200 OK
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      // 11th → 429 Too Many Requests
      expect(statuses[10]).toBe(429);
    });

    it('should return 429 with proper error body and retryAfter when blocked', async () => {
      for (let i = 0; i < 10; i++) {
        await request(app).get('/api/v1/data');
      }

      const res = await request(app).get('/api/v1/data');
      expect(res.status).toBe(429);
      expect(res.body.error).toBe('Too Many Requests');
      expect(res.body.retryAfter).toBeDefined();
    });

    it('should include Retry-After header on 429 response', async () => {
      for (let i = 0; i < 10; i++) {
        await request(app).get('/api/v1/data');
      }

      const res = await request(app).get('/api/v1/data');
      expect(res.headers['retry-after']).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // GET /api/health — should NEVER be rate limited
  // ------------------------------------------------------------------
  describe('GET /api/health', () => {
    it('should return 200 for all requests regardless of rate limits', async () => {
      for (let i = 0; i < 20; i++) {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
      }
    });
  });
});
