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
    // Which algorithm to use: 'fixed-window' or 'sliding-window'
    strategy: process.env.RATE_LIMIT_STRATEGY || 'fixed-window',
  },
};

export default config;
