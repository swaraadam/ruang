import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{tests,apps,packages,adapters}/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.sandboxes/**'],
    // No `retry`, deliberately. Gate condition 0.4 reads this runner's counters: a retried test
    // that passes on the second attempt is reported as passed, so a global retry would make
    // every 0.4 PASS silently tolerate a flake. contract-testing SKILL §"Domain adapter
    // contract" item 6 requires a flaky pass to stay distinguishable from a clean one.
  },
});
