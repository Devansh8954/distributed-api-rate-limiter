import { Router, Request, Response } from 'express';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

// Isolated registry prevents metric conflicts between test runs
export const register = new Registry();
collectDefaultMetrics({ register });

/** Total requests blocked by the rate limiter — alert on spikes */
export const blockedRequestsCounter = new Counter({
  name: 'rate_limit_blocked_total',
  help: 'Total requests blocked by the rate limiter',
  labelNames: ['strategy'],
  registers: [register],
});

/** Remaining budget per IP — tracks how close clients are to the limit */
export const rateLimitRemainingGauge = new Gauge({
  name: 'rate_limit_remaining',
  help: 'Remaining requests allowed in current window per client IP',
  labelNames: ['ip'],
  registers: [register],
});

// GET /metrics — Prometheus scrapes this every 15s (no rate-limit applied)
const router = Router();
router.get('/', async (_req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});

export default router;
