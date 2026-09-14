import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their sources here, not to `dist/`. Gate condition 0.4 runs
// `vitest run tests/contract/` directly, with no build step in front of it; resolving `@internal/*`
// through each package's `exports` map would make the suite fail on an unbuilt tree and report that
// as a failing contract, which is a false verdict about the adapter. That emitted ESM resolves
// under plain node is a separate claim, proven in a real subprocess by module-resolution.test.ts.
const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@internal/adapter-domain-code': source('./adapters/domain/code/src/index.ts'),
      '@internal/domain': source('./packages/domain/src/index.ts'),
      '@internal/protocol': source('./packages/protocol/src/index.ts'),
    },
  },
  test: {
    include: ['{tests,apps,packages,adapters}/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.sandboxes/**'],
    // No `retry`, deliberately. Gate condition 0.4 reads this runner's counters: a retried test
    // that passes on the second attempt is reported as passed, so a global retry would make
    // every 0.4 PASS silently tolerate a flake. contract-testing SKILL §"Domain adapter
    // contract" item 6 requires a flaky pass to stay distinguishable from a clean one.
  },
});
