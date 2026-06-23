# Demo notifications

Meta Agent Tracker can be demonstrated without connecting a real GitHub App, Jira, Confluence, Slack, Kubernetes cluster, or ArgoCD instance.

Start the API locally and open the static demo page:

```bash
pnpm install --frozen-lockfile
pnpm build
META_AGENT_ROOT=$(pwd) NODE_PATH=$(pwd)/node_modules node apps/api/dist/index.js
```

Then visit:

- Browser demo: <http://127.0.0.1:4317/demo/notifications>
- JSON demo data: <http://127.0.0.1:4317/api/demo/notifications>

The demo page shows de-personalized notification examples for:

- PR opened
- Review changes requested
- CI blocker detected
- CI blocker resolved
- Checklist milestone reached
- Plan document updated
- Requirement drift from documentation changes
- Periodic work status digest

All demo content uses generic repositories, users, project keys, and hostnames such as `example-org/commerce-api`, `PROJ-42`, `github.com/example-org`, and `confluence.example.com`.

## Example notification payload

```json
{
  "category": "requirement_drift",
  "title": "Requirement drift: API rate limit changed while PR is active",
  "body": "Changed page: API Gateway Rate Limits\nAffected work: example-org/api-gateway#91\nOld assumption: burst limit 500 requests/minute.\nNew requirement: burst limit 300 requests/minute with per-client overrides.\nSuggested action: re-check throttle configuration before merging.",
  "sourceUrl": "https://confluence.example.com/display/ENG/API+Gateway+Rate+Limits",
  "dedupKey": "demo:requirement_drift:api-gateway-rate-limit"
}
```

## Why this helps demos

- No secrets are needed.
- No private data is shown.
- Screenshots can be taken directly from the browser page.
- The JSON endpoint can be used by downstream templates, webhook demos, or UI mockups.
- It demonstrates the product value before a user configures live connectors.
