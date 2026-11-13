#!/usr/bin/env bash
# Runs the autonomy scenarios against another branch's engine, with that branch counted as merged.
#
#   packages/engine/test/autonomy/run-against.sh <git ref> [branch names in known.ts, comma-separated]
#   packages/engine/test/autonomy/run-against.sh origin/feat/wake-by-default wake-by-default
#
# It checks the ref out in a temporary worktree, copies this suite into it, installs, runs one file at a time
# (under the machine's heavy-work lock when `lockf` exists) and removes the worktree. A scenario listed for a
# branch that is now counted as merged must pass; any other known one must still fail.
set -euo pipefail
ref=${1:?usage: run-against.sh <git ref> [branches]}
branches=${2:-}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/autonomy-XXXXXX")
cleanup() { git -C "$repo" worktree remove --force "$tmp" >/dev/null 2>&1 || rm -rf "$tmp"; }
trap cleanup EXIT
git -C "$repo" worktree add --detach "$tmp" "$ref" >/dev/null
rm -rf "$tmp/packages/engine/test/autonomy"
cp -R "$here" "$tmp/packages/engine/test/autonomy"
lock() { if command -v lockf >/dev/null; then lockf -k /tmp/agentes-heavy.lock "$@"; else "$@"; fi; }
(cd "$tmp" && lock bun install --frozen-lockfile >/dev/null)
status=0
# AUTONOMY_FILES=handoffs,routines runs only those files.
for f in "$tmp"/packages/engine/test/autonomy/*.test.ts; do
  name=$(basename "$f" .test.ts)
  [[ -n "${AUTONOMY_FILES:-}" && ",$AUTONOMY_FILES," != *",$name,"* ]] && continue
  echo "== $(basename "$f")"
  (cd "$tmp" && AUTONOMY_BRANCHES="$branches" lock bun test "$f") || status=1
done
exit $status
