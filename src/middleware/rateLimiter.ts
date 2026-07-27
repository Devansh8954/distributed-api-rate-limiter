import { Request, Response, NextFunction } from 'express';
import { DynamicConfigService } from '../services/dynamicConfig';
import { TelemetryService } from '../services/telemetry';
import logger from '../utils/logger';
import { blockedRequestsCounter, rateLimitRemainingGauge } from '../routes/metrics';
import { v4 as uuidv4 } from 'uuid';

/**
 * Enhanced Rate Limiter Middleware Factory
 * Supports dynamic runtime strategy switching, multi-tenant tier limits, and live telemetry streaming.
 */
export function createRateLimiterMiddleware(dynamicConfigService: DynamicConfigService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const tierHeader = (req.headers['x-client-tier'] || req.headers['x-api-key']) as string | undefined;
    const tierConfig = dynamicConfigService.getTierConfig(tierHeader);

    // Key keying: ip + tier
    const rateLimitKey = `${tierConfig.name.toLowerCase().replace(/\s+/g, '-')}:${clientIp}`;

    const { name: strategyName, strategy } = dynamicConfigService.getActiveStrategy();

    try {
      const result = await strategy.consume(
        rateLimitKey,
        tierConfig.limit,
        tierConfig.windowSeconds
      );

      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', result.resetInSeconds);
      res.setHeader('X-RateLimit-Strategy', strategyName);
      res.setHeader('X-RateLimit-Tier', tierConfig.name);

      const telemetry = TelemetryService.getInstance();
      const event = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        ip: clientIp,
        tier: tierConfig.name,
        endpoint: req.originalUrl || req.url,
        method: req.method,
        allowed: result.allowed,
        statusCode: result.allowed ? 200 : 429,
        strategy: strategyName,
        remaining: result.remaining,
        limit: result.limit,
        resetInSeconds: result.resetInSeconds,
      };

      if (!result.allowed) {
        res.setHeader('Retry-After', result.resetInSeconds);

        logger.warn('Rate limit exceeded — request blocked', {
          ip: clientIp,
          tier: tierConfig.name,
          strategy: strategyName,
        });

        blockedRequestsCounter.inc({ strategy: strategyName });
        telemetry.broadcast(event);

        res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit exceeded for ${tierConfig.name}. Maximum ${result.limit} requests per ${tierConfig.windowSeconds}s allowed.`,
          retryAfter: result.resetInSeconds,
          tier: tierConfig.name,
          strategy: strategyName,
        });
        return;
      }

      rateLimitRemainingGauge.set({ ip: clientIp }, result.remaining);
      telemetry.broadcast(event);

      logger.info('Request allowed', {
        ip: clientIp,
        tier: tierConfig.name,
        remaining: result.remaining,
        strategy: strategyName,
      });

      next();
    } catch (err) {
      logger.error('Rate limiter error — failing open', {
        error: (err as Error).message,
        ip: clientIp,
      });
      next();
    }
  };
}
