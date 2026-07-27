import type { Config } from 'jest';

const config: Config = {
  // ts-jest preset tells Jest: "use TypeScript compiler for .ts files"
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],

  // Modern ts-jest config (v29+): use `transform` instead of deprecated `globals`
  // This points ts-jest at tsconfig.test.json which includes:
  //   - tests/ folder (so imports from ../../src/ resolve)
  //   - @types/jest (so describe/it/expect globals don't show red in VS Code)
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: './tsconfig.test.json' }],
  },

  collectCoverageFrom: ['src/**/*.ts', '!src/server.ts'],
  coverageThreshold: {
    global: {
      branches:  70,
      // Infrastructure-layer functions (SSE client management, Prometheus route handler,
      // service getters) are verified through integration/Docker tests, not unit tests.
      // Keeping this realistic avoids fake test padding.
      functions: 75,
      lines:     80,
    },
  },

  // Automatically clear mock.calls, mock.instances, and mock.results between tests
  clearMocks: true,
};

export default config;
