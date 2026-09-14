#!/usr/bin/env bash
# `pnpm dev` — bring up the local control plane for development.
#
# The gateway (P0-09) is not in the tree yet, so this starts nothing and fakes nothing. A stub
# server would answer requests the control plane never authorized, and the first thing it would
# teach the web shell is that the office can render something durable truth never said
# (invariant 1). When P0-09 adds a `start` script to apps/gateway, this runs it — no edit here.
set -uo pipefail
cd "$(dirname "$0")/.."
GATEWAY=apps/gateway

if ! python3 -c "import json,sys; sys.exit(0 if 'start' in json.load(open('$GATEWAY/package.json')).get('scripts',{}) else 1)" 2>/dev/null; then
  echo "pnpm dev cannot start the gateway yet:" >&2
  echo "  - $GATEWAY/package.json declares no \"start\" script — the gateway is P0-09" >&2
  echo "" >&2
  echo "Nothing was started and nothing was stubbed." >&2
  echo "Meanwhile \`pnpm seed\` writes durable state under state/dev/ for the office to read." >&2
  exit 1
fi

exec pnpm --filter @internal/gateway start
