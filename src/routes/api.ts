import { Router, Request, Response } from 'express';
import { RedisClientType } from 'redis';
import config from '../config';

export function createApiRouter(redisClient: RedisClientType) {
  const router = Router();

  /**
   * GET /api/v1/data
   *
   * The main protected endpoint — the one the rate limiter guards.
   * In a real app, this would call a downstream microservice or database.
   */
  router.get('/data', (_req: Request, res: Response) => {
    res.status(200).json({
      message: 'Success! Here is your data.',
      timestamp: new Date().toISOString(),
      server: 'api-rate-limiter-gateway',
      version: 'v1',
    });
  });

  /**
   * GET /api/health
   *
   * Health check endpoint used by:
   *   - Docker HEALTHCHECK instruction
   *   - Load balancers (GCP, AWS ALB)
   *   - Monitoring tools (Uptime Robot, Datadog)
   *
   * It pings Redis to verify the full stack is healthy, not just Express.
   * Returns 503 if Redis is unreachable.
   */
  router.get('/health', async (_req: Request, res: Response) => {
    try {
      await redisClient.ping(); // throws if Redis is down
      res.status(200).json({
        status: 'ok',
        redis: 'connected',
        strategy: config.rateLimit.strategy,
        limit: config.rateLimit.limit,
        windowSeconds: config.rateLimit.windowSeconds,
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    } catch {
      // 503 Service Unavailable — let the load balancer know to stop routing here
      res.status(503).json({
        status: 'degraded',
        redis: 'disconnected',
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
