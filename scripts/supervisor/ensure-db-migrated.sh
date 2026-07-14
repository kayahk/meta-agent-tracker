#!/usr/bin/env bash
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
cd "$repo_root"
export PATH="$HOME/.hermes/hermes-agent/venv/bin:$HOME/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

mkdir -p logs/supervisor
lock_dir="logs/supervisor/db-migrate.lock"
lock_wait_seconds=60
start="$(date +%s)"
while ! mkdir "$lock_dir" 2>/dev/null; do
  now="$(date +%s)"
  if (( now - start >= lock_wait_seconds )); then
    echo "$(date -Is) timed out waiting for db migration lock" >&2
    exit 1
  fi
  sleep 1
done
migration_pid=""
cleanup() {
  rmdir "$lock_dir" 2>/dev/null || true
}
terminate_process_tree() {
  local pid="$1"
  local child=""
  while IFS= read -r child; do
    [[ -n "$child" ]] && terminate_process_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill "$pid" 2>/dev/null || true
}
stop_migration() {
  trap - INT TERM
  if [[ -n "$migration_pid" ]] && kill -0 "$migration_pid" 2>/dev/null; then
    echo "$(date -Is) stopping db migration before releasing lock" >&2
    terminate_process_tree "$migration_pid"
    wait "$migration_pid" 2>/dev/null || true
  fi
  exit 143
}
trap cleanup EXIT
trap stop_migration INT TERM

set -a
# shellcheck disable=SC1091
. ./.env
set +a
export META_AGENT_ROOT="$repo_root"
export NODE_PATH="$repo_root/node_modules"

pnpm db:migrate &
migration_pid=$!
wait "$migration_pid"
migration_status=$?
migration_pid=""
exit "$migration_status"
