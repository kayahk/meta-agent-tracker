#!/usr/bin/env bash
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
cd "$repo_root"
for plist in scripts/launchd/*.plist; do
  label="$(/usr/libexec/PlistBuddy -c 'Print :Label' "$plist")"
  dest="$HOME/Library/LaunchAgents/$(basename "$plist")"
  if launchctl bootout "gui/$(id -u)" "$dest" >/dev/null 2>&1; then
    bootout_status="unloaded"
  else
    bootout_status="not loaded"
  fi
  rm -f "$dest"
  echo "${bootout_status} $label; removed $dest"
done
