import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // db.integration.test.ts drops and recreates every table, so test files
    // sharing the test database must not run against each other in parallel.
    // Integration tests here boot child processes and poll the queue over the
    // DB; on a cold/loaded box the 5 s default is too tight.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
