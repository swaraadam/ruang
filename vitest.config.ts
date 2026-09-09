import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{tests,apps,packages,adapters}/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.sandboxes/**'],
  },
});
