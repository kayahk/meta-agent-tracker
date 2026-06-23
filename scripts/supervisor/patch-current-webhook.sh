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
# Background launchd jobs can be denied access to ~/Downloads by macOS privacy controls.
# Use the repo-local gitignored copy for GitHub App JWT signing.
if [[ -f data/github-app-private-key.pem ]]; then
  export META_AGENT_GITHUB_PRIVATE_KEY_PATH="$repo_root/data/github-app-private-key.pem"
fi
url_file="logs/supervisor/current-public-webhook-url.txt"
if [[ ! -s "$url_file" ]]; then
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') no current public webhook URL yet"
  exit 0
fi
url="$(tail -1 "$url_file")"
if [[ ! "$url" =~ ^https://[-a-zA-Z0-9]+\.trycloudflare\.com/webhooks/github$ ]]; then
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') refusing invalid webhook URL: $url" >&2
  exit 1
fi
scripts/supervisor/patch-github-webhook-url.sh "$url"
