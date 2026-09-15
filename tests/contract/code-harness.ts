/**
 * The code adapter's harness for the shared contract suite.
 *
 * It lives under `tests/contract/` rather than beside the adapter on purpose: an adapter that
 * carries its own contract fixtures is one small step from carrying its own contract assertions,
 * and gate condition 0.4 cannot see anything under `adapters/`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodeAdapter } from '@internal/adapter-domain-code';
import type { Basis, Sandbox } from '@internal/domain';
import type { ContractHarness, ContractSubject } from './harness.js';

const git = (cwd: string, args: readonly string[]): void => {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fixture setup failed: git ${args.join(' ')}\n${r.stderr}`);
};

const CONSULTED = 'architecture.md';
const UNCONSULTED = 'gotchas.md';
const PROJECT = 'project-under-contract';
const CAPTURED_AT = '2026-09-13T00:00:00.000Z';

export const codeHarness: ContractHarness = {
  name: 'code',
  setUp: async (): Promise<ContractSubject> => {
    const root = mkdtempSync(join(tmpdir(), 'contract-code-'));
    const source = join(root, 'source');
    mkdirSync(source, { recursive: true });
    git(source, ['init', '-q', '-b', 'main', '.']);
    writeFileSync(join(source, CONSULTED), 'one\ntwo\nthree\n');
    writeFileSync(join(source, UNCONSULTED), 'unrelated\n');
    git(source, ['add', '-A']);
    const identity = ['user.name=fixture', 'user.email=f@example.invalid', 'commit.gpgsign=false'];
    git(source, [...identity.flatMap((c) => ['-c', c]), 'commit', '-q', '-m', 'baseline']);

    // Fails once, then passes: the only honest way to produce a `flaky` result.
    const marker = JSON.stringify(join(root, 'retry-marker'));
    const declared = { required: true, timeout_s: 30, flake_policy: 'mark' } as const;
    const sandboxes = join(root, 'sandboxes');
    const adapter = createCodeAdapter({
      project_id: PROJECT,
      source_of_record: source,
      sandbox_root: sandboxes,
      artifacts_root: join(root, 'artifacts'),
      checks: [
        {
          ...declared,
          check_id: 'always-passes',
          max_attempts: 1,
          invocation: [process.execPath, '-e', 'process.exit(0)'],
        },
        {
          ...declared,
          check_id: 'passes-on-retry',
          max_attempts: 2,
          invocation: [
            process.execPath,
            '-e',
            `const fs=require('fs');const p=${marker};` +
              'if(fs.existsSync(p))process.exit(0);fs.writeFileSync(p,"1");process.exit(1);',
          ],
        },
      ],
      now: () => CAPTURED_AT,
    });

    const inSandbox = (sandbox: Sandbox): string => join(sandboxes, PROJECT, sandbox.sandbox_id);
    return {
      adapter,
      project: PROJECT,
      consulted: [CONSULTED],
      checks: { passing: 'always-passes', flaky: 'passes-on-retry', undeclared: 'never-declared' },
      changeConsulted: () => writeFileSync(join(source, CONSULTED), 'one\nTWO\nthree\n'),
      changeUnconsulted: () => writeFileSync(join(source, UNCONSULTED), 'also unrelated\n'),
      leaveUnsavedWork: (sandbox: Sandbox) =>
        writeFileSync(join(inSandbox(sandbox), CONSULTED), 'one\ntwo\nthree\nfour\n'),
      forgedSandbox: () => {
        // Beside both roots, so an id of `..` reaches it from either once a path is derived.
        const untouchable = join(root, 'untouchable');
        mkdirSync(untouchable, { recursive: true });
        writeFileSync(join(untouchable, 'the-only-copy.txt'), 'not this adapter to delete\n');
        const basis: Basis = { ref: '0'.repeat(40), inputs: [], captured_at: CAPTURED_AT };
        return {
          sandbox: { sandbox_id: '../untouchable', project_id: PROJECT, basis },
          untouchable: [untouchable],
        };
      },
      unresolvableBasis: (): Basis => ({
        ref: '0'.repeat(40),
        inputs: [],
        captured_at: CAPTURED_AT,
      }),
      observablePaths: (sandbox: Sandbox) => [inSandbox(sandbox), join(source, '.git')],
      tearDown: () => rmSync(root, { recursive: true, force: true }),
    };
  },
};
