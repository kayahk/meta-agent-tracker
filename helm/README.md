# Helm Configuration

Values files for deploying **meta-agent** with `proj-common-helm-chart`.

## Architecture

Single-pod deployment with two containers:

| Container  | Role                                      | Port |
| ---------- | ----------------------------------------- | ---- |
| **api**    | FastAPI webhook receiver (GitHub, Jira)   | 4317 |
| **worker** | Periodic scan + digest delivery (sidecar) | —    |

Both containers share the same Docker image but run different entry points. The worker runs in a loop (`while true; do node apps/worker/dist/index.js; sleep 1800; done`) to scan every 30 minutes.

## Structure

```
helm/
  values.yaml        # Base values (API deployment + worker sidecar)
  values-api.yaml    # Environment overrides (dev/staging/prod)
```

## Deployment

Single Helm release using `proj-common` chart:

```bash
helm install meta-agent-api oci://registry.example.com/helm/proj-common \
  -f helm/values.yaml \
  -f helm/values-api.yaml \
  -n meta-agent
```

Or via ArgoCD ApplicationSet:

```yaml
template:
  spec:
    sources:
      - repoURL: "oci://registry.example.com/helm/proj-common"
        chart: proj-common
        helm:
          valueFiles:
            - $values/helm/values.yaml
            - $values/helm/values-api.yaml
        targetRevision: 0.3.0
      - repoURL: https://github.com/example-org/meta-agent-tracker.git
        ref: values
        path: "."
```

## Release Name

The release name determines K8s resource names. Use `meta-agent-api` for consistency.

The K8s Secret is named `{release-name}-secret` → `meta-agent-api-secret`.
The worker sidecar references this secret via `envFrom.secretRef`.

## Image

Built by GitHub Actions (`build-push.yaml`) and pushed to ACR:

```
registry.example.com/meta-agent:{tag}
```

Tags:

- `latest` — latest `main` commit
- `{commit-sha}` — per-commit immutable tag
- `v{version}` — release tags

## Required Secrets

Create a K8s Secret with these keys before deploying:

```yaml
hermes-endpoint: "https://hermes.example.com"
hermes-webhook-secret: "xxx"
github-app-id: "123456"
github-private-key-path: "/secrets/github-key.pem"
github-webhook-secret: "xxx"
github-installation-id: "123456789"
github-repositories: "example-org/meta-agent-tracker"
github-assigned-to: "username"
jira-url: "https://jira.example.com"
jira-email: "user@example.com"
jira-pat: "xxx"
confluence-url: "https://confluence.example.com"
confluence-pat: "xxx"
confluence-spaces: "SPACE1,SPACE2"
llm-api-url: "https://api.example.com"
llm-api-key: "xxx"
llm-model: "anthropic/claude-sonnet-4"
```

## Notes

- **No VPN required**: All integrations use public API endpoints (GitHub API, Jira Cloud, Confluence DC)
- **SQLite**: Shared via `emptyDir` volume — both containers read/write the same database file
- **Worker loop**: The worker sidecar runs in a `while true` loop to stay alive and re-scan periodically
- **readOnlyRootFilesystem**: Both containers mount `/tmp` and `/data` as writable volumes
