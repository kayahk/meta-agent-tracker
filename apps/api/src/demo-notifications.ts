import type { HermesMessage } from "@meta-agent/hermes";

export const demoNotifications: HermesMessage[] = [
  {
    category: "pr_opened",
    title: "PR opened: Add checkout session audit trail",
    body: [
      "Repository: example-org/commerce-api",
      "Branch: feature/checkout-audit-trail",
      "Plan: Checkout Reliability Plan",
      "Status: implementation started; 2/6 checklist items complete.",
      "Next: review database migration and event payload contract."
    ].join("\n"),
    sourceUrl: "https://github.com/example-org/commerce-api/pull/128",
    dedupKey: "demo:pr_opened:commerce-api:128"
  },
  {
    category: "review_needed",
    title: "Review requested changes: Payment retry policy",
    body: [
      "Reviewer requested changes on example-org/payments-service#84.",
      "Concern: retry backoff needs a maximum cap before the worker requeues failed payments.",
      "Suggested action: update retry configuration and rerun the worker integration tests."
    ].join("\n"),
    sourceUrl: "https://github.com/example-org/payments-service/pull/84",
    dedupKey: "demo:review_needed:payments-service:84"
  },
  {
    category: "blocker_detected",
    title: "Blocker detected: CI failed for inventory sync",
    body: [
      "Workflow: integration-tests",
      "Repository: example-org/inventory-service",
      "Branch: feature/inventory-sync-window",
      "Failure: contract test `publishes stock adjustment event` timed out.",
      "Impact: PR remains blocked until the event fixture is fixed."
    ].join("\n"),
    sourceUrl: "https://github.com/example-org/inventory-service/actions/runs/100200300",
    dedupKey: "demo:blocker_detected:inventory-service:100200300"
  },
  {
    category: "blocker_resolved",
    title: "Blocker resolved: inventory sync CI recovered",
    body: [
      "Workflow `integration-tests` is green again for example-org/inventory-service#73.",
      "The previous timeout was resolved by updating the event fixture and rerunning the workflow.",
      "Status: ready for review."
    ].join("\n"),
    sourceUrl: "https://github.com/example-org/inventory-service/actions/runs/100200455",
    dedupKey: "demo:blocker_resolved:inventory-service:100200455"
  },
  {
    category: "milestone_reached",
    title: "Milestone reached: Feature flags wired into rollout plan",
    body: [
      "Plan: Checkout Reliability Plan",
      "Completed step: `Add runtime flag for gradual checkout rollout`.",
      "Progress: 3/6 checklist items complete.",
      "Evidence: example-org/commerce-api#128 updated with the completed implementation step."
    ].join("\n"),
    sourceUrl: "https://github.com/example-org/commerce-api/pull/128",
    dedupKey: "demo:milestone_reached:checkout-rollout-flags"
  },
  {
    category: "plan_updated",
    title: "Plan updated: Notification Routing Plan",
    body: [
      "Document changed: docs/notification-routing-plan.md",
      "New checklist item detected: `Add retry metrics to the delivery dashboard`.",
      "Linked work: example-org/notification-service#52 remains open.",
      "Suggested action: verify whether the PR scope still covers the new acceptance criterion."
    ].join("\n"),
    sourceUrl:
      "https://github.com/example-org/notification-service/blob/main/docs/notification-routing-plan.md",
    dedupKey: "demo:plan_updated:notification-routing"
  },
  {
    category: "requirement_drift",
    title: "Requirement drift: API rate limit changed while PR is active",
    body: [
      "Changed page: API Gateway Rate Limits",
      "Affected work: example-org/api-gateway#91",
      "Old assumption: burst limit 500 requests/minute.",
      "New requirement: burst limit 300 requests/minute with per-client overrides.",
      "Suggested action: re-check throttle configuration before merging."
    ].join("\n"),
    sourceUrl: "https://confluence.example.com/display/ENG/API+Gateway+Rate+Limits",
    dedupKey: "demo:requirement_drift:api-gateway-rate-limit"
  },
  {
    category: "daily_digest",
    title: "Work status digest — example workspace",
    body: [
      "Plan-driven work:",
      "• Checkout Reliability Plan — 3/6 items complete; 1 open PR; no blockers.",
      "• Notification Routing Plan — 2/5 items complete; new acceptance criterion detected.",
      "",
      "Blocked:",
      "• inventory-service#73 — integration test timeout, owner action required.",
      "",
      "Recently completed:",
      "• payments-service#82 merged after CI and review passed."
    ].join("\n"),
    sourceUrl: "https://github.com/example-org",
    dedupKey: "demo:daily_digest:example-workspace"
  }
];

export function renderDemoNotificationsPage(messages: HermesMessage[] = demoNotifications): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Meta Agent — Demo Notifications</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 960px; margin: 0 auto; padding: 32px 24px 56px; }
    .nav { margin-bottom: 20px; font-size: 13px; }
    a { color: LinkText; text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1 { margin: 0 0 8px; font-size: 30px; }
    .subtitle { margin: 0 0 24px; color: color-mix(in srgb, CanvasText 55%, Canvas); line-height: 1.5; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
    .card { border: 1px solid color-mix(in srgb, CanvasText 12%, Canvas); border-radius: 14px; background: color-mix(in srgb, CanvasText 4%, Canvas); padding: 16px; box-shadow: 0 1px 2px color-mix(in srgb, CanvasText 8%, transparent); }
    .category { display: inline-block; border-radius: 999px; padding: 3px 9px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; background: #dbeafe; color: #1e40af; }
    .category--blocker_detected, .category--review_needed, .category--requirement_drift { background: #fee2e2; color: #991b1b; }
    .category--blocker_resolved, .category--milestone_reached, .category--pr_merged { background: #dcfce7; color: #166534; }
    .category--daily_digest { background: #fef3c7; color: #92400e; }
    h2 { margin: 12px 0 8px; font-size: 17px; line-height: 1.3; }
    pre { white-space: pre-wrap; font: inherit; line-height: 1.45; margin: 0; color: color-mix(in srgb, CanvasText 82%, Canvas); }
    .source { display: block; margin-top: 12px; font-size: 12px; overflow-wrap: anywhere; }
    .json-link { margin: 16px 0 24px; }
    code { background: color-mix(in srgb, CanvasText 8%, Canvas); border-radius: 6px; padding: 2px 6px; }
  </style>
</head>
<body>
  <main>
    <div class="nav"><a href="/">← Home</a> &nbsp;|&nbsp; <a href="/status">Status overview</a> &nbsp;|&nbsp; <a href="/api/demo/notifications">JSON API</a></div>
    <h1>Demo notifications</h1>
    <p class="subtitle">De-personalized examples showing the kinds of messages Meta Agent Tracker can emit from GitHub, CI, plan documents, reviews, Jira/Confluence drift, and periodic digests. These are static examples: no credentials, private repositories, or live integrations required.</p>
    <p class="json-link">Use <code>GET /api/demo/notifications</code> to fetch the same examples as JSON for demos, screenshots, or downstream templates.</p>
    <section class="grid">
      ${messages.map(renderCard).join("\n")}
    </section>
  </main>
</body>
</html>`;
}

function renderCard(message: HermesMessage): string {
  const source = message.sourceUrl
    ? `<a class="source" href="${escapeHtml(message.sourceUrl)}">${escapeHtml(message.sourceUrl)}</a>`
    : "";
  return `<article class="card">
  <span class="category category--${escapeHtml(message.category)}">${escapeHtml(message.category.replaceAll("_", " "))}</span>
  <h2>${escapeHtml(message.title)}</h2>
  <pre>${escapeHtml(message.body)}</pre>
  ${source}
</article>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
