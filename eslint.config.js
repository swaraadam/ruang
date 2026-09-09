import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// The recommended preset already registers **/*.ts, so `eslint .` reaches every workspace package.
export default tseslint.config(
  { ignores: ['**/dist/**', '.sandboxes/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
);
