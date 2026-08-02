import { Router, Request, Response } from 'express';
import { RedisClientType } from 'redis';

/** API Router: rate-limited /data endpoint + always-open /health check */
export function createApiRouter(redisClient: RedisClientType) {
  const router = Router();

  // Main protected endpoint — the rate limiter in server.ts guards this
  router.get('/data', (_req: Request, res: Response) => {
    res.json({ message: 'Success! Here is your data.', timestamp: new Date().toISOString(), server: 'api-rate-limiter-gateway', version: 'v1' });
  });

  /**
   * Health check — intentionally NOT rate-limited.
   * Returns 200 + {status:"ok"} when Redis is reachable; 503 when not.
   * Used by load balancers, Docker HEALTHCHECK, and monitoring tools.
   */
  router.get('/health', async (_req: Request, res: Response) => {
    try {
      await redisClient.ping();
      res.json({ status: 'ok', redis: 'connected', uptime: Math.floor(process.uptime()), timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', redis: 'disconnected', timestamp: new Date().toISOString() });
    }
  });

  return router;
}
