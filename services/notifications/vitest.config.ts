import { defineConfig } from 'vitest/config';

// Gate lane. The channel selection and the alert-level decision are pure; the
// SMTP transport is injected, so nothing here opens a socket.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
