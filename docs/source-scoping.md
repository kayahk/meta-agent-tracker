# Source Scoping

How meta-agent determines which repositories and work items to track, from personal use to enterprise deployment.

## Two-layer filtering

Meta-agent uses **two independent layers** to control which repos produce events:

```
┌─────────────────────────────────────────────┐
│  Layer 1: GitHub App installation scope     │  ← GitHub-side (no code changes)
│  "Which repos does the app have access to?" │
├─────────────────────────────────────────────┤
│  Layer 2: Config allowlist                  │  ← `.env` side (restart API)
│  "Of those repos, which should we process?" │
└─────────────────────────────────────────────┘
```

**The allowlist can only narrow the installation scope — it cannot add repos the app isn't installed on.** If a repo isn't in the installation, it will never fire webhooks to begin with, so the allowlist can't help.

### Adding a repo end-to-end

1. **Install the GitHub App on the repo** (GitHub UI: App settings → Install → select repo)
2. **Add the repo to the allowlist** in `.env`:
   ```env
   META_AGENT_GITHUB_REPOSITORIES=example-user/meta-agent,other-org/other-repo
   ```
3. **Restart the API** (`pnpm build && node apps/api/dist/index.js`)

The allowlist is optional — when unset, all repos in the installation scope are processed. It exists to let you scope down without modifying the GitHub App installation every time.

### Current installation scope

```
Installation 123456789 on example-org (App ID 123456).
App ownership transferred from example-user to example-org on 2026-05-20.

Tracked repos (allowlist):
  example-user/meta-agent
  example-org/example-service
  example-org/proj-platform-registry
  example-org/proj-cloud-platform-portal
  example-org/proj-openobserve-resources-helm-chart
  example-org/proj-kargo-helm-chart
  example-org/proj-kafka-helm-chart
  example-org/proj-common-helm-chart
  example-org/proj-cnpg-database-helm-chart
  example-org/proj-aso-resources-helm-chart
```

Run this to check the current scope (requires `PyJWT` and `requests`):

```sh
python3 /tmp/check_install.py
```

**Note:** The app ownership transfer killed the old example-user installation (987654321). To track repos under both example-user and example-org simultaneously, either install the app separately on example-user (second installation, new ID — requires multi-installation config support) or rely on the single example-org installation.

## Tiers

### Personal (current)

One developer, one GitHub account, a handful of repos.

| Dimension          | Value                                         |
| ------------------ | --------------------------------------------- |
| GitHub App install | User account (`example-user`), selected repos |
| Work ownership     | Implicit — all tracked work is the user's     |
| Webhook volume     | Dozens/day                                    |
| Hermes delivery    | Single Slack DM or channel                    |
| Database           | SQLite, negligible footprint                  |

### Organization

A team or department within a single GitHub organization.

| Dimension          | Value                                                          |
| ------------------ | -------------------------------------------------------------- |
| GitHub App install | Org account (`example`), selected or all repos                 |
| Work ownership     | Explicit filter: `META_AGENT_GITHUB_ASSIGNED_TO=alice,bob`     |
| Webhook volume     | Hundreds–thousands/day                                         |
| Hermes delivery    | Per-repo or per-team Slack channels                            |
| Database           | SQLite for moderate orgs; Postgres above ~100k work items      |
| Routing            | `--deliver-chat-id` per webhook subscription for team channels |

### Enterprise

Multiple GitHub organizations under GitHub Enterprise Cloud.

| Dimension          | Value                                                         |
| ------------------ | ------------------------------------------------------------- |
| GitHub App install | Enterprise account, multiple orgs                             |
| Work ownership     | Team-based routing per org                                    |
| Webhook volume     | Thousands+/day                                                |
| Hermes delivery    | Multi-workspace Slack, routing rules per org/repo/team        |
| Database           | Postgres required                                             |
| Routing            | Multiple webhook subscriptions with distinct delivery targets |

## What stays the same across tiers

All tiers share the same pipeline:

```
GitHub webhook → API (4317) → SQLite ledger → Hermes webhook (8644) → Slack
```

The adapter normalizes `issues`, `pull_request`, `workflow_run`, and `check_run` identically. The Hermes feed pipeline is unchanged. Only configuration and delivery routing vary.

## Configuration surface

### Repository allowlist

```env
# Comma-separated full_name values (org/repo)
META_AGENT_GITHUB_REPOSITORIES=example/example-service,example/proj-mgmt
```

When set, only webhooks from these repos are processed. When unset, all repos where the GitHub App is installed are tracked.

**Important:** The allowlist only filters repos the app is already installed on. If you add a repo here that the app doesn't have access to, it will simply never be processed — no error, just no events.

### Assigned-to filter

```env
# Comma-separated GitHub usernames
META_AGENT_GITHUB_ASSIGNED_TO=hk,example-user
```

When set, only work items assigned to these users appear in digests and active-work queries. Webhooks are still ingested for all repos (the allowlist controls that), but status summaries filter to these assignees.

### Team routing

Per-repo or per-team delivery targets are configured via webhook subscriptions:

```sh
hermes webhook subscribe meta-agent-team-a \
  --deliver slack \
  --deliver-chat-id C12345 \
  --secret <secret> \
  --deliver-only \
  --prompt "🚩 *{title}*\n{sourceUrl}\n\n{body}"
```

The meta-agent API accepts a `hermes_route` field in webhook payloads (future) or routes by repo name to the correct subscription.

## GitHub App installation scope

The GitHub App's installation determines which repos fire webhooks. Nothing in meta-agent can expand this scope — the app can only receive events from repos where it's installed.

- **Personal:** Install on your user account, select repos.
- **Organization:** Org admin installs the app on the org, selecting repos or granting org-wide access.
- **Enterprise:** Enterprise admin installs across multiple orgs.

The repository allowlist in `.env` can further restrict which of these repos meta-agent cares about, but it cannot add repos the app isn't installed on.

## Database scaling

| Scale      | DB       | Threshold        |
| ---------- | -------- | ---------------- |
| Personal   | SQLite   | <10k work items  |
| Small org  | SQLite   | <100k work items |
| Large org  | Postgres | >100k work items |
| Enterprise | Postgres | Required         |

The storage package uses Drizzle ORM, which supports both SQLite and Postgres with minimal code changes. The migration path is a `META_AGENT_DATABASE_URL` change from `sqlite:` to `postgres:`.

## When to add routing

Start with a single Slack channel for all notifications. Add per-team routing when:

1. Multiple teams use the same GitHub org but want separate digests
2. Some repos are noisy and deserve their own channel
3. Different stakeholders want different notification verbosity

The webhook subscription system already supports this — it's configuration, not code.
