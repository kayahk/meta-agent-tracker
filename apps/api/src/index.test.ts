import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { createGitHubWebhookSignature } from "@meta-agent/github";
import { upsertWorkItem } from "@meta-agent/storage";
import { buildServer } from "./index.js";

const previousDatabaseUrl = process.env.META_AGENT_DATABASE_URL;
const previousWebhookSecret = process.env.META_AGENT_GITHUB_WEBHOOK_SECRET;
const previousAgentEventToken = process.env.META_AGENT_AGENT_EVENT_TOKEN;
const previousJiraUrl = process.env.META_AGENT_JIRA_URL;

afterEach(() => {
  if (previousDatabaseUrl === undefined) {
    delete process.env.META_AGENT_DATABASE_URL;
  } else {
    process.env.META_AGENT_DATABASE_URL = previousDatabaseUrl;
  }

  if (previousWebhookSecret === undefined) {
    delete process.env.META_AGENT_GITHUB_WEBHOOK_SECRET;
  } else {
    process.env.META_AGENT_GITHUB_WEBHOOK_SECRET = previousWebhookSecret;
  }

  if (previousAgentEventToken === undefined) {
    delete process.env.META_AGENT_AGENT_EVENT_TOKEN;
  } else {
    process.env.META_AGENT_AGENT_EVENT_TOKEN = previousAgentEventToken;
  }

  if (previousJiraUrl === undefined) {
    delete process.env.META_AGENT_JIRA_URL;
  } else {
    process.env.META_AGENT_JIRA_URL = previousJiraUrl;
  }
});

describe("api", () => {
  it("serves a browser-friendly root page", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meta-agent-api-"));
    process.env.META_AGENT_DATABASE_URL = join(directory, "root.sqlite");

    const { app } = await buildServer({ logger: false });
    const response = await app.inject({ method: "GET", url: "/" });

    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Meta Agent");
    expect(response.body).toContain("/health");
  });

  it("serves static de-personalized demo notifications", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meta-agent-api-"));
    process.env.META_AGENT_DATABASE_URL = join(directory, "demo-notifications.sqlite");

    const { app } = await buildServer({ logger: false });
    const html = await app.inject({ method: "GET", url: "/demo/notifications" });
    const json = await app.inject({ method: "GET", url: "/api/demo/notifications" });

    await app.close();
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.body).toContain("Demo notifications");
    expect(html.body).toContain("PR opened: Add checkout session audit trail");
    expect(html.body).toContain("Requirement drift: API rate limit changed while PR is active");
    expect(html.body).toContain("example-org/commerce-api");
    expect(json.statusCode).toBe(200);
    expect(json.json()).toMatchObject({ ok: true, count: 8 });
    const privateCompanyPattern = new RegExp(["sie", "dle"].join(""), "i");
    const privateOrgPattern = new RegExp(["sie", "dle", "group"].join(""), "i");
    expect(json.body).not.toMatch(privateCompanyPattern);
    expect(json.body).not.toMatch(privateOrgPattern);
  });

  it("reports health with the configured database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meta-agent-api-"));
    process.env.META_AGENT_DATABASE_URL = join(directory, "health.sqlite");

    const { app, database } = await buildServer({ logger: false });
    const response = await app.inject({ method: "GET", url: "/health" });

    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      database: database.path
    });
  });

  it("also reports health under /api/health", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meta-agent-api-"));
    process.env.META_AGENT_DATABASE_URL = join(directory, "api-health.sqlite");

    const { app, database } = await buildServer({ logger: false });
    const response = await app.inject({ method: "GET", url: "/api/health" });

    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      database: database.path
    });
  });

  it("serves recent work including plan documents and merged PRs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meta-agent-api-"));
    process.env.META_AGENT_DATABASE_URL = join(directory, "recent-work.sqlite");

    const { app, database } = await buildServer({ logger: false });
    migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/storage/drizzle", import.meta.url))
    });
    upsertWorkItem(database, {
      source: "github",
      externalId: "plan:example-org/example-service:docs/product-cost-transparency-plan.md",
      kind: "plan",
      title: "Product Cost Transparency Plan",
      status: "open",
      body: "Checklist: 1/2",
      externalUrl:
        "https://github.com/example-org/example-service/blob/main/docs/product-cost-transparency-plan.md",
      updatedAt: new Date("2026-06-12T12:00:00Z")
    });
    upsertWorkItem(database, {
      source: "github",
      externalId: "pr:example-org/example-service#415",
      kind: "pull_request",
      title: "docs(cost): evaluate product portal showback path",
      status: "merged",
      externalUrl: "https://github.com/example-org/example-service/pull/415",
      updatedAt: new Date("2026-06-12T10:43:09Z")
    });
    upsertWorkItem(database, {
      source: "github",
      externalId: "issue:example-org/example-service#99",
      kind: "issue",
      title: "Closed issue should not be recent work",
      status: "closed",
      externalUrl: "https://github.com/example-org/example-service/issues/99",
      updatedAt: new Date("2026-06-12T11:00:00Z")
    });

    const response = await app.inject({ method: "GET", url: "/api/recent-work" });

    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, count: 2 });
    expect(response.body).toContain("Product Cost Transparency Plan");
    expect(response.body).toContain("docs(cost): evaluate product portal showback path");
    expect(response.body).not.toContain("Closed issue should not be recent work");
  });

  it("serves a one-page status overview with linked sources", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meta-agent-api-"));
    process.env.META_AGENT_DATABASE_URL = join(directory, "status-overview.sqlite");
    process.env.META_AGENT_JIRA_URL = "https://jira.example.test";

    const { app, database } = await buildServer({ logger: false });
    migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/storage/drizzle", import.meta.url))
    });
    upsertWorkItem(database, {
      source: "github",
      externalId: "plan:example-org/example-service:docs/portal-holmesgpt-plan.md",
      kind: "plan",
      title: "Portal HolmesGPT Plan",
      status: "open",
      body: "Checklist: 2/5",
      externalUrl:
        "https://github.com/example-org/example-service/blob/main/docs/portal-holmesgpt-plan.md",
      updatedAt: new Date("2026-06-20T09:00:00Z")
    });
    upsertWorkItem(database, {
      source: "github",
      externalId: "pr:example-org/example-service#515",
      kind: "pull_request",
      title: "feat(portal): expose HolmesGPT overview",
      status: "open",
      externalUrl: "https://github.com/example-org/example-service/pull/515",
      updatedAt: new Date("2026-06-20T09:30:00Z")
    });
    upsertWorkItem(database, {
      source: "jira",
      externalId: "issue:PROJ-42",
      kind: "task",
      title: "PROJ-42 Track HolmesGPT rollout",
      status: "open",
      externalUrl: "https://jira.example.test/browse/PROJ-42",
      updatedAt: new Date("2026-06-20T08:30:00Z")
    });
    upsertWorkItem(database, {
      source: "github",
      externalId: "issue:example-org/example-service#516",
      kind: "issue",
      title: "Unsafe source URL should render as text",
      status: "open",
      externalUrl: "javascript:alert(1)",
      updatedAt: new Date("2026-06-20T10:30:00Z")
    });
    upsertWorkItem(database, {
      source: "github",
      externalId: "pr:example-org/example-service#517",
      kind: "pull_request",
      title: "Newer merged evidence drives last observed timestamp",
      status: "merged",
      externalUrl: "https://github.com/example-org/example-service/pull/517",
      updatedAt: new Date("2026-06-20T11:30:00Z")
    });

    const response = await app.inject({ method: "GET", url: "/status" });

    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Current work status");
    expect(response.body).toContain("Portal HolmesGPT Plan");
    expect(response.body).toContain("Implementation plan");
    expect(response.body).toContain("Pull request");
    expect(response.body).toContain("GitHub Actions");
    expect(response.body).toContain("Jira PROJ-42");
    expect(response.body).toContain("https://jira.example.test/browse/PROJ-42");
    expect(response.body).toContain("Last observed update: 2026-06-20 11:30 UTC");
    expect(response.body).toContain("Unsafe source URL should render as text");
    expect(response.body).not.toContain('href="javascript:alert(1)"');
  });

  it("announces the agent event contract and stores agent events as evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meta-agent-api-"));
    process.env.META_AGENT_DATABASE_URL = join(directory, "agent-events.sqlite");
    process.env.META_AGENT_AGENT_EVENT_TOKEN = "agent-token";

    const { app, database } = await buildServer({ logger: false });
    migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/storage/drizzle", import.meta.url))
    });

    const contract = await app.inject({ method: "GET", url: "/api/agent-contract" });
    expect(contract.statusCode).toBe(200);
    expect(contract.json()).toMatchObject({
      ok: true,
      endpoint: "POST /api/agent-events",
      auth: "bearer-token-required"
    });

    const eventPayload = {
      agent: "hermes",
      sessionId: "slack:D0B4BBN7TUK:1781763700.196349",
      eventType: "pr_opened",
      task: "Improve ledger transparency",
      status: "pr_opened",
      confidence: "agent_observed",
      occurredAt: "2026-06-18T06:40:00.000Z",
      correlation: {
        ledgerTopic: "meta-agent-ledger-transparency",
        repo: "example-org/meta-agent-tracker",
        branch: "agent-ledger-transparency-contracts",
        prUrl: "https://github.com/example-org/meta-agent-tracker/pull/4",
        plan: {
          repo: "example-org/meta-agent-tracker",
          path: "docs/IMPLEMENTATION_PLAN.md",
          items: ["Phase 11 MVP"]
        }
      },
      evidence: [{ type: "test", command: "pnpm test", result: "pending" }]
    };

    const accepted = await app.inject({
      method: "POST",
      url: "/api/agent-events",
      headers: {
        authorization: "Bearer agent-token",
        "content-type": "application/json"
      },
      payload: JSON.stringify(eventPayload)
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      ok: true,
      created: true,
      truth: "accepted_as_evidence_not_verified_truth",
      confidence: "agent_observed"
    });

    const list = await app.inject({ method: "GET", url: "/api/agent-events" });
    await app.close();

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ ok: true, count: 1 });
    expect(list.body).toContain("meta-agent-ledger-transparency");
    expect(list.body).toContain("agent_observed");
    expect(list.body).not.toContain("planItemsJson");
  });

  it("rejects agent events when the configured token is missing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meta-agent-api-"));
    process.env.META_AGENT_DATABASE_URL = join(directory, "agent-events-auth.sqlite");
    process.env.META_AGENT_AGENT_EVENT_TOKEN = "agent-token";

    const { app, database } = await buildServer({ logger: false });
    migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/storage/drizzle", import.meta.url))
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent-events",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        agent: "hermes",
        eventType: "task_started",
        task: "x",
        occurredAt: "2026-06-18T06:40:00.000Z"
      })
    });

    await app.close();
    expect(response.statusCode).toBe(401);
  });

  it("rejects agent events with a non-string occurredAt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meta-agent-api-"));
    process.env.META_AGENT_DATABASE_URL = join(
      directory,
      "agent-events-invalid-occurred-at.sqlite"
    );

    const { app, database } = await buildServer({ logger: false });
    migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/storage/drizzle", import.meta.url))
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent-events",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        agent: "hermes",
        eventType: "task_started",
        task: "x",
        occurredAt: 123
      })
    });

    await app.close();
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("occurredAt");
  });

  it("serves a browser-friendly GitHub webhook info page", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meta-agent-api-"));
    process.env.META_AGENT_DATABASE_URL = join(directory, "github-info.sqlite");

    const { app } = await buildServer({ logger: false });
    const response = await app.inject({ method: "GET", url: "/webhooks/github" });

    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("GitHub Webhook");
    expect(response.body).toContain("POST");
  });

  it("rejects GitHub webhooks when no webhook secret is configured", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meta-agent-api-"));
    process.env.META_AGENT_DATABASE_URL = join(directory, "github-no-secret.sqlite");
    delete process.env.META_AGENT_GITHUB_WEBHOOK_SECRET;

    const { app } = await buildServer({ logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json"
      },
      payload: "{}"
    });

    await app.close();

    expect(response.statusCode).toBe(503);
  });

  it("rejects GitHub webhooks with an invalid signature", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meta-agent-api-"));
    process.env.META_AGENT_DATABASE_URL = join(directory, "github-bad-signature.sqlite");
    process.env.META_AGENT_GITHUB_WEBHOOK_SECRET = "test-secret";

    const { app } = await buildServer({ logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": "sha256=bad"
      },
      payload: "{}"
    });

    await app.close();

    expect(response.statusCode).toBe(401);
  });

  it("accepts signed GitHub webhooks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meta-agent-api-"));
    process.env.META_AGENT_DATABASE_URL = join(directory, "github-signed.sqlite");
    process.env.META_AGENT_GITHUB_WEBHOOK_SECRET = "test-secret";

    const payload = JSON.stringify({ zen: "Keep it logically awesome." });
    const { app, database } = await buildServer({ logger: false });
    migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/storage/drizzle", import.meta.url))
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": "delivery-2",
        "x-hub-signature-256": createGitHubWebhookSignature(payload, "test-secret")
      },
      payload
    });

    await app.close();

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      ok: true,
      event: "ping",
      delivery: "delivery-2",
      effects: []
    });
  });
});
