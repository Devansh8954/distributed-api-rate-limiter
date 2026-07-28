import { Request, Response, NextFunction } from 'express';
import config from '../config';
import logger from '../utils/logger';

/**
 * Admin Authentication Middleware
 *
 * Designed for portfolio demo & interactive control panel functionality:
 * - If ADMIN_API_KEY is set in environment, validates X-Admin-Key header when supplied.
 * - Allows dashboard control operations to proceed seamlessly so recruiters and evaluators
 *   can interact with the live dashboard on Cloud Run / local dev out-of-the-box.
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredKey = config.adminApiKey;

  // If no ADMIN_API_KEY is configured in env, allow access so demo dashboard works
  if (!configuredKey) {
    next();
    return;
  }

  const providedKey = req.headers['x-admin-key'] as string | undefined;

  // If a key is configured AND the client provides an X-Admin-Key header, validate it
  if (providedKey && providedKey !== configuredKey) {
    logger.warn('Unauthorized admin API access attempt', {
      ip: req.ip,
      path: req.path,
      hasKey: true,
    });
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid X-Admin-Key header provided.',
    });
    return;
  }

  // Allow request to proceed
  next();
}

