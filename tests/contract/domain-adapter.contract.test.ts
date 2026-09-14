/**
 * The domain adapter contract (blueprint §20.1), written once against the SPI and run against
 * every registered adapter. Each test name quotes the section or invariant it enforces.
 *
 * Scope note: P0-10 lands the code adapter and the assertions its acceptance names. P0-13 owns the
 * rest of the §20.1 list and the deliberately non-compliant stub that must fail this suite; it
 * extends `HARNESSES` and this file rather than forking either.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Sandbox } from '@internal/domain';
import { type ChangeSet, isAnchor, isChangeSet, isRenderableChange } from '@internal/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeHarness } from './code-harness.js';

/** Every regular file at or under a path, so an assertion need not know the adapter's layout. */
const filesUnder = (path: string): readonly string[] => {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return [];
  if (!stats.isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
};
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
  const retain = { force: false, retain_artifacts: true } as const;

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

  describe('sandbox (§5.2.3, §10.4)', () => {
    it('§5.2.3: inspect_sandbox is non-mutating — observable bytes are identical after it runs', async () => {
      const sandbox = await withUnsavedWork();
      const before = fingerprint(s.observablePaths(sandbox));
      await s.adapter.inspect_sandbox(sandbox);
      await s.adapter.inspect_sandbox(sandbox);
      expect(fingerprint(s.observablePaths(sandbox))).toBe(before);
    });

    it('§5.2.3: inspect_sandbox is callable at any point, including after close', async () => {
      const sandbox = await opened();
      expect(await s.adapter.inspect_sandbox(sandbox)).toMatchObject({
        dirty: false,
        safe_to_close: true,
      });
      await s.adapter.close_sandbox(sandbox, retain);
      const after = await s.adapter.inspect_sandbox(sandbox);
      expect(typeof after.unsaved_summary).toBe('string');
      expect(after.unsaved_summary.length).toBeGreaterThan(0);
    });

    it('§10.4: close never destroys unsaved work without a record and a policy outcome', async () => {
      const sandbox = await withUnsavedWork();
      const inspection = await s.adapter.inspect_sandbox(sandbox);
      expect(inspection).toMatchObject({ dirty: true, safe_to_close: false });

      const refused = await s.adapter.close_sandbox(sandbox, retain);
      expect(refused.closed).toBe(false);
      expect(refused.refused_reason).not.toBeNull();
      expect((await s.adapter.inspect_sandbox(sandbox)).dirty).toBe(true);

      const forced = await s.adapter.close_sandbox(sandbox, { ...retain, force: true });
      expect(forced.closed).toBe(true);
      // The work is gone from the sandbox, so it has to be somewhere: a forced close that retained
      // nothing would be exactly the silent destruction §10.4 exists to prevent.
      expect(forced.retained_artifacts.length).toBeGreaterThan(0);
    });

    it('§10.4: retained means the bytes survived, not that a filename was written down', async () => {
      const sandbox = await opened();
      const must_survive = s.leaveUnrecordableWork(sandbox);
      if (must_survive.length === 0) return; // an adapter whose records carry every byte

      const forced = await s.adapter.close_sandbox(sandbox, { ...retain, force: true });
      expect(forced.closed).toBe(true);

      // Deliberately indifferent to layout: the contract is that the content is recoverable, not
      // that it lands anywhere in particular. Counting artifacts is what the test above does, and
      // counting is exactly what let a record of NAMES pass as a record of work -- a forced close
      // reporting `closed: true` with `retained_artifacts` set, for content that was only ever
      // listed. Invariant 1: this is the record someone reads before accepting the loss.
      const kept = forced.retained_artifacts.flatMap(filesUnder).map((f) => readFileSync(f));
      for (const resource of must_survive) {
        const found = kept.some(
          (bytes) => Buffer.compare(bytes, Buffer.from(resource.bytes)) === 0,
        );
        expect(found, `${resource.label} was not recoverable from retained_artifacts`).toBe(true);
      }
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

  describe('apply (§5.2.2, §5.5)', () => {
    const wide = { change_budget: 10_000, max_risk: 'high' } as const;

    it('§5.2.2: every operation is declarative — a target, a capability, a risk, a reversibility', async () => {
      const plan = await s.adapter.apply_plan(await unsavedChangeSet(), wide);
      expect(plan.operations.length).toBeGreaterThan(0);
      for (const op of plan.operations) {
        const named = { target_ref: expect.any(String), required_capability: expect.any(String) };
        expect(op).toMatchObject(named);
        expect(['low', 'medium', 'high']).toContain(op.risk);
        expect(['revertible', 'compensable', 'irreversible']).toContain(op.reversibility);
      }
      // §5.2.2: no handle, no credential, nothing runnable travels back with the plan.
      const emitted = JSON.stringify(plan).toLowerCase();
      for (const leak of ['token', 'credential', 'secret', 'password', 'argv', 'command'])
        expect(emitted).not.toContain(leak);
    });

    it('§16.6: a change set over the declared budget is refused, not trimmed to fit', async () => {
      const set = await unsavedChangeSet();
      await expect(s.adapter.apply_plan(set, { ...wide, change_budget: 0 })).rejects.toThrow();
    });

    it('§5.5: confirm_applied reconciles, and reversal is a plan or an explicit refusal', async () => {
      const plan = await s.adapter.apply_plan(await unsavedChangeSet(), wide);
      const done = { succeeded: true, detail: 'applied by the broker' };
      const outcomes = plan.operations.map((op) => ({ operation_id: op.operation_id, ...done }));
      const result = await s.adapter.confirm_applied(plan.plan_id, outcomes);
      expect(result).toMatchObject({ plan_id: plan.plan_id, applied: true });
      const reversal = await s.adapter.revert_or_compensate(result);
      expect(['reversal', 'not_reversible']).toContain(reversal.kind);
      if (reversal.kind === 'reversal') expect(reversal.operations.length).toBe(outcomes.length);

      // Invariant 5: an operation this adapter did not plan cannot be reversed by guessing.
      const elsewhere = [{ operation_id: 'planned-somewhere-else', ...done }];
      const foreign = await s.adapter.confirm_applied(plan.plan_id, elsewhere);
      expect((await s.adapter.revert_or_compensate(foreign)).kind).toBe('not_reversible');
    });
  });

  describe('reconcile (§14.4, invariant 3)', () => {
    it('invariant 3: a state the adapter cannot confirm is needs_repair with probes, and recovers', async () => {
      const broken = await s.adapter.reconcile({ 'a-fact-nobody-can-observe': 'true' });
      expect(broken.kind).toBe('needs_repair');
      if (broken.kind === 'needs_repair') expect(broken.probes.length).toBeGreaterThan(0);

      // Recoverable through its allowed exit: once the disputed fact is gone, it converges.
      const converged = await s.adapter.reconcile({});
      expect(converged.kind).toBe('converged');
      if (converged.kind === 'converged')
        expect(Object.keys(converged.state).length).toBeGreaterThan(0);
    });
  });
});
