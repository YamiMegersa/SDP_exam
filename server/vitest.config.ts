import { defineConfig } from 'vitest/config';

/**
 * Tests run against the source, not `dist`, so a failing build cannot hide behind a stale compile.
 * Every test that needs a database uses `:memory:` or a temporary file, so `npm test` never touches
 * `data/arl.sqlite`.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Only the modules that carry marks (51 §4): a global figure would be met by untested glue.
    coverage: {
      provider: 'v8',
      include: ['src/alerts/**', 'src/topology/**', 'src/db/**', 'src/mqtt/**', 'src/commands/**'],
      reporter: ['text-summary', 'text'],
      reportsDirectory: '../.logs/coverage',
      thresholds: { lines: 80, functions: 80 },
    },
  },
});
