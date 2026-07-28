import { RedisClientType } from 'redis';
import { TokenBucketStrategy } from '../../src/algorithms/TokenBucketStrategy';

/**
 * Unit Tests: TokenBucketStrategy
 *
 * The strategy now uses a Lua script (client.eval) for atomic execution.
 * We mock `eval` to return the tuple the Lua script would return:
 *   [allowed (0|1), limit, remaining, resetInSeconds]
 */

const mockRedisClient = {
  eval: jest.fn(),
};

describe('TokenBucketStrategy', () => {
  let strategy: TokenBucketStrategy;
  const LIMIT = 10;
  const WINDOW = 60;

  beforeEach(() => {
    jest.clearAllMocks();
    strategy = new TokenBucketStrategy(mockRedisClient as unknown as RedisClientType, LIMIT, WINDOW);
  });

  // ── Core allow / block ────────────────────────────────────────────────────

  it('should allow the first request and consume 1 token', async () => {
    mockRedisClient.eval.mockResolvedValue([1, 10, 9, 60]);

    const result = await strategy.consume('192.168.1.1');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.limit).toBe(10);
  });

  it('should block when 0 tokens are remaining', async () => {
    mockRedisClient.eval.mockResolvedValue([0, 10, 0, 6]);

    const result = await strategy.consume('192.168.1.1');

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.resetInSeconds).toBeGreaterThanOrEqual(1);
  });

  // ── Token refill logic ────────────────────────────────────────────────────

  it('should allow a request after partial token refill (Lua refill applied)', async () => {
    // Simulates Lua finding 0.5 tokens before refill → after 6s with rate 10/60,
    // 1 token refills, so the request is allowed again
    mockRedisClient.eval.mockResolvedValue([1, 10, 0, 6]);

    const result = await strategy.consume('192.168.1.1');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0); // bucket at ~0 after consuming the refilled token
  });

  it('should pass current timestamp (nowMs) as ARGV[3] for accurate refill calculation', async () => {
    mockRedisClient.eval.mockResolvedValue([1, 10, 9, 60]);

    const before = Date.now();
    await strategy.consume('192.168.1.1');
    const after = Date.now();

    const callArgs = mockRedisClient.eval.mock.calls[0];
    const passedNowMs = parseInt(callArgs[1].arguments[2], 10);

    // The timestamp passed to Lua must be within the wall-clock window of this test
    expect(passedNowMs).toBeGreaterThanOrEqual(before);
    expect(passedNowMs).toBeLessThanOrEqual(after);
  });

  // ── Redis key namespacing ─────────────────────────────────────────────────

  it('should use "tb:" prefix in Redis key so Token Bucket keys never collide with other algorithms', async () => {
    mockRedisClient.eval.mockResolvedValue([1, 10, 9, 60]);

    await strategy.consume('10.0.0.1');

    const callArgs = mockRedisClient.eval.mock.calls[0];
    expect(callArgs[1].keys[0]).toBe('tb:10.0.0.1');
  });

  // ── Fail-open ─────────────────────────────────────────────────────────────

  it('should fail open (allow request) when Redis eval throws', async () => {
    mockRedisClient.eval.mockRejectedValue(new Error('Redis connection lost'));

    const result = await strategy.consume('192.168.1.1');

    expect(result.allowed).toBe(true);
  });

  // ── Custom limit / window ─────────────────────────────────────────────────

  it('should pass custom limit and windowSeconds from tier config as ARGV[1] and ARGV[2]', async () => {
    mockRedisClient.eval.mockResolvedValue([1, 60, 59, 60]);

    await strategy.consume('192.168.1.1', 60, 60); // Pro tier: 60 req/min

    const callArgs = mockRedisClient.eval.mock.calls[0];
    expect(callArgs[1].arguments[0]).toBe('60'); // limit
    expect(callArgs[1].arguments[1]).toBe('60'); // windowSeconds
  });
});
