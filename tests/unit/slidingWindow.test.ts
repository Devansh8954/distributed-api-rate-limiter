import { SlidingWindowStrategy } from '../../src/algorithms/SlidingWindowStrategy';

// Mock pipeline object returned by client.multi()
const mockPipeline = {
  zRemRangeByScore: jest.fn().mockReturnThis(),
  zCard: jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  exec: jest.fn(),
};

const mockRedisClient = {
  multi: jest.fn(() => mockPipeline),
  zAdd: jest.fn(),
};

describe('SlidingWindowStrategy', () => {
  let strategy: SlidingWindowStrategy;
  const LIMIT = 10;
  const WINDOW = 60;

  beforeEach(() => {
    jest.clearAllMocks();
    strategy = new SlidingWindowStrategy(mockRedisClient as any, LIMIT, WINDOW);
  });

  describe('When under the rate limit', () => {
    beforeEach(() => {
      // Pipeline returns: [zRemRange result, zCard result=3, expire result]
      mockPipeline.exec.mockResolvedValue([0, 3, 1]);
      mockRedisClient.zAdd.mockResolvedValue(1);
    });

    it('should allow the request', async () => {
      const result = await strategy.consume('192.168.1.1');
      expect(result.allowed).toBe(true);
    });

    it('should add the request to the sorted set', async () => {
      await strategy.consume('192.168.1.1');
      // zAdd should be called to log this request's timestamp
      expect(mockRedisClient.zAdd).toHaveBeenCalledTimes(1);
    });

    it('should return correct remaining count', async () => {
      // Pipeline says 3 requests in window, limit is 10
      const result = await strategy.consume('192.168.1.1');
      expect(result.remaining).toBe(6); // 10 - 3 - 1 (this request) = 6
    });
  });

  describe('When at the rate limit', () => {
    beforeEach(() => {
      // Pipeline returns count = 10 (at limit)
      mockPipeline.exec.mockResolvedValue([0, 10, 1]);
    });

    it('should block the request', async () => {
      const result = await strategy.consume('192.168.1.1');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should NOT add request to sorted set when blocked', async () => {
      await strategy.consume('192.168.1.1');
      // Blocked requests should NOT be logged — don't consume a slot
      expect(mockRedisClient.zAdd).not.toHaveBeenCalled();
    });
  });

  describe('Pipeline usage', () => {
    it('should use a pipeline to batch Redis commands', async () => {
      mockPipeline.exec.mockResolvedValue([0, 2, 1]);
      mockRedisClient.zAdd.mockResolvedValue(1);

      await strategy.consume('192.168.1.1');

      // All cleanup + counting happens in one pipeline round-trip
      expect(mockRedisClient.multi).toHaveBeenCalledTimes(1);
      expect(mockPipeline.zRemRangeByScore).toHaveBeenCalledTimes(1);
      expect(mockPipeline.zCard).toHaveBeenCalledTimes(1);
      expect(mockPipeline.exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('Redis key namespacing', () => {
    it('should use "sw:" prefix in Redis key', async () => {
      mockPipeline.exec.mockResolvedValue([0, 0, 1]);
      mockRedisClient.zAdd.mockResolvedValue(1);

      await strategy.consume('10.0.0.2');

      expect(mockPipeline.zRemRangeByScore).toHaveBeenCalledWith(
        'sw:10.0.0.2',
        expect.any(Number),
        expect.any(Number)
      );
    });
  });
});
