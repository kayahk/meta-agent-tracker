#!/usr/bin/env bash
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
cd "$repo_root"
export PATH="$HOME/.hermes/hermes-agent/venv/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -a
# shellcheck disable=SC1091
. ./.env
set +a
mkdir -p logs/supervisor
log="logs/supervisor/cloudflare-tunnel-wrapper.log"
ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "$(ts) cloudflared not found on PATH" | tee -a "$log" >&2
  exit 127
fi

last_url_file="logs/supervisor/current-public-webhook-url.txt"
child=""
reader=""
tmpdir="$(mktemp -d /tmp/meta-agent-cloudflared.XXXXXX)"
cloudflared_log="$tmpdir/cloudflared.log"
touch "$cloudflared_log"
# shellcheck disable=SC2329
cleanup() {
  if [[ -n "${child}" ]] && kill -0 "${child}" 2>/dev/null; then
    kill "${child}" 2>/dev/null || true
  fi
  if [[ -n "${reader}" ]] && kill -0 "${reader}" 2>/dev/null; then
    kill "${reader}" 2>/dev/null || true
  fi
  wait "${child}" 2>/dev/null || true
  wait "${reader}" 2>/dev/null || true
  rm -rf "$tmpdir"
}
trap cleanup EXIT INT TERM

tail -n0 -F "$cloudflared_log" 2>/dev/null | while IFS= read -r line; do
  printf '%s %s\n' "$(ts)" "$line" | tee -a "$log"
  if [[ "$line" =~ https://[-a-zA-Z0-9]+\.trycloudflare\.com ]]; then
    tunnel_url="${BASH_REMATCH[0]}"
    webhook_url="${tunnel_url}/webhooks/github"
    previous="$(cat "$last_url_file" 2>/dev/null || true)"
    if [[ "$previous" != "$webhook_url" ]]; then
      printf '%s\n' "$webhook_url" > "$last_url_file"
      echo "$(ts) recorded public webhook URL ${webhook_url}; kicking patch-webhook agent" | tee -a "$log"
      launchctl kickstart -k "gui/$(id -u)/com.example.meta-agent.patch-webhook" >/dev/null 2>&1 || true
    fi
  fi
done &
reader=$!

cloudflared tunnel --url http://127.0.0.1:4318 >>"$cloudflared_log" 2>&1 &
child=$!
set +e
wait "$child"
status=$?
set -e
exit "$status"
