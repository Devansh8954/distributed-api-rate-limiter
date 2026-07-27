import { SlidingWindowCounterLuaStrategy } from '../../src/algorithms/SlidingWindowCounterLuaStrategy';

const mockRedisClient = {
  eval: jest.fn(),
};

describe('SlidingWindowCounterLuaStrategy', () => {
  let strategy: SlidingWindowCounterLuaStrategy;
  const LIMIT = 10;
  const WINDOW = 60;

  beforeEach(() => {
    jest.clearAllMocks();
    strategy = new SlidingWindowCounterLuaStrategy(mockRedisClient as any, LIMIT, WINDOW);
  });

  it('should allow request when Lua script returns allowed = 1', async () => {
    mockRedisClient.eval.mockResolvedValue([1, 10, 9, 60]);

    const result = await strategy.consume('192.168.1.1');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.limit).toBe(10);
    expect(mockRedisClient.eval).toHaveBeenCalled();
  });

  it('should block request when Lua script returns allowed = 0', async () => {
    mockRedisClient.eval.mockResolvedValue([0, 10, 0, 45]);

    const result = await strategy.consume('192.168.1.1');

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.resetInSeconds).toBe(45);
  });
});
