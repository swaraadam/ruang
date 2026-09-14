#!/usr/bin/env bash
# `pnpm dev` — bring up the local control plane for development.
#
# This script exists to answer one question the gateway is not allowed to answer for itself: WHICH
# DATABASE. `apps/gateway` does not know the repository root and must not spell product filenames
# (CLAUDE.md §1 — naming clearance is an open Phase -1 gate), so it refuses to start without an
# absolute `SEED_DB_PATH`. This script knows the root (it cd's there) and reads the filename from
# the one source: `DEV_DB_PATH`, exported by the same `scripts/seed.ts` that `pnpm seed` runs, which
# gets it from `config/naming.ts`. One definition, two readers, no second spelling.
#
# It also refuses rather than guesses: no build, no database, no server.
set -uo pipefail
CALLER_PWD="$PWD"
cd "$(dirname "$0")/.."
ROOT="$PWD"
GATEWAY=apps/gateway
PRINT_ONLY=0
[[ "${1:-}" == "--print-db-path" ]] && PRINT_ONLY=1

if ! python3 -c "import json,sys; sys.exit(0 if 'start' in json.load(open('$GATEWAY/package.json')).get('scripts',{}) else 1)" 2>/dev/null; then
  echo "pnpm dev cannot start the gateway:" >&2
  echo "  - $GATEWAY/package.json declares no \"start\" script" >&2
  echo "" >&2
  echo "Nothing was started and nothing was stubbed." >&2
  exit 1
fi

# `pnpm seed` compiles this artefact too, but `pnpm dev` must work after a bare `pnpm install` --
# that is the documented three-command flow. `tsc -b` is incremental, so this is a no-op once warm.
if ! pnpm exec tsc -b; then
  echo "" >&2
  echo "pnpm dev did not start the gateway: the build failed (above)." >&2
  echo "A gateway compiled from source that does not typecheck would serve whatever the last" >&2
  echo "successful build happened to contain." >&2
  exit 1
fi

# The caller may name the database (a test, a second instance). Otherwise ask the seed where it
# writes. Either way the gateway receives an ABSOLUTE path: it runs with cwd $GATEWAY, so a
# relative one would resolve under the package directory, which is how this broke before.
if [[ -n "${SEED_DB_PATH:-}" ]]; then
  DB_PATH="$SEED_DB_PATH"
  BASE="$CALLER_PWD"
else
  DB_PATH="$(env -u SEED_DB_PATH node -e \
    "import('./dist/scripts/seed.js').then(m=>process.stdout.write(m.DEV_DB_PATH))")"
  BASE="$ROOT"
  if [[ -z "$DB_PATH" ]]; then
    echo "pnpm dev could not read DEV_DB_PATH from dist/scripts/seed.js." >&2
    echo "That export is the only place the database path is defined; refusing to invent one." >&2
    exit 1
  fi
fi
case "$DB_PATH" in /*) ;; *) DB_PATH="$BASE/$DB_PATH" ;; esac

if [[ $PRINT_ONLY -eq 1 ]]; then
  echo "$DB_PATH"
  exit 0
fi

# Say it plainly. Without this the first sign of an unseeded machine is a better-sqlite3 TypeError
# from inside a dependency, and the gateway's own refusal (correct, but less specific) after that.
if [[ ! -f "$DB_PATH" ]]; then
  echo "pnpm dev did not start the gateway: there is no database yet." >&2
  echo "  expected: $DB_PATH" >&2
  echo "" >&2
  echo "Run \`pnpm seed\` first. It writes durable rows and events under state/dev/ for the office" >&2
  echo "to read. Starting against a missing file would create an empty database, and an empty" >&2
  echo "office is a claim durable truth never made." >&2
  exit 1
fi

export SEED_DB_PATH="$DB_PATH"
exec pnpm --filter @internal/gateway start
