import { Router, Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { DynamicConfigService, StrategyType } from '../services/dynamicConfig';
import { TelemetryService } from '../services/telemetry';
import logger from '../utils/logger';

/**
 * Admin Router — Internal Control Plane API
 *
 * These routes expose the gateway's internal control panel for:
 *   - Viewing and changing the active rate-limiting algorithm at runtime
 *   - Inspecting live Redis rate-limit keys and TTLs
 *   - Streaming real-time telemetry events to the dashboard
 *   - Triggering synthetic traffic bursts for testing
 *
 * ⚠️  In production, these endpoints should be protected by an internal
 *      auth middleware (API key, JWT, or IP allowlist) before exposure.
 */
export function createAdminRouter(
  redisClient: RedisClientType,
  dynamicConfigService: DynamicConfigService
): Router {
  const router = Router();
  const telemetry = TelemetryService.getInstance();

  /**
   * GET /api/admin/config
   *
   * Returns the current gateway configuration:
   *  - Which rate-limiting algorithm is active
   *  - Default limit and window settings
   *  - All available algorithms with descriptions
   *  - All client tier definitions (Free, Pro, Enterprise)
   */
  router.get('/config', (_req: Request, res: Response) => {
    const { name: activeStrategy } = dynamicConfigService.getActiveStrategy();
    const defaults = dynamicConfigService.getGlobalDefaults();
    const tiers = dynamicConfigService.getAllTiers();

    res.json({
      activeStrategy,
      defaults,
      tiers,
      availableStrategies: [
        {
          id:          'fixed-window',
          name:        'Fixed Window Counter',
          description: 'O(1) time & space. Fast atomic Redis INCR counter. Has boundary burst edge case.',
        },
        {
          id:          'sliding-window',
          name:        'Sliding Window Log',
          description: 'O(log N) precision via Redis Sorted Set. 100% accurate. Higher memory per IP.',
        },
        {
          id:          'token-bucket',
          name:        'Token Bucket',
          description: 'Smooth burst traffic handling via continuous token refill rate.',
        },
        {
          id:          'sliding-window-counter',
          name:        'Sliding Window Counter (Lua Script)',
          description: 'Atomic Redis Lua script. O(1) memory with weighted sliding window accuracy. Cloudflare/Stripe pattern.',
        },
      ],
    });
  });

  /**
   * POST /api/admin/config
   *
   * Changes the active rate-limiting algorithm at runtime WITHOUT restarting the server.
   * This is the core "hot-swap" feature.
   *
   * Body: { strategy?: StrategyType, limit?: number, windowSeconds?: number }
   *
   * Example:
   *   POST /api/admin/config
   *   { "strategy": "sliding-window-counter" }
   *   → All subsequent requests immediately use the Lua script algorithm
   */
  router.post('/config', (req: Request, res: Response) => {
    const { strategy, limit, windowSeconds } = req.body as {
      strategy?: StrategyType;
      limit?: number;
      windowSeconds?: number;
    };

    if (strategy) {
      dynamicConfigService.updateActiveStrategy(strategy);
      logger.info('Rate limiting strategy changed', { newStrategy: strategy });
    }

    if (typeof limit === 'number' && typeof windowSeconds === 'number') {
      dynamicConfigService.updateGlobalDefaults(limit, windowSeconds);
      logger.info('Rate limit defaults updated', { limit, windowSeconds });
    }

    const { name: activeStrategy } = dynamicConfigService.getActiveStrategy();
    const defaults = dynamicConfigService.getGlobalDefaults();

    res.json({
      message: 'Configuration updated successfully. Changes take effect immediately.',
      activeStrategy,
      defaults,
    });
  });

  /**
   * GET /api/admin/redis-keys
   *
   * Scans Redis and returns all active rate-limit keys, their current values, and TTLs.
   * This lets you see exactly which clients are being tracked and how close they are to the limit.
   *
   * Key naming conventions:
   *   fw:{tier}:{ip}   → Fixed Window counter (string, integer value)
   *   sw:{tier}:{ip}   → Sliding Window log (sorted set, member count)
   *   tb:{tier}:{ip}   → Token Bucket state (string, JSON object)
   *   swc:{tier}:{ip}:{windowId} → Sliding Window Counter (string, integer)
   */
  router.get('/redis-keys', async (_req: Request, res: Response) => {
    try {
      const keys: string[] = [];
      let cursor = 0;

      // SCAN is non-blocking — safe to run in production (unlike KEYS which blocks Redis)
      do {
        const reply = await redisClient.scan(cursor, { MATCH: '*', COUNT: 100 });
        cursor = reply.cursor;
        keys.push(...reply.keys);
      } while (cursor !== 0);

      const keyDetails = await Promise.all(
        keys.slice(0, 50).map(async (key) => {
          const ttl  = await redisClient.ttl(key);
          const type = await redisClient.type(key);
          let val: unknown = null;

          if (type === 'string') {
            val = await redisClient.get(key);
          } else if (type === 'zset') {
            val = `${await redisClient.zCard(key)} entries`;
          } else {
            val = `[${type}]`;
          }

          return { key, type, value: val, ttlSeconds: ttl };
        })
      );

      res.json({ totalActiveKeys: keys.length, keys: keyDetails });
    } catch (err) {
      logger.error('Redis key scan failed', { error: (err as Error).message });
      res.status(500).json({ error: 'Failed to scan Redis keys', detail: (err as Error).message });
    }
  });

  /**
   * GET /api/admin/events
   *
   * Server-Sent Events (SSE) stream. The dashboard connects here to receive
   * real-time telemetry for every request passing through the rate limiter.
   *
   * SSE is a one-way push protocol (server → client) over a persistent HTTP connection.
   * No WebSocket needed — browsers handle SSE natively via EventSource.
   *
   * Events emitted:
   *   { type: 'history', events: [...] }  → on connect, sends last 100 events
   *   { type: 'event', event: {...} }     → on each new request
   */
  router.get('/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    telemetry.addClient(res);

    // Clean up when browser tab closes or client disconnects
    req.on('close', () => {
      telemetry.removeClient(res);
    });
  });

  /**
   * POST /api/admin/simulate
   *
   * Triggers a configurable burst of HTTP requests against the gateway's own /api/v1/data
   * endpoint. Useful for demonstrating rate limiting on the dashboard.
   *
   * Body: { count?: number, tier?: string, delayMs?: number }
   *   count   → Number of requests to fire (default: 20)
   *   tier    → Client tier header to send: 'free' | 'pro' | 'enterprise' (default: 'free')
   *   delayMs → Milliseconds between each request (default: 50ms)
   */
  router.post('/simulate', async (req: Request, res: Response) => {
    const { count = 20, tier = 'free', delayMs = 50 } = req.body as {
      count?: number;
      tier?: string;
      delayMs?: number;
    };

    const results: Array<{ id: number; status: number; allowed: boolean }> = [];
    const port = process.env.PORT || 3000;
    const endpoint = `http://localhost:${port}/api/v1/data`;

    for (let i = 1; i <= count; i++) {
      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: { 'x-client-tier': tier },
        });
        results.push({ id: i, status: response.status, allowed: response.status === 200 });
      } catch {
        results.push({ id: i, status: 500, allowed: false });
      }

      if (delayMs > 0 && i < count) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    const allowedCount = results.filter((r) => r.allowed).length;
    const blockedCount = count - allowedCount;

    res.json({
      summary: { totalSent: count, allowed: allowedCount, blocked: blockedCount, tier },
      results,
    });
  });

  return router;
}
