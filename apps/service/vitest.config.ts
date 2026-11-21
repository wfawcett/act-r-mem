import { defineConfig } from 'vitest/config';

// Integration suites reset the shared test database (DROP + migrate) in beforeAll, so test
// files must not run in parallel against one DATABASE_URL.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
