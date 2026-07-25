import { Router, Request, Response } from 'express';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

// Each app has its own Registry to avoid conflicts during testing
export const register = new Registry();

// Collect built-in Node.js metrics (heap size, event loop lag, GC pauses, etc.)
collectDefaultMetrics({ register });

/**
 * Counter: total requests blocked by the rate limiter.
 * Useful to alert on: "more than X blocks per minute" → possible attack.
 */
export const blockedRequestsCounter = new Counter({
  name: 'rate_limit_blocked_total',
  help: 'Total number of requests blocked by the rate limiter',
  labelNames: ['strategy'],
  registers: [register],
});

/**
 * Gauge: remaining rate-limit budget for each IP.
 * Tracks how close clients are to hitting the limit.
 */
export const rateLimitRemainingGauge = new Gauge({
  name: 'rate_limit_remaining',
  help: 'Remaining requests allowed in the current window for a client IP',
  labelNames: ['ip'],
  registers: [register],
});

const router = Router();

/**
 * GET /metrics
 *
 * Prometheus scrapes this endpoint every 15s (by default).
 * Point a Prometheus + Grafana stack here to get dashboards.
 * This endpoint deliberately skips the rate limiter.
 */
router.get('/', async (_req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});

export default router;
