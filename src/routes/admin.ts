import { Router, Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { DynamicConfigService, StrategyType } from '../services/dynamicConfig';
import { TelemetryService } from '../services/telemetry';

export function createAdminRouter(
  redisClient: RedisClientType,
  dynamicConfigService: DynamicConfigService
): Router {
  const router = Router();
  const telemetry = TelemetryService.getInstance();

  // GET /api/admin/config
  router.get('/config', (_req: Request, res: Response) => {
    const { name: activeStrategy } = dynamicConfigService.getActiveStrategy();
    const defaults = dynamicConfigService.getGlobalDefaults();
    const tiers = dynamicConfigService.getAllTiers();

    res.json({
      activeStrategy,
      defaults,
      tiers,
      availableStrategies: [
        { id: 'fixed-window', name: 'Fixed Window Counter', description: 'O(1) memory & time. Ultra-fast, simple atomic counter.' },
        { id: 'sliding-window', name: 'Sliding Window Log (Sorted Set)', description: 'Perfect accuracy using Redis ZSET logs.' },
        { id: 'token-bucket', name: 'Token Bucket', description: 'Smooth burst traffic handling with dynamic token refill.' },
        { id: 'sliding-window-counter', name: 'Sliding Window Counter (Lua Script)', description: 'Atomic Lua script combining low memory with sliding accuracy.' },
      ],
    });
  });

  // POST /api/admin/config
  router.post('/config', (req: Request, res: Response) => {
    const { strategy, limit, windowSeconds } = req.body;

    if (strategy) {
      dynamicConfigService.updateActiveStrategy(strategy as StrategyType);
    }

    if (typeof limit === 'number' && typeof windowSeconds === 'number') {
      dynamicConfigService.updateGlobalDefaults(limit, windowSeconds);
    }

    const { name: activeStrategy } = dynamicConfigService.getActiveStrategy();
    const defaults = dynamicConfigService.getGlobalDefaults();

    res.json({
      message: 'Configuration updated successfully',
      activeStrategy,
      defaults,
    });
  });

  // GET /api/admin/redis-keys
  router.get('/redis-keys', async (_req: Request, res: Response) => {
    try {
      const keys: string[] = [];
      let cursor = 0;

      do {
        const reply = await redisClient.scan(cursor, {
          MATCH: '*',
          COUNT: 100,
        });
        cursor = reply.cursor;
        keys.push(...reply.keys);
      } while (cursor !== 0);

      const keyDetails = await Promise.all(
        keys.slice(0, 50).map(async (key) => {
          const ttl = await redisClient.ttl(key);
          const type = await redisClient.type(key);
          let val: unknown = null;

          if (type === 'string') {
            val = await redisClient.get(key);
          } else if (type === 'zset') {
            val = await redisClient.zCard(key);
          } else {
            val = `[${type}]`;
          }

          return { key, type, val, ttl };
        })
      );

      res.json({ totalKeys: keys.length, keys: keyDetails });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/events — SSE Stream
  router.get('/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    telemetry.addClient(res);

    req.on('close', () => {
      telemetry.removeClient(res);
    });
  });

  // POST /api/admin/simulate
  router.post('/simulate', async (req: Request, res: Response) => {
    const { count = 20, tier = 'free', delayMs = 50 } = req.body;
    const results: Array<{ id: number; status: number; allowed: boolean }> = [];

    // Internal simulation loop against gateway endpoint
    const port = process.env.PORT || 3000;
    const endpoint = `http://localhost:${port}/api/v1/data`;

    for (let i = 1; i <= count; i++) {
      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            'x-client-tier': tier,
          },
        });
        results.push({
          id: i,
          status: response.status,
          allowed: response.status === 200,
        });
      } catch {
        results.push({ id: i, status: 500, allowed: false });
      }

      if (delayMs > 0 && i < count) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    const allowedCount = results.filter((r) => r.allowed).length;
    const blockedCount = results.filter((r) => !r.allowed).length;

    res.json({
      summary: {
        totalSent: count,
        allowed: allowedCount,
        blocked: blockedCount,
        tier,
      },
      results,
    });
  });

  return router;
}
