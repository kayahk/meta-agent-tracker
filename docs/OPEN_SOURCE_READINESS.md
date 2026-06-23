# Open-source readiness analysis

This repository has strong potential to be published as a generic open-source project because the core architecture already separates normalized ledger storage from source-specific adapters. The remaining publication risk is mainly operational/configuration hygiene, not a fundamental rewrite.

## Current strengths

- Source-agnostic ledger: GitHub, Jira, Confluence, workflow, plan-document, and agent-event data are normalized before being rendered or delivered.
- Pluggable adapter shape: clients can run as real HTTP clients or no-op clients depending on runtime configuration.
- Local-first runtime: SQLite and localhost defaults make the project easy to run without a hosted control plane.
- Deterministic-first design: plan checklists, webhook payloads, API reconciliation, and workflow states drive authoritative decisions; LLM output remains advisory.
- Tests are already broad enough to support refactoring: storage, adapters, API, plan parsing, drift detection, and reconciliation have Vitest coverage.

## Required de-personalization work

Completed for this public tree:

- Replaced company, organization, repository, user, hostname, Jira key, Confluence, and GitHub App identifiers with generic examples/placeholders.
- Removed hardcoded plan-document repository selection from the worker and replaced it with `META_AGENT_GITHUB_PLAN_REPOSITORIES` plus generic defaults.
- Added `META_AGENT_GITHUB_PLAN_DOCS_PATH` and `META_AGENT_SCAN_INTERVAL_MS` for runtime parameterization.
- Ensured `.env.example`, Helm docs, and README use placeholders instead of real tokens or environment identifiers.
- Marked the package as publishable (`private: false`) and added MIT license metadata.
- Added config tests for the new runtime options.

## Secrets and history policy

The public repository should be initialized from this sanitized working tree as a fresh Git history. Do not mirror or push the private repository history because older commits may contain private environment names, remote URLs, operational paths, or accidental secrets that are irrelevant to the open-source project.

Do not publish:

- `.env` or `.env.*` files other than `.env.example`.
- Private keys (`*.pem`, `*.key`) or GitHub App key material.
- SQLite databases, WAL/SHM files, logs, process output, or local tunnel output.
- Private deployment values or live hostnames.
- Company-specific launchd/supervisor state unless rewritten as generic examples.

## Pluggability assessment

The service is already modular enough for open source:

- Providers/data sources are isolated into packages (`github-adapter`, `jira-adapter`, `confluence-adapter`, `work-catalog`).
- Communication output goes through a small delivery interface (`HermesClient`/`NoopHermesClient`).
- Runtime scoping is driven by repository/assignee/space allowlists.
- Worker reconciliation phases can be extended without changing webhook handlers.

Recommended future improvements:

- Introduce a formal `SourceProvider` registry so new connectors can be enabled through config rather than imported directly in the worker.
- Add a delivery-channel registry (`hermes`, `slack-webhook`, `webhook`, `stdout`) while keeping Hermes as one provider.
- Add MCP integration as a package with explicit capability/config boundaries.
- Add Kubernetes and ArgoCD connectors only as optional packages with no cluster names, namespaces, or kubeconfig assumptions baked in.
- Add a sample `docker-compose.yaml` for local API + worker + SQLite volume.

## Testing and coverage recommendations

Implemented now:

- Existing test suite passes in the sanitized public tree.
- Config parsing covers generic repository scoping, plan repository scoping, docs path, and worker interval settings.

Recommended before a first public release tag:

- Add coverage reporting (`vitest --coverage`) and publish a baseline coverage number in CI.
- Add secret scanning to CI (for example gitleaks or GitHub secret scanning on push).
- Add a repository-reference scan in CI that fails on prohibited organization/user/domain strings.
- Add smoke tests for a no-credentials startup path: API health should work and the worker should use no-op clients safely.
- Add connector contract tests for future Kubernetes, ArgoCD, MCP, and communication-channel providers.

## Publication approach

Use a fresh public repository named `meta-agent-tracker` under the personal GitHub account, then push this sanitized tree as its first commit. This avoids carrying private history while preserving the functional code and tests.
