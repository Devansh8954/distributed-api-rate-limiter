/**
 * The result object every rate-limiting algorithm must return.
 * Standardized so the middleware doesn't care which algorithm runs underneath.
 */
export interface RateLimiterResult {
  allowed: boolean;        // true = let the request through
  limit: number;           // configured max requests per window
  remaining: number;       // how many requests the client has left
  resetInSeconds: number;  // seconds until the window resets
}

/**
 * Strategy Interface — the contract every algorithm must implement.
 *
 * Pluggable Strategy Pattern:
 * - Fixed Window Counter
 * - Sliding Window Log (Sorted Set)
 * - Token Bucket
 * - Sliding Window Counter (Atomic Lua Script)
 */
export interface IRateLimiterStrategy {
  consume(key: string, customLimit?: number, customWindowSeconds?: number): Promise<RateLimiterResult>;
}
