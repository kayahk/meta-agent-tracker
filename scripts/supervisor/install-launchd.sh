#!/usr/bin/env bash
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
cd "$repo_root"
export PATH="$HOME/.hermes/hermes-agent/venv/bin:$HOME/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
mkdir -p logs/supervisor "$HOME/Library/LaunchAgents"
chmod +x scripts/supervisor/*.sh
if compgen -G "scripts/supervisor/*.py" >/dev/null; then
  chmod +x scripts/supervisor/*.py
fi

if [[ "${1:-}" != "--skip-build" ]]; then
  pnpm build
fi

for plist in scripts/launchd/*.plist; do
  label="$(/usr/libexec/PlistBuddy -c 'Print :Label' "$plist")"
  dest="$HOME/Library/LaunchAgents/$(basename "$plist")"
  case "$label" in
    com.example.meta-agent.api) program="$repo_root/scripts/supervisor/api.sh" ;;
    com.example.meta-agent.worker) program="$repo_root/scripts/supervisor/worker.sh" ;;
    com.example.meta-agent.proxy) program="$repo_root/scripts/supervisor/proxy.sh" ;;
    com.example.meta-agent.tunnel) program="$repo_root/scripts/supervisor/cloudflare-tunnel.sh" ;;
    com.example.meta-agent.patch-webhook) program="$repo_root/scripts/supervisor/patch-current-webhook.sh" ;;
    *) echo "unknown LaunchAgent label in $plist: $label" >&2; exit 1 ;;
  esac
  log_name="${label#com.example.meta-agent.}"
  launchctl bootout "gui/$(id -u)" "$dest" >/dev/null 2>&1 || true
  cp "$plist" "$dest"
  plist_set_string() {
    /usr/libexec/PlistBuddy -c "Set $1 \"$2\"" "$dest"
  }
  plist_set_string :ProgramArguments:0 "$program"
  plist_set_string :WorkingDirectory "$repo_root"
  plist_set_string :StandardOutPath "$repo_root/logs/supervisor/${log_name}.out.log"
  plist_set_string :StandardErrorPath "$repo_root/logs/supervisor/${log_name}.err.log"
  launchctl bootstrap "gui/$(id -u)" "$dest"
  launchctl enable "gui/$(id -u)/$label"
  launchctl kickstart -k "gui/$(id -u)/$label"
  echo "loaded $label"
done

echo "status:"
launchctl print "gui/$(id -u)" | grep -E 'de\.example\.meta-agent\.(api|worker|proxy|tunnel|patch-webhook)' || true
