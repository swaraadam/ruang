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
/** Committed, and not text: the class of change a patch renders as "differ" rather than as content. */
const OPAQUE = 'diagram.opaque';
const OPAQUE_BASELINE = Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0x00, 0xfe]);
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
    writeFileSync(join(source, OPAQUE), OPAQUE_BASELINE);
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
      leaveUnrecordableWork: (sandbox: Sandbox) => {
        const at = inSandbox(sandbox);
        // Never added to the index: a patch lists the NAME and none of the content.
        const invented = Buffer.from('the only copy of this reasoning\n');
        writeFileSync(join(at, 'notes.md'), invented);
        // Nested, so a rescue that flattens paths would collide rather than round-trip.
        mkdirSync(join(at, 'scratch'), { recursive: true });
        const nested = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x11]);
        writeFileSync(join(at, 'scratch', 'artefact.opaque'), nested);
        // Committed and non-text: the diff reports that it differs, never how.
        const revised = Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0x00, 0xfe, 0xab, 0xcd]);
        writeFileSync(join(at, OPAQUE), revised);
        return [
          { label: 'a resource the source of record has never seen', bytes: invented },
          { label: 'non-text bytes in a nested location', bytes: nested },
          { label: 'a revised non-text resource the record knows', bytes: revised },
        ];
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
