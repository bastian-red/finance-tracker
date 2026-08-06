import { defineConfig } from 'vitest/config';

// Integration lane: needs a real Postgres and a real Redis. These tests are the
// proof of the properties the README claims -- the budget exclusion constraint
// under concurrency, the monthly rollup's query plan, cache invalidation on
// write, import idempotence -- so they run against real infrastructure rather
// than against mocks. A mocked Postgres cannot refuse an overlapping budget.
//
// Serial by design: several of them assert on row counts for one seeded user,
// and the concurrency test deliberately races two writers, so a second file
// running at the same time would make the count non-deterministic.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
