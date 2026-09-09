import { readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

// P0-01 acceptance 4: the strict floor and the typecheck graph are mechanical, not habit.
type Refs = { path: string }[];
type Tsconfig = { extends?: string; compilerOptions?: Record<string, unknown>; references?: Refs };

const repo = new URL('../', import.meta.url);
const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, repo), 'utf8')) as Tsconfig;
const STRICT_FLAGS = ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes'] as const;

const members = ['apps', 'packages', 'adapters']
  .flatMap((root) =>
    readdirSync(new URL(root, repo), { recursive: true, encoding: 'utf8' })
      .filter((p) => p.endsWith('package.json') && !p.includes('node_modules'))
      .map((p) => `${root}/${dirname(p)}`),
  )
  .sort();

describe('workspace toolchain', () => {
  it.each(STRICT_FLAGS)('keeps %s on in the shared compiler base', (flag) => {
    expect(read('tsconfig.base.json').compilerOptions?.[flag]).toBe(true);
  });

  it('references every workspace member from the root solution', () => {
    const referenced = read('tsconfig.json').references?.map((r) => r.path) ?? [];
    expect(members.filter((m) => !referenced.includes(m))).toEqual([]);
  });

  // extends alone is not enough: a member can re-disable the floor in its own compilerOptions,
  // which tsc accepts silently and would make acceptance 4 true of one file, not of the repo.
  it.each(members)('%s inherits the strict base without opting out', (member) => {
    const cfg = read(`${member}/tsconfig.json`);
    expect(cfg.extends).toMatch(/tsconfig\.base\.json$/);
    for (const flag of STRICT_FLAGS) expect(cfg.compilerOptions?.[flag]).not.toBe(false);
  });
});
