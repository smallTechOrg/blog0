import path from 'node:path';

import { defineConfig } from 'vitest/config';

// Projects: `unit` (deterministic, no I/O) and `integration` (real blog0_test Postgres + real
// OpenRouter key from .env; serial). Run: pnpm test:unit | pnpm test:integration | pnpm test

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@': path.join(root, 'src'),
      // `server-only` throws outside the React server condition; under Vitest it is a no-op.
      'server-only': path.join(root, 'node_modules', 'server-only', 'empty.js'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/setup/global-setup.ts'],
          setupFiles: ['tests/setup/integration-env.ts'],
          // Serial files (Vitest 3.2 does not accept `fileParallelism` per project; one fork = one file at a time).
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
