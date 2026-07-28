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
  const app = express();

  // Security headers (X-Frame-Options, HSTS, X-Content-Type-Options, etc.)
  // Disable CSP so inline scripts and Google Fonts in public/dashboard/index.html run cleanly
  app.use(
    helmet({
      contentSecurityPolicy: false,
    })
  );

  // Trust proxy headers for load balancers / cloud VMs
  app.set('trust proxy', 1);

  // Limit request body size to prevent memory exhaustion from oversized payloads
  app.use(express.json({ limit: '10kb' }));

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

  // --- Prometheus Metrics (no auth — scraper needs open access) ---
  app.use('/metrics', metricsRouter);

  // --- Admin Control Plane (protected by X-Admin-Key header auth) ---
  // adminAuth checks the X-Admin-Key header against ADMIN_API_KEY env var.
  // In production: missing key → 503. Wrong key → 401. Correct key → allowed.
  // In development: allowed without a key for local convenience.
  app.use('/api/admin', adminAuth, createAdminRouter(redisClient, dynamicConfigService));

  // --- Health Check & Public Routes (not rate-limited) ---
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
  // SIGTERM: sent by Cloud Run / Kubernetes when scaling down or redeploying
  // SIGINT:  sent by Ctrl+C in local development
  // We close the HTTP server first (stops accepting new requests), then close Redis.
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — starting graceful shutdown`);
    server.close(async () => {
      await closeRedisConnection();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    });

    // Safety net: force-kill if clean shutdown takes too long (e.g. hung Redis drain)
    setTimeout(() => {
      logger.error('Forced exit after timeout');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error('Failed to bootstrap server', { error: (err as Error).message });
  process.exit(1);
});
