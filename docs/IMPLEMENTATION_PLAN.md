# Implementation Plan

This plan starts with a GitHub-only proof of concept, while keeping Jira and Confluence as planned adapters. The first useful outcome is a local service that can tell Hermes what changed, what is blocked, and how active work compares to visible implementation plans.

## Current Status

Last updated: 2026-06-22

Current milestone: Phase 8 — Confluence Adapter (worker reconciliation + requirement-drift alerts).

Next: Phase 9 — Summarization and Classification once deterministic Confluence/Jira/GitHub signals are reliable.

Achieved milestones:

- [x] Local repository initialized.
- [x] TypeScript/pnpm workspace scaffolded.
- [x] Fastify API shell added.
- [x] Worker shell added.
- [x] SQLite/Drizzle storage foundation added.
- [x] Initial database migration generated.
- [x] Browser-friendly root and webhook information pages added.
- [x] Health endpoints added at `/health` and `/api/health`.
- [x] GitHub webhook endpoint added at `POST /webhooks/github`.
- [x] GitHub webhook signatures verified with `X-Hub-Signature-256`.
- [x] Accepted webhook deliveries recorded in `source_changes`.
- [x] Local `.env` loading fixed for `pnpm --filter` execution.
- [x] Local key and SQLite artifacts ignored.
- [x] Verification passing: `pnpm format`, `pnpm test`, `pnpm check`.
- [x] `META_AGENT_GITHUB_WEBHOOK_SECRET` configured — webhook verified.
- [x] GitHub App private key saved to `data/github-app-private-key.pem`.
- [x] Local `.env` created with all required config vars.
- [x] GitHub App transferred from example-user to example-org (App ID 123456, Installation ID 123456789).
- [x] Repository allowlist expanded to 10 repos across example-user + example-org.
- [x] Rate limiting (30 POSTs/min per IP on `/webhooks/github`).
- [x] Body size limit (5 MB) on webhook endpoint.
- [x] Idempotent webhook delivery via `source_changes.idempotency_key`.
- [x] Public tunnel security: non-webhook traffic blocked via Host-header/proxy guard (dashboard/API return 403 through ngrok/Cloudflare); `/status` may be exposed through public tunnels only with configured Basic auth.
- [x] Phase 3: GitHub Adapter MVP — normalizes issues, PRs, workflow_runs, check_runs into work_items, blockers, plan_snapshots, milestone_events.
- [x] Phase 4: Hermes Feed Integration — HttpHermesClient with HMAC signing, dedup via emitted_feed_messages table.
- [x] Phase 5: Active Work Discovery — repository allowlist + assignee filter, `GET /api/active-work` and `GET /api/repos` endpoints.
- [x] Phase 6: Local Dashboard at `/dashboard` — live stats, work items with blocker counts, milestone timeline.
- [x] Jira adapter package scaffolded (`@meta-agent/jira-adapter`) — generic interface, noop client, webhook normalizer, ADF parser.
- [x] Jira webhook endpoint at `POST /webhooks/jira` — idempotent, passes through ngrok, normalizes issue_created/updated/deleted.
- [x] Jira plan body parsing (same `## Implementation Plan` schema shared with GitHub adapter).

Current blockers / setup items:

- [ ] Multi-installation support for GitHub App (currently single installation under example-org; example-user meta-agent repo needs separate install or multi-ID config).
- [ ] Jira credentials needed for real client (configuring `META_AGENT_JIRA_*` env vars + implementing `HttpJiraClient`).
- [ ] Confirm GitHub webhook redelivery returns `202 Accepted` through the ngrok URL.
- [ ] Configure `META_AGENT_STATUS_AUTH_USERNAME` and `META_AGENT_STATUS_AUTH_PASSWORD` in the live `.env` before browsing `/status` through the ngrok hostname.

Agent/ledger transparency setup items:

- [ ] Configure `META_AGENT_AGENT_EVENT_TOKEN` before exposing `POST /api/agent-events` beyond local trusted networks.
- [ ] Teach Hermes and other agents to emit the contract from `docs/agent-ledger-contracts.md` at task start, PR creation, test/runtime verification, blocker detection/resolution, and final summary.
- [ ] Add deterministic reconcilers that upgrade agent claims to verified ledger evidence only after GitHub/Jira/runtime checks pass.

Next implementation step:

- Phase 9 follow-up: summarize long comments, review threads, and document diffs with evidence-preserving deterministic fallbacks.

## Phase 0: Repository Foundation

- [x] Choose runtime and package layout.
- [x] Add development tooling.
- [x] Add configuration conventions.
- [x] Add database migration framework.
- [x] Add minimal logging and test setup.

Recommended default:

- TypeScript on Node.js for broad API SDK support and easy local services.
- SQLite for the first ledger database.
- Fastify for a small local HTTP API.
- Drizzle for migrations and typed persistence.
- Vitest for unit tests.

Acceptance criteria:

- [x] A new developer can run tests locally.
- [x] The service can load configuration from environment variables and a local config file.
- [x] The database can be created and migrated from scratch.

## Phase 1: Core Ledger Model

Build source-agnostic domain types and persistence before integrating any external API.

- [x] Define `ExternalItem`.
- [x] Define `SourceChange`.
- [x] Define `WorkItem`.
- [x] Define `Plan` (as plan_snapshots + plan_steps).
- [x] Define `PlanStep`.
- [x] Define `MilestoneEvent`.
- [x] Define `Blocker`.
- [x] Create database tables for normalized items, changes, links, plan snapshots, and emitted feed messages.
- [x] Add idempotency keys for source changes.

Implemented so far:

- `ExternalItem`, `ExternalLink`, `SourceChange`, `LinkQuery`, and `WorkSourceAdapter` exist in `@meta-agent/core`.
- `source_changes`, `work_items`, `plan_snapshots`, `plan_steps`, `milestone_events`, `blockers`, and `emitted_feed_messages` tables in Drizzle schema.
- `source_changes.idempotency_key` is unique and webhook inserts use conflict-ignore behavior.
- Storage repository functions for all tables implemented in `@meta-agent/storage`.
- Migration `0001_spotty_deathstrike.sql` applied.

Remaining model work:

- Add links table for cross-source references.
- Add repository/service APIs for querying normalized work items with plan data.

## Phase 2: Plan and Checklist Parser

Implement deterministic plan extraction from markdown bodies.

- [x] Parse `## Implementation Plan` sections.
- [x] Extract markdown checkbox steps.
- [x] Track step text, completion state, and order.
- [x] Detect changed, added, removed, and completed steps between snapshots.
- [x] Produce milestone events when steps transition from incomplete to complete.

Implemented as `@meta-agent/plan-parser` package (22 tests, 0 deps).

Example input:

```md
## Implementation Plan

- [x] Add webhook ingestion
- [ ] Store events in SQLite
- [ ] Publish Hermes digest
```

Acceptance criteria:

- Parser handles GitHub issue and PR bodies.
- Parser ignores unrelated checklists outside the selected plan section unless explicitly configured.
- Parser can diff two snapshots and emit milestone events.

## Phase 3: GitHub Adapter MVP

Implement GitHub as the first source adapter.

- [ ] Create a GitHub App.
- [ ] Configure app permissions for issues, pull requests, checks, actions, contents read, and metadata.
- [x] Add webhook receiver endpoint.
- [x] Verify webhook signatures.
- [x] Normalize `issues`, `pull_request`, `pull_request_review`, `issue_comment`, `check_run`, `check_suite`, `workflow_run`, and `push` events.
- [x] Store source payloads for replay/debugging.
- [ ] Add GraphQL reconciliation for active repositories.

GitHub event focus:

- Issue opened, edited, assigned, labeled, closed.
- Pull request opened, edited, synchronized, ready for review, review requested, closed, merged.
- Review approved or changes requested.
- Workflow run requested, completed, failed, cancelled, succeeded.
- Check run failed or recovered.

Acceptance criteria:

- The service ingests GitHub webhook payloads locally.
- Duplicate webhook deliveries do not create duplicate changes.
- A failed GitHub Actions workflow creates a blocker.
- A passing workflow after a failure resolves or supersedes the blocker.
- A completed plan checkbox creates a milestone event.

## Phase 4: Hermes Feed Integration

Connect ledger events to Hermes.

- [x] Define Hermes delivery mode: HTTP endpoint, local file inbox, or queue.
- [x] Implement a Hermes client abstraction.
- [x] Emit real-time blocker alerts.
- [x] Emit milestone alerts.
- [ ] Emit periodic status digests.
- [x] Track emitted messages to avoid duplicate notifications.

Implemented so far:

- `HermesMessage`, `HermesClient`, and `NoopHermesClient` exist in `@meta-agent/hermes`.

Remaining integration work:

- Choose the concrete same-host transport to the running Hermes agent.
- Implement retry and duplicate suppression around emitted messages.

Message categories:

- `milestone_reached`
- `blocker_detected`
- `blocker_resolved`
- `review_needed`
- `stale_work`
- `requirement_drift`
- `daily_digest`

Acceptance criteria:

- Hermes receives one concise message when a pipeline fails.
- Hermes receives one concise message when the same pipeline recovers.
- Hermes receives a digest summarizing active work by repo and status.

## Phase 5: Active Work Discovery

Decide how the system knows what work is currently relevant.

Supported discovery inputs:

- GitHub Projects v2 query.
- Assigned GitHub issues and PRs.
- Configured repository allowlist.
- Branch naming conventions.
- Explicit local config.

Recommended MVP:

```yaml
github:
  owner: example-user
  repositories:
    - meta-agent
  activeWork:
    assignedTo: hk
    includeProjectUrls: []
```

Acceptance criteria:

- The system can list active work without relying on all repository history.
- Inactive or archived repositories do not pollute the digest.
- Active work discovery can be changed without code edits.

## Phase 6: Local Dashboard

Build a small local read-only dashboard after the feed is useful.

- [x] Show active work items.
- [x] Show current plan step and progress.
- [x] Show linked PRs and CI state.
- [x] Show blockers and stale items.
- [x] Show recent milestone events.
- [x] Link to external GitHub/Jira/Confluence URLs.
- [x] Dashboard protected from public ngrok exposure (Host-header guard).

Acceptance criteria:

- Dashboard gives a fast overview of current work.
- Dashboard is useful even if Slack/Hermes is temporarily unavailable.
- Dashboard does not become the primary source of truth.

## Phase 7: Jira Adapter

Add Jira as a first-class work source.

- [ ] Add Jira authentication configuration.
- [ ] Fetch assigned issues.
- [ ] Fetch issues by project, JQL, sprint, or explicit key list.
- [ ] Normalize issue fields into `ExternalItem`.
- [ ] Detect status, assignee, priority, sprint, labels, components, and acceptance criteria changes.
- [ ] Parse links to GitHub PRs, branches, commits, and Confluence pages.
- [ ] Add Jira-specific reconciliation job.

Important drift checks:

- Jira says "In Review", but GitHub PR is still draft.
- GitHub PR merged, but Jira issue is still "In Progress".
- Acceptance criteria changed after implementation started.
- Jira issue has no linked code artifacts despite active GitHub work.

Acceptance criteria:

- Jira issues can link to GitHub PRs in the ledger.
- Jira status transitions appear in the digest.
- Acceptance criteria changes can trigger a drift alert.

## Phase 8: Confluence Adapter

Add Confluence as a read-only knowledge source.

- [x] Add Confluence authentication configuration.
- [x] Configure selected spaces/pages for indexing.
- [x] Fetch page metadata and body content.
- [x] Normalize pages as docs, ADRs, or requirements.
- [x] Track page version changes.
- [x] Extract links to Jira issues and GitHub artifacts.
- [x] Alert when linked docs change after implementation begins.

Important drift checks:

- ADR changed while related implementation PR is open.
- Requirements page changed after Jira story moved to implementation.
- Runbook changed after operational task started.

Acceptance criteria:

- Confluence changes are linked to active work items.
- Requirement drift alerts include the changed page and affected work item.
- Indexing scope is explicitly configured.

## Phase 9: Summarization and Classification

Introduce LLM-assisted summarization after deterministic signals are reliable.

- [ ] Summarize long comments, review threads, and document diffs.
- [ ] Classify comments as blocker, question, FYI, or decision.
- [ ] Generate concise status feed messages.
- [ ] Preserve source URLs and evidence in all summaries.
- [ ] Avoid using LLM output as the only basis for state transitions.

Acceptance criteria:

- Summaries cite the source item URL.
- Classifications can be overridden or ignored.
- The system can run in deterministic-only mode.

## Phase 10: Write-Back Actions

Only add write-back after read-only tracking is trustworthy.

Potential actions:

- Comment on GitHub issues or PRs.
- Suggest Jira status transitions.
- Comment on Jira issues with summarized blockers.
- Create a Confluence documentation update proposal.

Guardrails:

- Default to dry-run.
- Require explicit approval for mutations.
- Keep a complete audit log.

Acceptance criteria:

- Write-back can be disabled globally.
- Every mutation records source, reason, and payload.
- The system never changes external state from an LLM-only conclusion.

## Phase 11: Agent/Ledger Transparency Contracts

This phase makes the meta-agent a transparent shared observer for Hermes and other agents while preserving the rule that agent claims are evidence, not final truth.

Scope for the MVP:

- [x] Publish the contract in `docs/agent-ledger-contracts.md`.
- [x] Add append-only `agent_sessions` and `agent_events` storage tables.
- [x] Add `POST /api/agent-events` for Hermes/agent telemetry and evidence ingestion.
- [x] Add read-only endpoints that announce the contract and expose recent agent events.
- [x] Keep SQLite as the implementation database for now, but avoid SQLite-only JSON assumptions so the schema can migrate to Postgres/JSONB later.
- [x] Add tests for event validation, token handling, persistence, and read-back.

Follow-up accuracy/transparency tasks:

- [x] Add a lightweight `pnpm agent:event` helper so Hermes/agents can publish correlated task events without hand-rolling curl payloads.
- [x] Surface recent high-signal agent evidence in status digests under an explicit “awaiting verification” section.
- [x] Add deterministic reconcilers that can promote agent evidence only after GitHub/Jira/runtime checks confirm it.
- [x] Add model-assisted correlation as proposed links only, never as final truth.

Still out of scope for this phase:

- [ ] PostgreSQL migration.
- [ ] Automatic ledger truth transitions from agent events alone.
- [ ] Authoritative LLM-based correlation writes; model output remains limited to proposed correlations with confidence.

Acceptance criteria:

- Agents can send structured task/progress/evidence events with correlation metadata.
- Humans can inspect what agents reported and distinguish `agent_claimed`, `agent_observed`, `system_observed`, `verified`, and `manual_override` evidence.
- Existing GitHub/Jira/runtime reconciliation remains the source of verified truth.
- The contract is documented enough for Hermes, future agents, and humans to implement consistently.

## Initial Milestone Definition

The first usable milestone is complete when:

- GitHub webhook events are ingested locally.
- GitHub workflow failures create blocker events.
- Markdown implementation plans are parsed.
- Completed checklist items create milestone events.
- Hermes receives real-time blocker and milestone messages.
- A daily digest can be generated from the ledger.

## Risks

- External APIs may have inconsistent linking between tasks, PRs, commits, and docs.
- Free-form plans may be hard to parse unless conventions are enforced.
- Too many low-signal notifications will make the feed useless.
- Webhooks alone are insufficient because deliveries can be missed; reconciliation is required.
- Jira and Confluence schemas vary heavily between organizations.

## Decisions To Make Before Coding

- Runtime: TypeScript/Node.js vs Python.
- Database: SQLite vs Postgres.
- Hermes protocol: HTTP vs file inbox vs queue.
- First active-work source: assigned GitHub issues, GitHub Projects v2, or configured repositories.
- Whether to create a local dashboard in the MVP or after the feed is working.
