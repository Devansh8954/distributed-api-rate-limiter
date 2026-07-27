import request from 'supertest';
import express from 'express';
import { createRateLimiterMiddleware } from '../../src/middleware/rateLimiter';
import { createApiRouter } from '../../src/routes/api';
import { DynamicConfigService } from '../../src/services/dynamicConfig';

/**
 * Integration Test: Rate Limiter Middleware
 */

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
    _reset: () => {
      Object.keys(counters).forEach((k) => delete counters[k]);
      Object.keys(ttls).forEach((k) => delete ttls[k]);
    },
  };
}

describe('Rate Limiter Integration', () => {
  let app: express.Application;
  let mockRedis: ReturnType<typeof createMockRedisClient>;
  let dynamicConfigService: DynamicConfigService;

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    mockRedis._reset();

    dynamicConfigService = new DynamicConfigService(mockRedis as any);
    const rateLimiter = createRateLimiterMiddleware(dynamicConfigService);

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

      for (let i = 0; i < 11; i++) {
        const res = await request(app).get('/api/v1/data');
        statuses.push(res.status);
      }

      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it('should return 429 with proper error body when blocked', async () => {
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
      for (let i = 0; i < 20; i++) {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
      }
    });
  });
});
