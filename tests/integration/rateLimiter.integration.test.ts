import request from 'supertest';
import express from 'express';
import { FixedWindowStrategy } from '../../src/algorithms/FixedWindowStrategy';
import { createRateLimiterMiddleware } from '../../src/middleware/rateLimiter';
import { createApiRouter } from '../../src/routes/api';

/**
 * Integration Test: Rate Limiter Middleware
 *
 * This test uses a mock Redis client (no real Redis needed) but tests the
 * FULL request → middleware → route handler flow using supertest.
 *
 * If you want to test against a real Redis:
 *   1. Run: docker run -d -p 6379:6379 redis:alpine
 *   2. Replace mockRedisClient with the real getRedisClient()
 */

// Simulate a Redis client with a real incrementing counter in memory
function createMockRedisClient() {
  const counters: Record<string, number> = {};
  const ttls: Record<string, number> = {};

  return {
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
    ping: jest.fn(async () => 'PONG'),
    // Reset helper for test isolation
    _reset: () => {
      Object.keys(counters).forEach((k) => delete counters[k]);
      Object.keys(ttls).forEach((k) => delete ttls[k]);
    },
  };
}

describe('Rate Limiter Integration', () => {
  let app: express.Application;
  let mockRedis: ReturnType<typeof createMockRedisClient>;

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    mockRedis._reset();

    const strategy = new FixedWindowStrategy(mockRedis as any, 10, 60);
    const rateLimiter = createRateLimiterMiddleware(strategy, 'fixed-window');

    app = express();
    app.set('trust proxy', 1);
    app.use('/api/v1', rateLimiter, createApiRouter(mockRedis as any));
    app.use('/api', createApiRouter(mockRedis as any));
  });

  describe('GET /api/v1/data', () => {
    it('should return 200 for the first request', async () => {
      const res = await request(app).get('/api/v1/data');
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Success! Here is your data.');
    });

    it('should include rate limit headers on every response', async () => {
      const res = await request(app).get('/api/v1/data');
      expect(res.headers['x-ratelimit-limit']).toBe('10');
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
      expect(res.headers['x-ratelimit-strategy']).toBe('fixed-window');
    });

    it('should allow first 10 requests and block the 11th', async () => {
      const statuses: number[] = [];

      // Fire 11 requests sequentially
      for (let i = 0; i < 11; i++) {
        const res = await request(app).get('/api/v1/data');
        statuses.push(res.status);
      }

      // First 10 → 200 OK
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      // 11th → 429 Too Many Requests
      expect(statuses[10]).toBe(429);
    });

    it('should return 429 with proper error body when blocked', async () => {
      // Exhaust the limit
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

  describe('GET /api/health', () => {
    it('should return 200 without going through rate limiter', async () => {
      // Health check should never be rate limited
      for (let i = 0; i < 20; i++) {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
      }
    });
  });
});
