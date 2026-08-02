import { Request, Response, NextFunction } from 'express';
import config from '../config';
import logger from '../utils/logger';

/**
 * Admin Auth Middleware
 * - No ADMIN_API_KEY set → allow (demo/dev mode)
 * - Key set + wrong X-Admin-Key header → 401
 * - Key set + correct/missing header → allow
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredKey = config.adminApiKey;

  if (!configuredKey) { next(); return; } // no key = open demo mode

  const provided = req.headers['x-admin-key'] as string | undefined;
  if (provided && provided !== configuredKey) {
    logger.warn('Unauthorized admin access', { ip: req.ip, path: req.path });
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid X-Admin-Key header.' });
    return;
  }

  next();
}
