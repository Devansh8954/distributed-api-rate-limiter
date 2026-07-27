import { Request, Response, NextFunction } from 'express';
import config from '../config';
import logger from '../utils/logger';

/**
 * Admin Authentication Middleware
 *
 * Validates the X-Admin-Key header against the ADMIN_API_KEY environment variable.
 *
 * Behaviour matrix:
 *  ┌──────────────────────────┬─────────────┬──────────────────────────┐
 *  │ ADMIN_API_KEY configured │ Key correct │ Result                   │
 *  ├──────────────────────────┼─────────────┼──────────────────────────┤
 *  │ No  (production)         │ N/A         │ 503 — admin plane off    │
 *  │ No  (development/test)   │ N/A         │ Allowed (dev convenience) │
 *  │ Yes                      │ Yes         │ Allowed                  │
 *  │ Yes                      │ No/missing  │ 401 — Unauthorized       │
 *  └──────────────────────────┴─────────────┴──────────────────────────┘
 *
 * Generate a secure key with: openssl rand -hex 32
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredKey = config.adminApiKey;

  // No ADMIN_API_KEY env var set
  if (!configuredKey) {
    if (config.nodeEnv === 'production') {
      // Hard-disable admin plane in production if no key is configured
      res.status(503).json({
        error: 'Admin API Disabled',
        message: 'Set the ADMIN_API_KEY environment variable to enable the admin control plane.',
      });
      return;
    }
    // Development / test: allow without a key for local convenience
    next();
    return;
  }

  const providedKey = req.headers['x-admin-key'] as string | undefined;

  if (!providedKey || providedKey !== configuredKey) {
    logger.warn('Unauthorized admin API access attempt', {
      ip: req.ip,
      path: req.path,
      hasKey: !!providedKey,
    });
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Provide a valid X-Admin-Key header to access the admin control plane.',
    });
    return;
  }

  next();
}
