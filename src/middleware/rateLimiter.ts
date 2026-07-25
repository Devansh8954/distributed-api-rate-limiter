import { Request, Response, NextFunction } from 'express';
import { IRateLimiterStrategy } from '../algorithms/IRateLimiterStrategy';
import logger from '../utils/logger';
import { blockedRequestsCounter, rateLimitRemainingGauge } from '../routes/metrics';

/**
 * Rate Limiter Middleware Factory
 *
 * Returns an Express middleware function configured with the given strategy.
 * The middleware sits between every incoming request and the route handler —
 * it decides whether to pass the request along (next()) or block it (429).
 *
 * Response headers follow the IETF draft standard:
 * https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers
 *
 * Headers set on every response:
 *   X-RateLimit-Limit     — max requests allowed per window
 *   X-RateLimit-Remaining — how many the client has left
 *   X-RateLimit-Reset     — seconds until the window resets
 *   X-RateLimit-Strategy  — which algorithm is running (useful for debugging)
 *
 * Additional header on 429:
 *   Retry-After           — seconds until the client should retry
 */
export function createRateLimiterMiddleware(
  strategy: IRateLimiterStrategy,
  strategyName: string
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // req.ip is the connecting IP. Behind a load balancer you'd use
    // req.headers['x-forwarded-for'] — but req.ip is correct for direct connections.
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

    try {
      const result = await strategy.consume(clientIp);

      // Set informational headers on every response (allowed AND blocked)
      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', result.resetInSeconds);
      res.setHeader('X-RateLimit-Strategy', strategyName);

      if (!result.allowed) {
        // Tell the client how long to wait before retrying
        res.setHeader('Retry-After', result.resetInSeconds);

        logger.warn('Rate limit exceeded — request blocked', {
          ip: clientIp,
          retryAfter: result.resetInSeconds,
          strategy: strategyName,
        });

        // Increment Prometheus counter for blocked requests
        blockedRequestsCounter.inc({ strategy: strategyName });

        res.status(429).json({
          error: 'Too Many Requests',
          message: 'You have exceeded the rate limit. Please slow down.',
          retryAfter: result.resetInSeconds,
        });
        return; // Stop — don't call next()
      }

      // Update Prometheus gauge for remaining requests
      rateLimitRemainingGauge.set({ ip: clientIp }, result.remaining);

      logger.info('Request allowed', {
        ip: clientIp,
        remaining: result.remaining,
        strategy: strategyName,
      });

      next(); // Let the request through to the route handler
    } catch (err) {
      // Fail-open design: if Redis crashes, we still allow requests
      // Reason: it's better to serve traffic than to take down the whole API
      // Alternative "fail-closed" would block all requests if Redis is down.
      logger.error('Rate limiter error — failing open', {
        error: (err as Error).message,
        ip: clientIp,
      });
      next();
    }
  };
}
