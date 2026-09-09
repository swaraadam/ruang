import { readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

// P0-01 acceptance 4: the strict floor and the typecheck graph are mechanical, not habit.
type Refs = { path: string }[];
type Tsconfig = { extends?: string; compilerOptions?: Record<string, unknown>; references?: Refs };

const repo = new URL('../', import.meta.url);
const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, repo), 'utf8')) as Tsconfig;

const members = ['apps', 'packages', 'adapters']
  .flatMap((root) =>
    readdirSync(new URL(root, repo), { recursive: true, encoding: 'utf8' })
      .filter((p) => p.endsWith('package.json') && !p.includes('node_modules'))
      .map((p) => `${root}/${dirname(p)}`),
  )
  .sort();

describe('workspace toolchain', () => {
  it.each(['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes'])(
    'keeps %s on in the shared compiler base',
    (flag) => {
      expect(read('tsconfig.base.json').compilerOptions?.[flag]).toBe(true);
    },
  );

  it('references every workspace member from the root solution', () => {
    const referenced = read('tsconfig.json').references?.map((r) => r.path) ?? [];
    expect(members.filter((m) => !referenced.includes(m))).toEqual([]);
  });

  it.each(members)('%s inherits the strict base', (member) => {
    expect(read(`${member}/tsconfig.json`).extends).toMatch(/tsconfig\.base\.json$/);
  });
});
