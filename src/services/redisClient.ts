import { createClient, RedisClientType } from 'redis';
import config from '../config';
import logger from '../utils/logger';

// Singleton: one Redis connection shared across the entire app
let client: RedisClientType | null = null;

/** Returns a connected Redis client, creating it on the first call. */
export async function getRedisClient(): Promise<RedisClientType> {
  if (client) return client;

  client = createClient({ url: config.redis.url }) as RedisClientType;
  client.on('error',       (err: Error) => logger.error('Redis client error', { error: err.message }));
  client.on('connect',     ()           => logger.info('Redis connected', { url: config.redis.url }));
  client.on('reconnecting',()           => logger.warn('Redis reconnecting...'));

  await client.connect();
  return client;
}

/** Gracefully closes the Redis connection during server shutdown. */
export async function closeRedisConnection(): Promise<void> {
  if (client) { await client.quit(); client = null; logger.info('Redis connection closed'); }
}
