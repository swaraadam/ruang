# adapters/domain/code

Owned by Seam A for source code: the one place where git, worktree, commit and diff vocabulary is
accurate. Implements the full `DomainAdapter` contract (`packages/domain`, blueprint §5.2) over a
git source of record by shelling out to `git`; nothing here is a dependency.

## The mapping (blueprint §5.3)

| Core concept                         | Code implementation                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| Source of record                     | git repository at `options.source_of_record`                                  |
| `basis.ref`                          | commit SHA of `HEAD`, or the literal `unknown` when none resolves             |
| `basis.inputs[resource_id, version]` | consulted file path + its blob hash (`absent` when it is not there)           |
| `Sandbox`                            | a detached worktree at `<sandbox_root>/<project_id>/<sandbox_id>`             |
| `ChangeSet` / `ChangeAnchor`         | file changes + text patches; `text_range` from patch range headers            |
| `change_unit` / `change_size`        | lines or files, whichever the Project declares                                |
| `Apply`                              | declarative integrate (+ optional publish) operations for the spine's broker  |
| Reversal                             | a forward reversing operation; a publish is `compensable`, not revertible     |
| `Checks`                             | declared argv per project, run in the sandbox, output retained as an artifact |

## Rules this package keeps

- **The seam is two files.** `src/index.ts` and `src/surface.ts` are all the core, the spine or an
  owner's configuration read, and are written in core vocabulary; implementation modules say `git`
  because it is true there. `test/seam.test.ts` scans the surface and every runtime value.
- **Only consulted resources are fingerprinted** (§13.2). A basis never hashes a directory, and a
  moved ref with no consulted input touched is not stale.
- **`unknown` fails closed.** An unresolvable basis refuses to open a sandbox or plan an apply.
- **`inspect_sandbox` is a query.** Every command it runs is read-only and takes no optional lock.
- **No push, no merge, no history rewrite.** `src/process.ts` holds an allow-list of subcommands
  and, where one has verbs of its own, of verb pairs; apply is planned here and executed by the
  spine, never from inside this package.
- **An identifier this adapter did not issue locates nothing.** Every path derived from a
  caller-supplied id is proven to still be inside the root it was derived from (`src/paths.ts`),
  because `join` collapses `..` in silence and teardown is destructive at the end of a derivation.
