import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// M-04: emitted ESM must actually resolve under node.
//
// tsconfig.base.json previously set moduleResolution "bundler". Combined with the "type": "module"
// and "exports" fields each member declares, a package with more than one source file emitted
// extensionless relative specifiers -- `export { X } from './helper'`. tsc exited 0, verify exited
// 0, and node failed at import time with ERR_MODULE_NOT_FOUND. The failure was invisible until
// something actually imported the package.
//
// The base is now "nodenext", which turns that into a compile-time TS2835. These tests keep it that
// way, and check the emitted artefact rather than trusting the compiler flag alone.

type Tsconfig = { compilerOptions?: Record<string, unknown> };

const repo = new URL('../', import.meta.url);
const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, repo), 'utf8'));

const members = ['apps', 'packages', 'adapters']
  .flatMap((root) =>
    readdirSync(new URL(root, repo), { recursive: true, encoding: 'utf8' })
      .filter((p) => p.endsWith('package.json') && !p.includes('node_modules'))
      .map((p) => `${root}/${dirname(p)}`),
  )
  .sort();

// apps/web is built by Vite, which resolves extensionless specifiers itself. It is the one
// documented exception, and it is named here so adding a second one has to be deliberate.
const BUNDLER_EXCEPTIONS = ['apps/web'];

const emittedJs = (member: string): string[] => {
  const out = (readJson(`${member}/tsconfig.json`) as Tsconfig).compilerOptions?.['outDir'];
  const root = new URL(`${member}/${String(out)}/`, repo);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.js'))
    .map((f) => join(root.pathname, f));
};

// `export { X } from './y'` / `import ... from './y'` with no extension. Directory specifiers are
// equally unresolvable under nodenext, so requiring a trailing extension covers both.
const EXTENSIONLESS = /\bfrom\s+'(\.[^']*?)'/g;

describe('emitted modules resolve under node', () => {
  it('base config pins nodenext so a bad specifier fails at compile time, not at import time', () => {
    const base = (readJson('tsconfig.base.json') as Tsconfig).compilerOptions ?? {};
    expect(String(base['module']).toLowerCase()).toBe('nodenext');
    expect(String(base['moduleResolution']).toLowerCase()).toBe('nodenext');
  });

  it.each(members.filter((m) => !BUNDLER_EXCEPTIONS.includes(m)))(
    '%s does not override the base resolution',
    (member) => {
      const own = (readJson(`${member}/tsconfig.json`) as Tsconfig).compilerOptions ?? {};
      for (const flag of ['module', 'moduleResolution']) {
        if (own[flag] !== undefined) expect(String(own[flag]).toLowerCase()).toBe('nodenext');
      }
    },
  );

  it.each(members)('%s emits no extensionless relative specifier', (member) => {
    for (const file of emittedJs(member)) {
      const offenders = [...readFileSync(file, 'utf8').matchAll(EXTENSIONLESS)]
        .map((m) => m[1] as string)
        .filter((spec) => !/\.[cm]?js$/.test(spec));
      expect({ file, offenders }).toEqual({ file, offenders: [] });
    }
  });

  it.each(members)('%s entry point exists and node can import it', async (member) => {
    const pkg = readJson(`${member}/package.json`) as { main?: string };
    const entry = new URL(`${member}/${String(pkg.main).replace(/^\.\//, '')}`, repo);
    expect(
      existsSync(entry),
      `${member}: ${String(pkg.main)} not emitted — run \`tsc -b\` first (\`pnpm verify\` does)`,
    ).toBe(true);
    await expect(import(entry.href)).resolves.toBeDefined();
  });
});
