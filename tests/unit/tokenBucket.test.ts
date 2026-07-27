import { TokenBucketStrategy } from '../../src/algorithms/TokenBucketStrategy';

const mockRedisClient = {
  get: jest.fn(),
  set: jest.fn(),
};

describe('TokenBucketStrategy', () => {
  let strategy: TokenBucketStrategy;
  const LIMIT = 10;
  const WINDOW = 60;

  beforeEach(() => {
    jest.clearAllMocks();
    strategy = new TokenBucketStrategy(mockRedisClient as any, LIMIT, WINDOW);
  });

  it('should allow first request and consume 1 token', async () => {
    mockRedisClient.get.mockResolvedValue(null);
    mockRedisClient.set.mockResolvedValue('OK');

    const result = await strategy.consume('192.168.1.1');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(mockRedisClient.set).toHaveBeenCalled();
  });

  it('should block when 0 tokens are remaining', async () => {
    mockRedisClient.get.mockResolvedValue(
      JSON.stringify({ tokens: 0, lastRefill: Date.now() })
    );
    mockRedisClient.set.mockResolvedValue('OK');

    const result = await strategy.consume('192.168.1.1');

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});
