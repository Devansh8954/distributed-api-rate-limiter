import dotenv from 'dotenv';

dotenv.config();

// All environment config lives here — never scatter process.env calls across files
const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  rateLimit: {
    // How many requests are allowed per window per IP
    limit: parseInt(process.env.RATE_LIMIT || '10', 10),
    // Duration of each rate-limit window in seconds
    windowSeconds: parseInt(process.env.WINDOW_SECONDS || '60', 10),
    // Which algorithm to use: 'fixed-window' | 'sliding-window' | 'token-bucket' | 'sliding-window-counter'
    strategy: process.env.RATE_LIMIT_STRATEGY || 'fixed-window',
  },

  // Secret key required to access /api/admin/* endpoints.
  // Generate with: openssl rand -hex 32
  // In production, set this or the admin plane will be disabled.
  adminApiKey: process.env.ADMIN_API_KEY || '',
};

export default config;
