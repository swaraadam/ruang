/**
 * The domain adapter contract (blueprint §20.1), written once against the SPI and run against
 * every registered adapter. Each test name quotes the section or invariant it enforces.
 *
 * Scope note, twice over. P0-10 lands the code adapter and the assertions its acceptance names;
 * P0-13 owns the rest of the §20.1 list and the deliberately non-compliant stub that must fail this
 * suite, and extends `HARNESSES` and this file rather than forking either. Separately, the owner cut
 * P0-10 to its read-only surface on 2026-09-15: teardown and apply are issue #108, and their
 * assertions come back here with them. `harness.ts` names that subset as `ContractSurface`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Sandbox } from '@internal/domain';
import { type ChangeSet, isAnchor, isChangeSet, isRenderableChange } from '@internal/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeHarness } from './code-harness.js';
import type { ContractSubject } from './harness.js';

const HARNESSES = [codeHarness];

/** Content hash of a tree, used to prove a query changed nothing. Order is fixed by sorting. */
const fingerprint = (paths: readonly string[]): string => {
  const h = createHash('sha256');
  const walk = (p: string): void => {
    const s = statSync(p, { throwIfNoEntry: false });
    if (s === undefined) {
      h.update(`absent:${p}\n`);
      return;
    }
    if (s.isDirectory()) {
      for (const name of readdirSync(p).sort()) walk(join(p, name));
      return;
    }
    h.update(`${p}:`).update(readFileSync(p)).update('\n');
  };
  for (const p of [...paths].sort()) walk(p);
  return h.digest('hex');
};

describe.each(HARNESSES)('domain adapter contract: $name', (harness) => {
  let s: ContractSubject;
  beforeEach(async () => {
    s = await harness.setUp();
  });
  afterEach(() => s.tearDown());

  const opened = async (): Promise<Sandbox> =>
    s.adapter.open_sandbox(s.project, await s.adapter.snapshot_basis(s.project, s.consulted));
  const withUnsavedWork = async (): Promise<Sandbox> => {
    const sandbox = await opened();
    s.leaveUnsavedWork(sandbox);
    return sandbox;
  };
  const unsavedChangeSet = async (): Promise<ChangeSet> =>
    s.adapter.compute_change_set(await withUnsavedWork());

  describe('basis (§5.1, §13.2, invariant 4)', () => {
    it('§13.2: editing a resource the brief never consulted does not stale the task', async () => {
      const basis = await s.adapter.snapshot_basis(s.project, s.consulted);
      s.changeUnconsulted();
      expect(await s.adapter.is_basis_stale(basis)).toEqual({ state: 'fresh' });
    });

    it('§13.2: editing a consulted resource stales the task, and names which one', async () => {
      const basis = await s.adapter.snapshot_basis(s.project, s.consulted);
      s.changeConsulted();
      const staleness = await s.adapter.is_basis_stale(basis);
      expect(staleness.state).toBe('stale');
      if (staleness.state !== 'stale') return;
      expect(staleness.stale_inputs).toEqual([...s.consulted]);
      expect(staleness.reason.length).toBeGreaterThan(0);
    });

    it('§5.1: fingerprints only the resources it was told were consulted', async () => {
      const basis = await s.adapter.snapshot_basis(s.project, s.consulted);
      expect(basis.inputs.map((i) => i.resource_id)).toEqual([...s.consulted]);
    });

    it('invariant 1: a basis that cannot be resolved reports unknown, not a plausible default', async () => {
      const staleness = await s.adapter.is_basis_stale(s.unresolvableBasis());
      expect(staleness.state).toBe('unknown');
    });

    it('invariant 4: unknown staleness refuses mutation — no sandbox is opened', async () => {
      await expect(s.adapter.open_sandbox(s.project, s.unresolvableBasis())).rejects.toThrow();
    });
  });

  describe('sandbox (§5.2.3)', () => {
    it('§5.2.3: inspect_sandbox is non-mutating — observable bytes are identical after it runs', async () => {
      const sandbox = await withUnsavedWork();
      const before = fingerprint(s.observablePaths(sandbox));
      await s.adapter.inspect_sandbox(sandbox);
      await s.adapter.inspect_sandbox(sandbox);
      expect(fingerprint(s.observablePaths(sandbox))).toBe(before);
    });

    it('§5.2.3: inspect_sandbox is callable at any point in a sandbox’s life', async () => {
      const sandbox = await opened();
      expect(await s.adapter.inspect_sandbox(sandbox)).toMatchObject({
        dirty: false,
        safe_to_close: true,
      });
      s.leaveUnsavedWork(sandbox);
      // The same call, a different answer, and no step in between: cleanup policy reads this before
      // a teardown is even considered, so it must never need one to have happened first.
      expect(await s.adapter.inspect_sandbox(sandbox)).toMatchObject({
        dirty: true,
        safe_to_close: false,
      });
    });

    it('§5.2.3: an inspection reports every field a cleanup policy decides on', async () => {
      const inspection = await s.adapter.inspect_sandbox(await withUnsavedWork());
      // `unsaved_summary` and `retained_artifacts` are the two a refusal has to be able to quote.
      // A summary that is empty when `dirty` is the report reading the same as a clean sandbox.
      expect(inspection.unsaved_summary.length).toBeGreaterThan(0);
      expect(Array.isArray(inspection.retained_artifacts)).toBe(true);
      expect(inspection.safe_to_close).toBe(!inspection.dirty);
    });

    it('invariant 3: a sandbox identifier this adapter never issued locates nothing', async () => {
      const forged = s.forgedSandbox();
      const before = fingerprint(forged.untouchable);
      // Every adapter derives *some* location from a sandbox id. Proving the derivation is refused
      // on a query costs nothing and is the same guard teardown (#108) will be destructive behind.
      await expect(s.adapter.inspect_sandbox(forged.sandbox)).rejects.toThrow();
      await expect(s.adapter.compute_change_set(forged.sandbox)).rejects.toThrow();
      expect(fingerprint(forged.untouchable)).toBe(before);
    });

    it('§5.2: a sandbox attributed to another Project is refused, not answered about', async () => {
      const sandbox = await opened();
      const elsewhere = { ...sandbox, project_id: `${s.project}-elsewhere` };
      await expect(s.adapter.inspect_sandbox(elsewhere)).rejects.toThrow();
      await expect(s.adapter.compute_change_set(elsewhere)).rejects.toThrow();
      await expect(s.adapter.run_checks(elsewhere, [])).rejects.toThrow();
    });
  });

  describe('change set (§5.2.1)', () => {
    it('§5.2.1: the content hash is stable across repeated computation on an unchanged sandbox', async () => {
      const sandbox = await withUnsavedWork();
      const first = await s.adapter.compute_change_set(sandbox);
      const second = await s.adapter.compute_change_set(sandbox);
      expect(second.content_hash).toBe(first.content_hash);
      expect(isChangeSet(first)).toBe(true);
      expect(first.change_size).toBeGreaterThan(0);
    });

    it('§5.2.1: every rendered change is a case of the closed union, on every surface', async () => {
      const set = await unsavedChangeSet();
      for (const surface of ['review', 'mobile', 'office'] as const) {
        const rendered = await s.adapter.render_change_set(set, surface);
        // Never fewer changes than there are: a small surface shows less detail, not less change.
        expect(rendered).toHaveLength(set.changes.length);
        for (const change of rendered) {
          expect(isRenderableChange(change)).toBe(true);
          if (change.kind === 'asset_delta') continue;
          for (const anchor of change.anchors) expect(isAnchor(anchor)).toBe(true);
        }
      }
    });
  });

  describe('checks (§16.1, contract item 6)', () => {
    it('§16.1: a skip carries an explicit reason and never looks like a pass', async () => {
      const spec = { required: true, timeout_s: 5, flake_policy: 'fail', max_attempts: 1 } as const;
      const asked = [{ ...spec, check_id: s.checks.undeclared }];
      const [result] = await s.adapter.run_checks(await opened(), asked);
      expect(result?.result).toBe('skipped');
      expect(result?.skipped_reason).toBeTruthy();
    });

    it('item 6: a flaky pass stays distinguishable from a clean pass, with attempts recorded', async () => {
      const wanted: readonly string[] = [s.checks.passing, s.checks.flaky];
      const declared = await s.adapter.declared_checks(s.project);
      const specs = declared.filter((spec) => wanted.includes(spec.check_id));
      expect(specs.length).toBe(2);
      const results = await s.adapter.run_checks(await opened(), specs);
      const clean = results.find((r) => r.check_id === s.checks.passing);
      const flaky = results.find((r) => r.check_id === s.checks.flaky);
      expect(clean).toMatchObject({ result: 'passed', attempts: 1, skipped_reason: null });
      expect(flaky?.result).toBe('flaky');
      expect(flaky?.attempts).toBeGreaterThan(1);
      // Bounded, and the bound is the declared one rather than however many it took.
      const bound = specs.find((spec) => spec.check_id === s.checks.flaky)?.max_attempts ?? 0;
      expect(flaky?.attempts).toBeLessThanOrEqual(bound);
    });
  });
});
