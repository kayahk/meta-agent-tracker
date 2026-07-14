# Agent/Ledger Transparency Contracts

## Goal

Give the meta-agent a transparent, append-only view of work performed by agents such as Hermes, without letting agent claims overwrite durable truth. Agents report context, correlation hints, and evidence. The meta-agent stores those events, links them to ledger objects, and later reconciles them against authoritative systems such as GitHub, Jira, Argo CD, Kubernetes, and implementation-plan documents.

PostgreSQL is intentionally deferred for now. The contracts below are storage-agnostic and use JSON payloads so the current SQLite ledger can migrate to Postgres/JSONB later without changing agent-facing semantics.

## Truth model

Agent events are evidence, not final truth.

Truth confidence should progress through these levels:

- `agent_claimed`: an agent says something happened, but the meta-agent has not verified it.
- `agent_observed`: an agent includes concrete evidence it observed, such as a command and output summary.
- `system_observed`: the meta-agent observed the state directly from an external API/webhook.
- `verified`: deterministic reconciliation confirmed the state from one or more authoritative systems.
- `manual_override`: a human explicitly corrected or accepted the ledger state.

The ledger should only mark work as truly complete when there is `verified` or `manual_override` evidence. Model output may propose correlations or status transitions, but it must not be the sole basis for truth transitions.

## Event ingestion endpoint

Agents publish events to:

```http
POST /api/agent-events
Authorization: Bearer <META_AGENT_AGENT_EVENT_TOKEN>
Content-Type: application/json
```

When no token is configured, local development/test servers may accept unsigned events. Production deployments should configure `META_AGENT_AGENT_EVENT_TOKEN` before exposing this endpoint.

The endpoint returns `202 Accepted` after the event is stored. It does not imply the claim has been verified.

## Publishing helper

Agents can post directly to the endpoint or use the repository helper:

```bash
META_AGENT_API_URL=http://127.0.0.1:4317 \
META_AGENT_AGENT_EVENT_TOKEN=$META_AGENT_AGENT_EVENT_TOKEN \
pnpm agent:event <<'JSON'
{"agent":"hermes","eventType":"task_started","task":"Improve meta-agent status accuracy","occurredAt":"2026-06-18T10:00:00.000Z"}
JSON
```

## Agent event envelope

Required fields:

```json
{
  "agent": "hermes",
  "eventType": "pr_opened",
  "task": "Improve meta-agent status truth reconciliation",
  "occurredAt": "2026-06-18T06:40:00.000Z"
}
```

Recommended fields:

```json
{
  "agent": "hermes",
  "sessionId": "slack:D0B4BBN7TUK:1781763700.196349",
  "eventType": "runtime_verified",
  "task": "Verify shared platform database ApplicationSet",
  "status": "claimed_complete",
  "confidence": "agent_observed",
  "correlation": {
    "ledgerTopic": "cnpg-database-gitops",
    "repo": "example-org/example-service",
    "branch": "agent-ledger-transparency-contracts",
    "prUrl": "https://github.com/example-org/example-service/pull/448",
    "commitSha": "abc1234",
    "jiraKey": "PLAT-123",
    "plan": {
      "repo": "example-org/example-service",
      "path": "docs/cnpg-database-applicationset-pr-plan.md",
      "items": ["ApplicationSet implementation", "Shared portal runtime claim"]
    }
  },
  "evidence": [
    {
      "type": "github_pr",
      "url": "https://github.com/example-org/example-service/pull/448",
      "state": "merged"
    },
    {
      "type": "argocd_application",
      "name": "platform-platform-portal-db-platform",
      "sync": "Synced",
      "health": "Healthy"
    }
  ],
  "summary": "The shared platform database claim is runtime verified."
}
```

## Supported event types

Initial contract:

- `task_started`
- `task_correlated`
- `pr_opened`
- `commit_pushed`
- `tests_passed`
- `tests_failed`
- `runtime_verified`
- `blocker_detected`
- `blocker_resolved_claimed`
- `plan_status_stale_suspected`
- `task_completed_claimed`
- `task_abandoned`

Unknown event types may be stored for forward compatibility, but dashboards should display them as unclassified.

## Correlation conventions

Agents should prefer explicit metadata over inference:

- Branch names should include a durable topic, e.g. `meta-status-ledger-*`, `platform-cnpg-gitops-*`, `portal-chat-*`.
- PR titles should use scopes when practical, e.g. `meta-agent(status): ...`, `platform-cnpg(gitops): ...`, `portal(chat): ...`.
- PR bodies should include a `Meta-agent correlation` section when work maps to an existing plan.
- Agent events should include `correlation.plan.path` and `correlation.plan.items` when known.
- Test/runtime evidence should identify the command or external object that was checked.

Example PR section:

```md
## Meta-agent correlation

- Ledger topic: cnpg-database-gitops
- Plan: example-org/example-service/docs/cnpg-database-applicationset-pr-plan.md
- Plan items:
  - ApplicationSet implementation
  - Shared portal runtime claim
- Verifies:
  - ArgoCD Application `platform-platform-portal-db-platform`
  - CNPG Database `platform-platform-portal-db-platform`
```

## Storage contract

The current implementation stores two new SQLite-backed tables:

- `agent_sessions`: coarse interaction/session metadata.
- `agent_events`: append-only telemetry/evidence with denormalized correlation columns plus a JSON payload.

The tables intentionally avoid SQLite-only JSON querying. Frequently filtered fields are stored as text columns, while the full payload remains JSON text. A future Postgres migration can map the payload to `jsonb` and keep the same endpoint contract.

## Reconciliation rules

Initial rules should be conservative:

- Agent `pr_opened`/`commit_pushed` events should be verified against GitHub before becoming system truth.
- Agent `tests_passed` events can be stored as evidence but should include command/output summary.
- Agent `runtime_verified` events should create a `needs_verification` signal unless the meta-agent can independently query the runtime source.
- Agent `plan_status_stale_suspected` events should produce a transparent dashboard/status hint, not silently edit plan docs.
- Agent `blocker_resolved_claimed` should only resolve a blocker automatically when a deterministic verifier confirms the blocker is gone.

## Model-assisted correlation rules

LLM/model output may suggest cross-source links, but those links are advisory until confirmed by deterministic evidence or a human:

- Proposed links use `origin = "llm_proposed"` and `relation = "proposes"`.
- Proposed links may carry a confidence score and reason in the advisory catalog.
- Drift detection, blocker resolution, completion state, and “linked work exists” checks must ignore proposed links.
- Only `deterministic` or `manual` link origins may be treated as authoritative ledger truth.

## Announcement for involved parties

For humans and agents:

- Agent events are auditable and append-only.
- Status digests should distinguish claimed, observed, and verified progress.
- The ledger should show evidence links wherever possible.
- A missing event does not mean no work happened; GitHub/Jira/runtime reconciliation still runs independently.
- A model may help correlate and summarize, but deterministic evidence or manual acceptance remains the source of final truth.
