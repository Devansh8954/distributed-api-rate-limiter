import express from 'express';
import config from './config';
import { getRedisClient, closeRedisConnection } from './services/redisClient';
import { FixedWindowStrategy } from './algorithms/FixedWindowStrategy';
import { SlidingWindowStrategy } from './algorithms/SlidingWindowStrategy';
import { IRateLimiterStrategy } from './algorithms/IRateLimiterStrategy';
import { createRateLimiterMiddleware } from './middleware/rateLimiter';
import { createApiRouter } from './routes/api';
import metricsRouter from './routes/metrics';
import logger from './utils/logger';

async function bootstrap() {
  const app = express();

  // Trust proxy headers (needed for correct req.ip behind a load balancer)
  app.set('trust proxy', 1);
  app.use(express.json());

  // --- Connect to Redis ---
  const redisClient = await getRedisClient();

  // --- Select Rate Limiting Algorithm (Strategy Pattern) ---
  // Swap algorithms without changing any other code — just the env var
  let strategy: IRateLimiterStrategy;
  let strategyName: string;

  if (config.rateLimit.strategy === 'sliding-window') {
    strategy = new SlidingWindowStrategy(
      redisClient,
      config.rateLimit.limit,
      config.rateLimit.windowSeconds
    );
    strategyName = 'sliding-window';
  } else {
    strategy = new FixedWindowStrategy(
      redisClient,
      config.rateLimit.limit,
      config.rateLimit.windowSeconds
    );
    strategyName = 'fixed-window';
  }

  logger.info(`Rate limiter initialized`, {
    strategy: strategyName,
    limit: config.rateLimit.limit,
    windowSeconds: config.rateLimit.windowSeconds,
  });

  // --- Mount Routes ---

  // /metrics — Prometheus scrape endpoint (NO rate limiting)
  app.use('/metrics', metricsRouter);

  // /api/health — Health check (NO rate limiting — monitors must always work)
  app.use('/api', createApiRouter(redisClient));

  // /api/v1/* — Protected routes (rate limiting APPLIED here)
  const rateLimiter = createRateLimiterMiddleware(strategy, strategyName);
  app.use('/api/v1', rateLimiter, createApiRouter(redisClient));

  // --- 404 Handler ---
  app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
  });

  // --- Start Server ---
  const server = app.listen(config.port, () => {
    logger.info(`API Gateway started`, { port: config.port, env: config.nodeEnv });
    logger.info('Available endpoints', {
      protected: `http://localhost:${config.port}/api/v1/data`,
      health:    `http://localhost:${config.port}/api/health`,
      metrics:   `http://localhost:${config.port}/metrics`,
    });
  });

  // --- Graceful Shutdown ---
  // Allows in-flight requests to complete before closing connections
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — starting graceful shutdown`);
    server.close(async () => {
      await closeRedisConnection();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    });

    // Force exit after 10 seconds if something hangs
    setTimeout(() => {
      logger.error('Forced exit after timeout');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM')); // Docker stop
  process.on('SIGINT',  () => shutdown('SIGINT'));  // Ctrl+C
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap server:', err);
  process.exit(1);
});
