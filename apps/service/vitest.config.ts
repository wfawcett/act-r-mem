import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // db.integration.test.ts drops and recreates every table, so test files
    // sharing the test database must not run against each other in parallel.
    fileParallelism: false,
  },
});
