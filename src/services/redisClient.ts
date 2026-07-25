import { createClient, RedisClientType } from 'redis';
import logger from '../utils/logger';
import config from '../config';

// Module-level singleton — one Redis connection shared across the entire app
let client: RedisClientType | null = null;

/**
 * Returns a connected Redis client (singleton pattern).
 * Creates the connection on the first call, reuses it on subsequent calls.
 */
export async function getRedisClient(): Promise<RedisClientType> {
  if (client) return client;

  client = createClient({ url: config.redis.url }) as RedisClientType;

  client.on('error', (err: Error) => {
    logger.error('Redis client error', { error: err.message });
  });

  client.on('connect', () => {
    logger.info('Redis connected', { url: config.redis.url });
  });

  client.on('reconnecting', () => {
    logger.warn('Redis reconnecting...');
  });

  await client.connect();
  return client;
}

/**
 * Gracefully closes the Redis connection.
 * Called during server shutdown.
 */
export async function closeRedisConnection(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
    logger.info('Redis connection closed');
  }
}
