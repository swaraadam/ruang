import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// M-04: emitted ESM must actually resolve under node.
//
// tsconfig.base.json previously set moduleResolution "bundler". Combined with the "type": "module"
// and "exports" fields each member declares, a package with more than one source file emitted
// extensionless relative specifiers -- `export { X } from './helper'`. tsc exited 0, verify exited
// 0, and node failed at import time with ERR_MODULE_NOT_FOUND.
//
// The base is now "nodenext", which makes that a compile-time TS2835. These tests keep it that way
// and check the emitted artefact, so flipping the flag back does not silently disarm them.
//
// Import checks run in a real `node` subprocess on purpose. An `import()` evaluated inside vitest
// goes through Vite's module runner, which resolves extensionless specifiers itself -- exactly the
// behaviour this file exists to outlaw. Verified: a module plain node rejects with
// ERR_MODULE_NOT_FOUND is imported happily by vitest.

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

// apps/web is bundled by Vite, which resolves extensionless specifiers itself, so its sources are
// allowed to write `from './App'`. Every other member must emit output node can load unaided.
const BUNDLER_EXCEPTIONS = ['apps/web'];
const nodeResolved = members.filter((m) => !BUNDLER_EXCEPTIONS.includes(m));

/** Import a file URL in a real node process. Returns node's own exit status and stderr. */
const nodeCanImport = (href: string) => {
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(href)})`],
    {
      encoding: 'utf8',
    },
  );
  return {
    ok: r.status === 0,
    err: (r.stderr || '').split('\n').find((l) => l.includes('Error')) ?? '',
  };
};

// Relative specifiers in `import`/`export ... from`, bare `import './x'`, and dynamic `import('./x')`,
// in either quote style. Anything not ending in a .js/.cjs/.mjs extension is unresolvable to node.
const RELATIVE_SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.[^'"]*)['"]/g;

const emittedJs = (member: string): string[] => {
  const out = (readJson(`${member}/tsconfig.json`) as Tsconfig).compilerOptions?.['outDir'];
  const root = new URL(`${member}/${String(out)}/`, repo);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.js'))
    .map((f) => fileURLToPath(new URL(f, root)));
};

const offendersIn = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(RELATIVE_SPECIFIER)]
    .map((m) => m[1] as string)
    .filter((spec) => !/\.[cm]?js$/.test(spec));

describe('emitted modules resolve under node', () => {
  it('base config pins nodenext so a bad specifier fails at compile time, not at import time', () => {
    const base = (readJson('tsconfig.base.json') as Tsconfig).compilerOptions ?? {};
    expect(String(base['module']).toLowerCase()).toBe('nodenext');
    expect(String(base['moduleResolution']).toLowerCase()).toBe('nodenext');
  });

  // Without this, widening the allowlist silently exempts a member: `it.each` over an empty list
  // contributes zero tests and fails nothing, so the only trace would be a falling test count.
  it('the bundler allowlist is exactly the Vite app', () => {
    expect(BUNDLER_EXCEPTIONS).toEqual(['apps/web']);
  });

  it.each(nodeResolved)('%s does not override the base resolution', (member) => {
    const own = (readJson(`${member}/tsconfig.json`) as Tsconfig).compilerOptions ?? {};
    for (const flag of ['module', 'moduleResolution']) {
      if (own[flag] !== undefined) expect(String(own[flag]).toLowerCase()).toBe('nodenext');
    }
  });

  it.each(nodeResolved)('%s emits no extensionless relative specifier', (member) => {
    for (const file of emittedJs(member)) {
      expect({ file, offenders: offendersIn(file) }).toEqual({ file, offenders: [] });
    }
  });

  it.each(nodeResolved)('%s entry point exists and real node can import it', (member) => {
    const pkg = readJson(`${member}/package.json`) as { main?: string };
    const entry = new URL(`${member}/${String(pkg.main).replace(/^\.\//, '')}`, repo);
    expect(
      existsSync(entry),
      `${member}: ${String(pkg.main)} not emitted — run \`tsc -b\` first (\`pnpm verify\` does)`,
    ).toBe(true);
    const { ok, err } = nodeCanImport(entry.href);
    expect({ member, ok, err }).toEqual({ member, ok: true, err: '' });
  });

  // Every member is a single `export {}` today, so the two checks above would pass on an empty
  // tree. This fixture is genuinely multi-file, which is the case that was broken.
  describe('multi-file fixture', () => {
    const fixture = new URL('tests/dist/fixtures/multifile/index.js', repo);

    it('is emitted', () => {
      expect(existsSync(fixture), 'run `tsc -b` first (`pnpm verify` does)').toBe(true);
    });

    it('emits an extension-carrying specifier', () => {
      expect(offendersIn(fileURLToPath(fixture))).toEqual([]);
      expect(readFileSync(fileURLToPath(fixture), 'utf8')).toMatch(/from\s+['"]\.\/helper\.js['"]/);
    });

    it('is importable by real node, not just by vitest', () => {
      expect(nodeCanImport(fixture.href)).toEqual({ ok: true, err: '' });
    });
  });
});
