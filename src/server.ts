import express from 'express';
import helmet from 'helmet';
import path from 'path';
import config from './config';
import { getRedisClient, closeRedisConnection } from './services/redisClient';
import { DynamicConfigService } from './services/dynamicConfig';
import { createRateLimiterMiddleware } from './middleware/rateLimiter';
import { adminAuth } from './middleware/adminAuth';
import { createApiRouter } from './routes/api';
import { createAdminRouter } from './routes/admin';
import metricsRouter from './routes/metrics';
import logger from './utils/logger';

async function bootstrap() {
  const app        = express();
  const publicPath = path.join(__dirname, '../public');

  app.use(helmet({ contentSecurityPolicy: false })); // CSP off → inline scripts & Google Fonts work
  app.set('trust proxy', 1);                         // Trust cloud load-balancer IP headers
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(publicPath));
  app.get(['/', '/dashboard'], (_req, res) => res.sendFile(path.join(publicPath, 'dashboard/index.html')));

  // Connect Redis and build the dynamic config / strategy registry
  const redisClient          = await getRedisClient();
  const dynamicConfigService = new DynamicConfigService(redisClient);
  const { name: strategy }   = dynamicConfigService.getActiveStrategy();

  logger.info('Rate limiter initialized', { strategy, limit: config.rateLimit.limit, windowSeconds: config.rateLimit.windowSeconds });

  app.use('/metrics',    metricsRouter);                                              // Prometheus — no auth
  app.use('/api/admin',  adminAuth, createAdminRouter(redisClient, dynamicConfigService)); // Admin control plane
  app.use('/api',        createApiRouter(redisClient));                               // Health + unprotected API
  app.use('/api/v1',     createRateLimiterMiddleware(dynamicConfigService), createApiRouter(redisClient)); // Protected

  app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

  const server = app.listen(config.port, () => {
    logger.info('API Gateway started', { port: config.port, env: config.nodeEnv });
    logger.info('Endpoints', {
      dashboard: `http://localhost:${config.port}/dashboard`,
      protected: `http://localhost:${config.port}/api/v1/data`,
      health:    `http://localhost:${config.port}/api/health`,
      metrics:   `http://localhost:${config.port}/metrics`,
      admin:     `http://localhost:${config.port}/api/admin/config`,
    });
  });

  // Graceful shutdown: close HTTP first (drains in-flight requests), then Redis
  const shutdown = async (signal: string) => {
    logger.info(`${signal} — graceful shutdown started`);
    server.close(async () => { await closeRedisConnection(); logger.info('Shutdown complete'); process.exit(0); });
    setTimeout(() => { logger.error('Forced exit after timeout'); process.exit(1); }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

bootstrap().catch((err) => { logger.error('Bootstrap failed', { error: (err as Error).message }); process.exit(1); });
