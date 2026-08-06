import { defineConfig } from 'vitest/config';

// Gate lane. The whole service is pure functions over a rule list and a
// transaction, so every test here is free and deterministic; nothing in this
// package touches a database, a clock or a network.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
