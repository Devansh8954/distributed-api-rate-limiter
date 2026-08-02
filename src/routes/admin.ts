import { Router, Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { DynamicConfigService, StrategyType } from '../services/dynamicConfig';
import { TelemetryService } from '../services/telemetry';
import logger from '../utils/logger';

const VALID_STRATEGIES: StrategyType[] = ['fixed-window', 'sliding-window', 'token-bucket', 'sliding-window-counter'];

/** Admin Control Plane — view/change config, inspect Redis keys, stream live telemetry */
export function createAdminRouter(redisClient: RedisClientType, dynamicConfigService: DynamicConfigService): Router {
  const router   = Router();
  const telemetry = TelemetryService.getInstance();

  /** GET /api/admin/config — current algorithm, defaults, tiers, and all available strategies */
  router.get('/config', (_req: Request, res: Response) => {
    res.json({
      activeStrategy: dynamicConfigService.getActiveStrategy().name,
      defaults:       dynamicConfigService.getGlobalDefaults(),
      tiers:          dynamicConfigService.getAllTiers(),
      availableStrategies: [
        { id: 'fixed-window',           name: 'Fixed Window Counter',              description: 'O(1) time & space. Fast INCR. Has boundary-burst edge case.' },
        { id: 'sliding-window',         name: 'Sliding Window Log',                description: 'O(log N) via Redis Sorted Set. 100% accurate, higher memory.' },
        { id: 'token-bucket',           name: 'Token Bucket',                      description: 'Smooth burst handling via continuous token refill.' },
        { id: 'sliding-window-counter', name: 'Sliding Window Counter (Lua)',      description: 'Atomic Lua script. O(1) memory + weighted accuracy (Cloudflare/Stripe pattern).' },
      ],
    });
  });

  /** POST /api/admin/config — hot-swap algorithm or update global limits (no restart needed) */
  router.post('/config', (req: Request, res: Response) => {
    const { strategy, limit, windowSeconds } = req.body as { strategy?: StrategyType; limit?: number; windowSeconds?: number };

    if (strategy) {
      if (!VALID_STRATEGIES.includes(strategy)) {
        res.status(400).json({ error: `Invalid strategy. Must be one of: ${VALID_STRATEGIES.join(', ')}.` });
        return;
      }
      dynamicConfigService.updateActiveStrategy(strategy);
      logger.info('Strategy changed', { newStrategy: strategy });
    }

    if (limit !== undefined || windowSeconds !== undefined) {
      const l = Number(limit), w = Number(windowSeconds);
      if (!Number.isFinite(l) || l < 1 || l > 100_000 || !Number.isFinite(w) || w < 1 || w > 86_400) {
        res.status(400).json({ error: 'limit must be 1–100000; windowSeconds must be 1–86400.' });
        return;
      }
      dynamicConfigService.updateGlobalDefaults(l, w);
      logger.info('Defaults updated', { limit: l, windowSeconds: w });
    }

    res.json({
      message: 'Configuration updated. Changes take effect immediately.',
      activeStrategy: dynamicConfigService.getActiveStrategy().name,
      defaults: dynamicConfigService.getGlobalDefaults(),
    });
  });

  /** GET /api/admin/redis-keys — scan all active rate-limit keys with values and TTLs */
  router.get('/redis-keys', async (_req: Request, res: Response) => {
    try {
      const keys: string[] = [];
      let cursor = 0;
      // SCAN is non-blocking (safe in production, unlike KEYS which freezes Redis)
      do { const r = await redisClient.scan(cursor, { MATCH: '*', COUNT: 100 }); cursor = r.cursor; keys.push(...r.keys); }
      while (cursor !== 0);

      const details = await Promise.all(
        keys.slice(0, 50).map(async (key) => {
          const [ttl, type] = await Promise.all([redisClient.ttl(key), redisClient.type(key)]);
          const value = type === 'string' ? await redisClient.get(key)
                      : type === 'zset'   ? `${await redisClient.zCard(key)} entries`
                      : `[${type}]`;
          return { key, type, value, ttlSeconds: ttl };
        })
      );

      res.json({ totalActiveKeys: keys.length, keys: details });
    } catch (err) {
      logger.error('Redis key scan failed', { error: (err as Error).message });
      res.status(500).json({ error: 'Failed to scan Redis keys' });
    }
  });

  /**
   * GET /api/admin/events — SSE stream for the live dashboard.
   * Sends history on connect, then pushes each new request event in real time.
   */
  router.get('/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();
    telemetry.addClient(res);
    req.on('close', () => telemetry.removeClient(res));
  });

  /** POST /api/admin/simulate — fire a configurable burst of requests for dashboard demo */
  router.post('/simulate', async (req: Request, res: Response) => {
    const { count = 20, tier = 'free', delayMs = 50 } = req.body as { count?: number; tier?: string; delayMs?: number };
    const endpoint = `http://localhost:${process.env.PORT || 3000}/api/v1/data`;
    const results: Array<{ id: number; status: number; allowed: boolean }> = [];

    for (let i = 1; i <= count; i++) {
      try {
        const r = await fetch(endpoint, { headers: { 'x-client-tier': tier } });
        results.push({ id: i, status: r.status, allowed: r.status === 200 });
      } catch { results.push({ id: i, status: 500, allowed: false }); }

      if (delayMs > 0 && i < count) await new Promise((r) => setTimeout(r, delayMs));
    }

    const allowed = results.filter((r) => r.allowed).length;
    res.json({ summary: { totalSent: count, allowed, blocked: count - allowed, tier }, results });
  });

  return router;
}
