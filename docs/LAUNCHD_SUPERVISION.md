# Meta-agent launchd supervision

The live meta-agent stack for the macOS-hosted operational environment is supervised by macOS `launchd`, not by Hermes background terminal sessions. This makes it survive Hermes gateway restarts, Hermes updates, and normal agent-session termination.

## Services

LaunchAgent plist templates are stored in `scripts/launchd/`. `scripts/supervisor/install-launchd.sh` copies them to `~/Library/LaunchAgents/` and materializes paths for the current checkout:

- `com.example.meta-agent.api` — runs the built API on `127.0.0.1:4317`.
- `com.example.meta-agent.worker` — runs the ledger reconciliation worker.
- `com.example.meta-agent.proxy` — runs the webhook-only proxy on `127.0.0.1:4318`.
- `com.example.meta-agent.tunnel` — runs a Cloudflare quick tunnel to the proxy only.
- `com.example.meta-agent.patch-webhook` — patches the GitHub App webhook URL to the current quick-tunnel URL at startup, when kicked by the tunnel wrapper, and once per minute as a safety net.

Logs are written under `logs/supervisor/`.

The API and worker wrappers run `scripts/supervisor/ensure-db-migrated.sh` before starting Node. This applies pending SQLite migrations on cold start with a simple filesystem lock, so a reboot after a code update cannot leave the worker running against an older database schema.

## Install or reload

Use this after cloning the repo on a macOS host, after changing supervisor scripts, or after pulling a new version that should become the live supervised stack:

```bash
cd /path/to/meta-agent-tracker
pnpm build
scripts/supervisor/install-launchd.sh --skip-build
```

Or let the installer build first:

```bash
cd /path/to/meta-agent-tracker
scripts/supervisor/install-launchd.sh
```

The installer copies plist templates into `~/Library/LaunchAgents/`, fills in the current checkout path, enables every service, and kickstarts them immediately. The services then start automatically at user login after a reboot.

Use `--skip-build` when only reloading plist/script changes or when `pnpm build` already completed successfully.

## Fast reboot recovery checklist

After a host reboot, log in to the macOS user account that owns the LaunchAgents and run:

```bash
cd /path/to/meta-agent-tracker
launchctl print gui/$(id -u) | grep -E 'de\.example\.meta-agent\.(api|worker|proxy|tunnel|patch-webhook)'
lsof -nP -iTCP:4317 -sTCP:LISTEN
lsof -nP -iTCP:4318 -sTCP:LISTEN
curl -sS -i http://127.0.0.1:4317/health
curl -sS http://127.0.0.1:4317/api/active-work | python3 -m json.tool >/dev/null
curl -sS http://127.0.0.1:4317/api/recent-work | python3 -m json.tool >/dev/null
cat logs/supervisor/current-public-webhook-url.txt
```

Expected normal state:

- `com.example.meta-agent.api`, `.worker`, `.proxy`, and `.tunnel` are running/enabled.
- `com.example.meta-agent.patch-webhook` may be not running between interval executions, but should be enabled and have last exit code `0`.
- API listens on `127.0.0.1:4317`; proxy listens on `127.0.0.1:4318`.
- `/health` returns `ok: true` and the repo-local SQLite path.
- `active-work` and `recent-work` return valid JSON.
- `logs/supervisor/current-public-webhook-url.txt` contains the current `https://*.trycloudflare.com/webhooks/github` URL.

Then verify the public tunnel and GitHub App URL:

```bash
public="$(sed 's#/webhooks/github$##' logs/supervisor/current-public-webhook-url.txt)"
curl -sS -i "$public/health"                  # expected 403
curl -sS -i -X POST -H 'Content-Type: application/json' --data '{}' \
  "$public/webhooks/github"                   # expected 400 for missing GitHub headers
scripts/supervisor/patch-current-webhook.sh    # idempotently patches GitHub App URL
```

If any service is missing or unhealthy, reload the whole stack from the current checkout:

```bash
cd /path/to/meta-agent-tracker
pnpm build
scripts/supervisor/install-launchd.sh --skip-build
```

## Uninstall

```bash
cd /path/to/meta-agent-tracker
scripts/supervisor/uninstall-launchd.sh
```

## Check status

```bash
launchctl print gui/$(id -u) | grep -E 'de\.example\.meta-agent\.(api|worker|proxy|tunnel|patch-webhook)'
lsof -nP -iTCP:4317 -sTCP:LISTEN
lsof -nP -iTCP:4318 -sTCP:LISTEN
cat logs/supervisor/current-public-webhook-url.txt
```

## Verify end-to-end health

```bash
curl -sS -i http://127.0.0.1:4317/health
curl -sS http://127.0.0.1:4317/api/recent-work | python3 -m json.tool >/dev/null
curl -sS http://127.0.0.1:4317/api/active-work | python3 -m json.tool >/dev/null
curl -sS -i http://127.0.0.1:4318/health      # expected 403

public="$(sed 's#/webhooks/github$##' logs/supervisor/current-public-webhook-url.txt)"
curl -sS -i "$public/health"                  # expected 403
curl -sS -i -X POST -H 'Content-Type: application/json' --data '{}' \
  "$public/webhooks/github"                   # expected 400 for missing GitHub headers
python3 ~/.hermes/scripts/meta_agent_monitor.py
```

## GitHub App webhook URL patching

Cloudflare quick-tunnel URLs are ephemeral. The tunnel wrapper records the current URL in:

```text
logs/supervisor/current-public-webhook-url.txt
```

Then it kicks `com.example.meta-agent.patch-webhook`, which uses GitHub App JWT auth to patch `/app/hook/config`. The patch agent also runs every 60 seconds so a missed kick self-heals.

The GitHub App private key is copied to the repo-local gitignored path:

```text
data/github-app-private-key.pem
```

This avoids macOS privacy/TCC denial for background LaunchAgents reading `~/Downloads`. Keep the file mode at `0600`, and do not commit anything under `data/`.

## Manual restart

```bash
launchctl kickstart -k gui/$(id -u)/com.example.meta-agent.api
launchctl kickstart -k gui/$(id -u)/com.example.meta-agent.worker
launchctl kickstart -k gui/$(id -u)/com.example.meta-agent.proxy
launchctl kickstart -k gui/$(id -u)/com.example.meta-agent.tunnel
launchctl kickstart -k gui/$(id -u)/com.example.meta-agent.patch-webhook
```

## Notes

- Do not run the live stack from Hermes `terminal(background=true)` for durable operation. Those processes are tied to the Hermes runtime and can be lost during gateway updates/restarts.
- The API/worker scripts use built output (`apps/*/dist`) and only build if the dist file is missing. Normal code updates should still run `pnpm build` before reloading services.
- The public tunnel exposes only the webhook-only proxy. `/health`, dashboard, and other API routes remain blocked through the tunnel.
