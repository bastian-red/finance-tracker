import { defineConfig } from 'vitest/config';

// Gate lane. Everything up to `commit` is pure: bytes in, parsed rows out. The
// fixtures are real files on disk, which is deliberate -- a CSV parser that is
// only ever tested against string literals never meets a BOM or a CRLF.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
