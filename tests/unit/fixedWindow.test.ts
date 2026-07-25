import { FixedWindowStrategy } from '../../src/algorithms/FixedWindowStrategy';

// Mock the entire Redis client — we don't want a real Redis in unit tests
const mockRedisClient = {
  incr: jest.fn(),
  expire: jest.fn(),
  ttl: jest.fn(),
};

describe('FixedWindowStrategy', () => {
  let strategy: FixedWindowStrategy;
  const LIMIT = 10;
  const WINDOW = 60;

  beforeEach(() => {
    // Reset all mocks before each test
    jest.clearAllMocks();
    strategy = new FixedWindowStrategy(mockRedisClient as any, LIMIT, WINDOW);
  });

  describe('First request in a window', () => {
    it('should allow the request', async () => {
      mockRedisClient.incr.mockResolvedValue(1);
      mockRedisClient.expire.mockResolvedValue(1);
      mockRedisClient.ttl.mockResolvedValue(60);

      const result = await strategy.consume('192.168.1.1');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
      expect(result.limit).toBe(10);
    });

    it('should set EXPIRE on first request to start the window', async () => {
      mockRedisClient.incr.mockResolvedValue(1);
      mockRedisClient.expire.mockResolvedValue(1);
      mockRedisClient.ttl.mockResolvedValue(60);

      await strategy.consume('192.168.1.1');

      // Critical: EXPIRE must be called with the right key and TTL
      expect(mockRedisClient.expire).toHaveBeenCalledWith('fw:192.168.1.1', 60);
      expect(mockRedisClient.expire).toHaveBeenCalledTimes(1);
    });
  });

  describe('Subsequent requests', () => {
    it('should NOT call EXPIRE after the first request', async () => {
      // Simulate 5th request (window already running)
      mockRedisClient.incr.mockResolvedValue(5);
      mockRedisClient.ttl.mockResolvedValue(45);

      await strategy.consume('192.168.1.1');

      // If we called EXPIRE here, we'd keep resetting the window — that's a bug
      expect(mockRedisClient.expire).not.toHaveBeenCalled();
    });

    it('should return correct remaining count', async () => {
      mockRedisClient.incr.mockResolvedValue(7); // 7th request
      mockRedisClient.ttl.mockResolvedValue(30);

      const result = await strategy.consume('192.168.1.1');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(3); // 10 - 7 = 3
    });
  });

  describe('At the rate limit boundary', () => {
    it('should allow the 10th request (exactly at limit)', async () => {
      mockRedisClient.incr.mockResolvedValue(10);
      mockRedisClient.ttl.mockResolvedValue(5);

      const result = await strategy.consume('192.168.1.1');

      // The 10th request should still be allowed (count <= limit)
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('should block the 11th request (over limit)', async () => {
      mockRedisClient.incr.mockResolvedValue(11);
      mockRedisClient.ttl.mockResolvedValue(5);

      const result = await strategy.consume('192.168.1.1');

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.resetInSeconds).toBe(5);
    });
  });

  describe('Redis key namespacing', () => {
    it('should use "fw:" prefix in Redis key', async () => {
      mockRedisClient.incr.mockResolvedValue(1);
      mockRedisClient.expire.mockResolvedValue(1);
      mockRedisClient.ttl.mockResolvedValue(60);

      await strategy.consume('10.0.0.1');

      // Ensures Fixed Window and Sliding Window keys don't collide in Redis
      expect(mockRedisClient.incr).toHaveBeenCalledWith('fw:10.0.0.1');
    });
  });
});
