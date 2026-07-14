#!/usr/bin/env bash
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
cd "$repo_root"
export PATH="$HOME/.hermes/hermes-agent/venv/bin:$HOME/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -a
# shellcheck disable=SC1091
. ./.env
set +a
export META_AGENT_ROOT="$repo_root"
export NODE_PATH="$repo_root/node_modules"
if [[ ! -f apps/api/dist/index.js ]]; then
  echo "$(date -Is) api dist missing; building first" >&2
  pnpm build
fi
scripts/supervisor/ensure-db-migrated.sh
exec node apps/api/dist/index.js
