import express from 'express';
import path from 'path';
import config from './config';
import { getRedisClient, closeRedisConnection } from './services/redisClient';
import { DynamicConfigService } from './services/dynamicConfig';
import { createRateLimiterMiddleware } from './middleware/rateLimiter';
import { createApiRouter } from './routes/api';
import { createAdminRouter } from './routes/admin';
import metricsRouter from './routes/metrics';
import logger from './utils/logger';

async function bootstrap() {
  const app = express();

  // Trust proxy headers for load balancers / cloud VMs
  app.set('trust proxy', 1);
  app.use(express.json());

  // Serve Dashboard UI (static files)
  const publicPath = path.join(__dirname, '../public');
  app.use(express.static(publicPath));

  app.get(['/', '/dashboard'], (_req, res) => {
    res.sendFile(path.join(publicPath, 'dashboard/index.html'));
  });

  // --- Connect to Redis ---
  const redisClient = await getRedisClient();

  // --- Dynamic Config Service (Pluggable Strategies & Multi-Tenant Tiers) ---
  const dynamicConfigService = new DynamicConfigService(redisClient);
  const { name: activeStrategyName } = dynamicConfigService.getActiveStrategy();

  logger.info('Rate limiter initialized', {
    strategy: activeStrategyName,
    limit: config.rateLimit.limit,
    windowSeconds: config.rateLimit.windowSeconds,
  });

  // --- Mount Admin & Unprotected Routes ---
  app.use('/metrics', metricsRouter);
  app.use('/api/admin', createAdminRouter(redisClient, dynamicConfigService));

  // Health check endpoint (Unprotected)
  app.use('/api', createApiRouter(redisClient));

  // --- Protected API Routes (Rate Limiting Applied) ---
  const rateLimiter = createRateLimiterMiddleware(dynamicConfigService);
  app.use('/api/v1', rateLimiter, createApiRouter(redisClient));

  // --- 404 Handler ---
  app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
  });

  // --- Start Server ---
  const server = app.listen(config.port, () => {
    logger.info('API Gateway & Control Center started', { port: config.port, env: config.nodeEnv });
    logger.info('Available endpoints', {
      dashboard: `http://localhost:${config.port}/dashboard`,
      protected: `http://localhost:${config.port}/api/v1/data`,
      health:    `http://localhost:${config.port}/api/health`,
      metrics:   `http://localhost:${config.port}/metrics`,
      admin:     `http://localhost:${config.port}/api/admin/config`,
    });
  });

  // --- Graceful Shutdown ---
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — starting graceful shutdown`);
    server.close(async () => {
      await closeRedisConnection();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Forced exit after timeout');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap server:', err);
  process.exit(1);
});
