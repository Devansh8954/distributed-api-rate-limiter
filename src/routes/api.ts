import { Router, Request, Response } from 'express';
import { RedisClientType } from 'redis';

/**
 * API Router
 *
 * Creates and returns a configured Express Router with:
 *  - GET /data    → Main rate-limited endpoint (protected by rate limiter middleware)
 *  - GET /health  → Health check (NOT rate limited — monitors must always reach it)
 */
export function createApiRouter(redisClient: RedisClientType) {
  const router = Router();

  /**
   * GET /api/v1/data
   *
   * The main protected endpoint — this is what the rate limiter guards.
   * In a real application, this would proxy to a downstream microservice or database.
   *
   * Rate limiter middleware runs BEFORE this handler via server.ts:
   *   app.use('/api/v1', rateLimiter, createApiRouter(...))
   *                       ^^^^^^^^^^^
   *                       blocks here if over limit
   */
  router.get('/data', (_req: Request, res: Response) => {
    res.status(200).json({
      message:   'Success! Here is your data.',
      timestamp: new Date().toISOString(),
      server:    'api-rate-limiter-gateway',
      version:   'v1',
    });
  });

  /**
   * GET /api/health
   *
   * Health check endpoint used by:
   *   - Docker HEALTHCHECK instruction (Dockerfile)
   *   - Load balancers (GCP, AWS ALB) to route traffic away from unhealthy nodes
   *   - Kubernetes liveness/readiness probes
   *   - External monitoring (Uptime Robot, Datadog, PagerDuty)
   *
   * ✅ Returns 200 + {status: "ok"}     → Redis is connected, full stack healthy
   * ❌ Returns 503 + {status: "degraded"} → Redis unreachable, load balancer will stop routing here
   *
   * Intentionally NOT rate limited — monitoring tools call this constantly
   */
  router.get('/health', async (_req: Request, res: Response) => {
    try {
      await redisClient.ping(); // Throws if Redis is unreachable

      res.status(200).json({
        status:     'ok',
        redis:      'connected',
        uptime:     Math.floor(process.uptime()), // Server uptime in seconds
        timestamp:  new Date().toISOString(),
      });
    } catch {
      // 503 Service Unavailable — tells load balancers to stop sending traffic here
      res.status(503).json({
        status:    'degraded',
        redis:     'disconnected',
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
