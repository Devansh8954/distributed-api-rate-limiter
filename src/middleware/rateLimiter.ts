import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DynamicConfigService } from '../services/dynamicConfig';
import { TelemetryService } from '../services/telemetry';
import { blockedRequestsCounter, rateLimitRemainingGauge } from '../routes/metrics';
import logger from '../utils/logger';

/** Factory: returns a rate-limiter middleware bound to the given DynamicConfigService */
export function createRateLimiterMiddleware(dynamicConfigService: DynamicConfigService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const clientIp  = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const tierHeader = (req.headers['x-client-tier'] || req.headers['x-api-key']) as string | undefined;
    const tierConfig = dynamicConfigService.getTierConfig(tierHeader);
    const rateLimitKey = `${tierConfig.name.toLowerCase().replace(/\s+/g, '-')}:${clientIp}`;
    const { name: strategyName, strategy } = dynamicConfigService.getActiveStrategy();

    try {
      const result = await strategy.consume(rateLimitKey, tierConfig.limit, tierConfig.windowSeconds);

      // Set standard rate-limit response headers
      res.setHeader('X-RateLimit-Limit',     result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset',     result.resetInSeconds);
      res.setHeader('X-RateLimit-Strategy',  strategyName);
      res.setHeader('X-RateLimit-Tier',      tierConfig.name);

      // Build telemetry event once (used for both allowed and blocked paths)
      const event = {
        id: uuidv4(), timestamp: new Date().toISOString(),
        ip: clientIp, tier: tierConfig.name,
        endpoint: req.originalUrl || req.url, method: req.method,
        allowed: result.allowed, statusCode: result.allowed ? 200 : 429,
        strategy: strategyName, remaining: result.remaining,
        limit: result.limit, resetInSeconds: result.resetInSeconds,
      };

      if (!result.allowed) {
        res.setHeader('Retry-After', result.resetInSeconds);
        logger.warn('Rate limit exceeded', { ip: clientIp, tier: tierConfig.name, strategy: strategyName });
        blockedRequestsCounter.inc({ strategy: strategyName });
        TelemetryService.getInstance().broadcast(event);
        res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit exceeded for ${tierConfig.name}. Max ${result.limit} req/${tierConfig.windowSeconds}s.`,
          retryAfter: result.resetInSeconds,
          tier: tierConfig.name, strategy: strategyName,
        });
        return;
      }

      rateLimitRemainingGauge.set({ ip: clientIp }, result.remaining);
      TelemetryService.getInstance().broadcast(event);
      logger.info('Request allowed', { ip: clientIp, tier: tierConfig.name, remaining: result.remaining });
      next();
    } catch (err) {
      logger.error('Rate limiter error — failing open', { error: (err as Error).message, ip: clientIp });
      next(); // fail-open: never block a request due to infrastructure error
    }
  };
}
