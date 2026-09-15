/**
 * Everything this package exports across the seam, in one file.
 *
 * Invariant 9 allows substrate vocabulary *inside* this adapter, and the implementation modules use
 * it freely because it is accurate there. This file is the exception: with `index.ts` it is all the
 * core, the spine and an owner's configuration ever read, so it stays domain-neutral and
 * `test/seam.test.ts` scans it word by word — one file to police instead of a habit to remember.
 */
import type { ProjectId } from '@internal/domain';

/** How a check is declared for a project (§16.1). The core never sees `invocation`. */
export type CheckDeclaration = {
  readonly check_id: string;
  readonly required: boolean;
  readonly timeout_s: number;
  readonly flake_policy: 'mark' | 'fail';
  /** Upper bound on attempts, first one included. Bounded retries, per contract item 6. */
  readonly max_attempts: number;
  /**
   * What to run, as argv. Never a string, never a shell: the spine cannot hand this adapter a
   * command, and the adapter cannot be talked into interpolating one.
   */
  readonly invocation: readonly string[];
};

/**
 * One adapter instance binds one Project to one source of record — Phase 0 is "one owner, one host,
 * one domain". A method asked about another Project refuses rather than guessing.
 */
export type CodeAdapterOptions = {
  readonly project_id: ProjectId;
  /** Absolute paths: the source of record, where sandboxes go, where artifacts are retained. */
  readonly source_of_record: string;
  readonly sandbox_root: string;
  readonly artifacts_root: string;
  /** §14.1: the Project declares its change unit. The adapter counts in it, it does not pick it. */
  readonly change_unit?: 'lines' | 'files' | undefined;
  readonly checks?: readonly CheckDeclaration[] | undefined;
  readonly now?: (() => string) | undefined;
  readonly new_id?: (() => string) | undefined;
};

/**
 * Open rather than exhaustive-by-intent: this is the set the methods implemented here can produce,
 * and the codes an apply gate refuses with go with that gate to issue #108. A consumer switching on
 * this union will be told by the compiler when they come back.
 */
export type RefusalCode =
  'basis_unknown' | 'unknown_project' | 'unsafe_identifier' | 'sandbox_not_materialised';

/**
 * A refusal, not a crash. Invariants 4 and 5: the adapter would rather stop than improvise, and the
 * reason has to survive being shown to the owner — so it is written in core vocabulary and never
 * carries the substrate's own error text, which is the usual way a leak escapes.
 */
export class AdapterRefusal extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode, reason: string) {
    super(reason);
    this.name = 'AdapterRefusal';
    this.code = code;
  }
}
