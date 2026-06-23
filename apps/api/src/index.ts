import Fastify from "fastify";
import { loadConfig } from "@meta-agent/config";
import { verifyGitHubWebhookSignature } from "@meta-agent/github";
import { HttpHermesClient, NoopHermesClient, type HermesClient } from "@meta-agent/hermes";
import {
  openDatabase,
  recordSourceChange,
  getActiveWorkItems,
  getDashboardStats,
  getRecentMilestones,
  getWorkItemsWithBlockers,
  recordAgentEvent,
  getRecentAgentEvents,
  type AgentEventConfidence,
  type AgentEventRow
} from "@meta-agent/storage";
import { normalizeWebhookEvent } from "@meta-agent/github-adapter";
import {
  normalizeJiraEvent,
  HttpJiraClient,
  NoopJiraClient,
  verifyJiraWebhookSecret,
  JIRA_WEBHOOK_SECRET_HEADER,
  type JiraClient
} from "@meta-agent/jira-adapter";

export interface BuildServerOptions {
  logger?: boolean;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const config = loadConfig();
  const logger = options.logger === false ? false : { level: config.logLevel };
  const app = Fastify({ logger });

  const database = openDatabase(config.databaseUrl);

  // Hermes client for feed delivery (noop if endpoint not configured)
  const hermes: HermesClient = config.hermes.endpoint
    ? new HttpHermesClient(config.hermes.endpoint, 5000, config.hermes.webhookSecret)
    : new NoopHermesClient();

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  // ── Webhook rate limiter ─────────────────────────────────────
  const RATE_WINDOW_MS = 60_000;
  const RATE_MAX_REQUESTS = 30;
  const rateCounters = new Map<string, { count: number; resetAt: number }>();

  app.addHook("onRequest", async (request, reply) => {
    // Block all non-webhook traffic coming through ngrok tunnels.
    // ngrok sets the Host header to its public domain; internal requests
    // use 127.0.0.1 or localhost. Only GitHub POST webhooks pass through.
    const host = (request.headers["host"] ?? "").toLowerCase();
    const isNgrok = host.includes("ngrok");

    if (isNgrok) {
      // Only allow POST webhooks through the ngrok tunnel
      const allowedPaths = ["/webhooks/github", "/webhooks/jira", "/api/agent-events"];
      if (allowedPaths.includes(request.url) && request.method === "POST") {
        return; // allowed
      }
      return reply.code(403).send({
        ok: false,
        error: "This endpoint is not exposed through ngrok"
      });
    }

    // Rate limiting: only for POST /webhooks/github
    if (request.url !== "/webhooks/github" || request.method !== "POST") return;

    const ip = request.ip;
    const now = Date.now();
    let entry = rateCounters.get(ip);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
      rateCounters.set(ip, entry);
    }

    entry.count++;

    if (entry.count > RATE_MAX_REQUESTS) {
      return reply.code(429).send({
        ok: false,
        error: "Too many webhook requests"
      });
    }
  });

  const rateCleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateCounters) {
      if (now >= entry.resetAt) rateCounters.delete(ip);
    }
  }, 300_000);
  rateCleanup.unref();

  app.addHook("onClose", async () => {
    clearInterval(rateCleanup);
    database.sqlite.close();
  });

  const health = async () => ({
    ok: true,
    database: database.path
  });

  app.get("/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Meta Agent</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        margin: 0;
        background: Canvas;
        color: CanvasText;
      }

      main {
        max-width: 760px;
        margin: 0 auto;
        padding: 48px 24px;
      }

      h1 {
        margin: 0 0 8px;
        font-size: 32px;
        line-height: 1.15;
      }

      p {
        line-height: 1.6;
      }

      code {
        background: color-mix(in srgb, CanvasText 8%, Canvas);
        border-radius: 6px;
        padding: 2px 6px;
      }

      a {
        color: LinkText;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Meta Agent</h1>
      <p>The local API is running.</p>
      <p>
        Status overview: <a href="/status"><code>/status</code></a><br />
        Dashboard: <a href="/dashboard"><code>/dashboard</code></a><br />
        Health: <a href="/health"><code>/health</code></a><br />
        API health: <a href="/api/health"><code>/api/health</code></a>
      </p>
      <p>
        Database: <code>${escapeHtml(database.path)}</code>
      </p>
    </main>
  </body>
</html>`;
  });

  app.get("/health", health);
  app.get("/api/health", health);

  // ── Dashboard ──────────────────────────────────────────────────

  app.get("/dashboard", async (_request, reply) => {
    const stats = getDashboardStats(database);
    const items = getWorkItemsWithBlockers(database, 20);
    const milestones = getRecentMilestones(database, 10);

    reply.type("text/html; charset=utf-8");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Meta Agent — Dashboard</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
    h1 { margin: 0 0 4px; font-size: 26px; }
    .subtitle { color: color-mix(in srgb, CanvasText 50%, Canvas); margin: 0 0 24px; font-size: 14px; }
    .stats { display: flex; gap: 16px; margin-bottom: 32px; }
    .stat { background: color-mix(in srgb, CanvasText 5%, Canvas); border-radius: 10px; padding: 16px 20px; flex: 1; text-align: center; }
    .stat-num { font-size: 28px; font-weight: 700; }
    .stat-label { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: color-mix(in srgb, CanvasText 50%, Canvas); margin-top: 4px; }
    .stat--warn .stat-num { color: #d97706; }
    .stat--good .stat-num { color: #16a34a; }
    h2 { font-size: 16px; margin: 24px 0 12px; padding-bottom: 8px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, Canvas); }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 8px 12px; text-align: left; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: color-mix(in srgb, CanvasText 50%, Canvas); border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, Canvas); }
    td { border-bottom: 1px solid color-mix(in srgb, CanvasText 4%, Canvas); }
    a { color: LinkText; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    .badge--issue { background: #dbeafe; color: #1e40af; }
    .badge--pr { background: #dcfce7; color: #15803d; }
    .badge--draft { background: color-mix(in srgb, CanvasText 8%, Canvas); color: color-mix(in srgb, CanvasText 60%, Canvas); }
    .badge--blocker { background: #fee2e2; color: #b91c1c; margin-left: 6px; }
    .empty { color: color-mix(in srgb, CanvasText 40%, Canvas); font-style: italic; padding: 16px 0; }
    .milestone { padding: 6px 0; font-size: 14px; }
    .milestone-step { font-weight: 600; }
    .milestone-item { font-size: 12px; color: color-mix(in srgb, CanvasText 50%, Canvas); }
    .milestone-item a { color: inherit; }
    .nav { margin-bottom: 20px; }
    .nav a { font-size: 13px; }
    footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid color-mix(in srgb, CanvasText 8%, Canvas); font-size: 12px; color: color-mix(in srgb, CanvasText 40%, Canvas); }
    footer a { color: inherit; }
  </style>
</head>
<body>
  <main>
    <div class="nav"><a href="/">← Home</a> &nbsp;|&nbsp; <a href="/status">Status overview</a> &nbsp;|&nbsp; <a href="/api/active-work">API: active-work</a> &nbsp;|&nbsp; <a href="/api/repos">API: repos</a> &nbsp;|&nbsp; <a href="/api/health">Health</a></div>
    <h1>Meta Agent</h1>
    <p class="subtitle">Local work-observation dashboard</p>

    <div class="stats">
      <div class="stat">
        <div class="stat-num">${stats.openItems}</div>
        <div class="stat-label">Open Items</div>
      </div>
      <div class="stat ${stats.activeBlockers > 0 ? "stat--warn" : "stat--good"}">
        <div class="stat-num">${stats.activeBlockers}</div>
        <div class="stat-label">Active Blockers</div>
      </div>
      <div class="stat stat--good">
        <div class="stat-num">${stats.recentMilestones}</div>
        <div class="stat-label">Recent Milestones</div>
      </div>
    </div>

    <h2>Active Work</h2>
    ${
      items.length === 0
        ? '<p class="empty">No open work items yet.</p>'
        : `
    <table>
      <thead><tr><th>Item</th><th>Kind</th><th>Status</th><th>Owner</th><th>Updated</th></tr></thead>
      <tbody>
        ${items
          .map(
            (i) => `
        <tr>
          <td><a href="${escapeHtml(String((i as Record<string, unknown>)["externalUrl"] ?? ""))}">${escapeHtml(String((i as Record<string, unknown>)["title"] ?? ""))}</a>${Number((i as Record<string, unknown>)["blockerCount"]) > 0 ? ` <span class="badge badge--blocker">${(i as Record<string, unknown>)["blockerCount"]}</span>` : ""}</td>
          <td><span class="badge badge--${(i as Record<string, unknown>)["kind"] === "pull_request" ? "pr" : "issue"}">${escapeHtml(String((i as Record<string, unknown>)["kind"] ?? ""))}</span></td>
          <td>${escapeHtml(String((i as Record<string, unknown>)["status"] ?? ""))}</td>
          <td>${escapeHtml(String((i as Record<string, unknown>)["owner"] ?? "—"))}</td>
          <td>${escapeHtml(String((i as Record<string, unknown>)["updatedAt"] ?? "").slice(0, 10))}</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>`
    }

    <h2>Recent Milestones</h2>
    ${
      milestones.length === 0
        ? '<p class="empty">No milestones yet — checklist items update on issue/PR edits.</p>'
        : milestones
            .map(
              (m) => `
    <div class="milestone">
      ✅ <span class="milestone-step">${escapeHtml(m.stepText)}</span>
      <span class="milestone-item"> — <a href="${escapeHtml(m.workItemUrl)}">${escapeHtml(m.workItemTitle)}</a></span>
      <span style="font-size:11px;color:color-mix(in srgb,CanvasText 40%,Canvas)">${escapeHtml(m.occurredAt.slice(0, 10))}</span>
    </div>`
            )
            .join("")
    }

    <footer>
      Database: <code>${escapeHtml(database.path)}</code> &nbsp;|&nbsp;
      Tracked repos: ${config.github.repositories ? escapeHtml(config.github.repositories.join(", ")) : "all installed"}
    </footer>
  </main>
</body>
</html>`;
  });

  app.get("/status", async (_request, reply) => {
    const stats = getDashboardStats(database);
    const rows = getStatusOverviewRows(database, config.jira.url, 60);
    const updatedAt = latestUpdatedAt(rows) ?? new Date().toISOString();

    reply.type("text/html; charset=utf-8");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Meta Agent — Status Overview</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 1180px; margin: 0 auto; padding: 32px 24px; }
    h1 { margin: 0 0 4px; font-size: 28px; }
    .subtitle { color: color-mix(in srgb, CanvasText 52%, Canvas); margin: 0 0 24px; font-size: 14px; }
    .nav { margin-bottom: 20px; }
    .nav a { font-size: 13px; color: LinkText; text-decoration: none; }
    .nav a:hover, a:hover { text-decoration: underline; }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 24px; }
    .stat { background: color-mix(in srgb, CanvasText 5%, Canvas); border: 1px solid color-mix(in srgb, CanvasText 8%, Canvas); border-radius: 12px; padding: 14px 16px; }
    .stat-num { font-size: 26px; font-weight: 700; }
    .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: color-mix(in srgb, CanvasText 50%, Canvas); }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 10px 12px; text-align: left; vertical-align: top; }
    th { position: sticky; top: 0; background: Canvas; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: color-mix(in srgb, CanvasText 50%, Canvas); border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, Canvas); }
    td { border-bottom: 1px solid color-mix(in srgb, CanvasText 6%, Canvas); }
    a { color: LinkText; text-decoration: none; }
    .title { font-weight: 650; }
    .muted { color: color-mix(in srgb, CanvasText 48%, Canvas); font-size: 12px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 650; white-space: nowrap; }
    .badge--plan { background: #e0e7ff; color: #3730a3; }
    .badge--pull_request { background: #dcfce7; color: #166534; }
    .badge--issue, .badge--task, .badge--story { background: #dbeafe; color: #1d4ed8; }
    .badge--status { background: color-mix(in srgb, CanvasText 8%, Canvas); color: color-mix(in srgb, CanvasText 70%, Canvas); }
    .badge--blocker { background: #fee2e2; color: #991b1b; }
    .links { display: flex; flex-wrap: wrap; gap: 6px; }
    .links a, .links span { border: 1px solid color-mix(in srgb, CanvasText 14%, Canvas); border-radius: 999px; padding: 2px 8px; font-size: 12px; }
    .empty { color: color-mix(in srgb, CanvasText 40%, Canvas); font-style: italic; padding: 20px 0; }
    footer { margin-top: 28px; padding-top: 16px; border-top: 1px solid color-mix(in srgb, CanvasText 8%, Canvas); font-size: 12px; color: color-mix(in srgb, CanvasText 42%, Canvas); }
    @media (max-width: 860px) { .stats { grid-template-columns: 1fr; } table, thead, tbody, th, td, tr { display: block; } thead { display: none; } tr { border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, Canvas); padding: 10px 0; } td { border-bottom: 0; padding: 5px 0; } }
  </style>
</head>
<body>
  <main>
    <div class="nav"><a href="/">← Home</a> &nbsp;|&nbsp; <a href="/dashboard">Dashboard</a> &nbsp;|&nbsp; <a href="/api/recent-work">API: recent-work</a> &nbsp;|&nbsp; <a href="/api/agent-events">API: agent-events</a></div>
    <h1>Current work status</h1>
    <p class="subtitle">One-page overview generated from the meta-agent ledger. Last observed update: ${escapeHtml(formatDateTime(updatedAt))}</p>
    <div class="stats">
      <div class="stat"><div class="stat-num">${stats.openItems}</div><div class="stat-label">Open / draft items</div></div>
      <div class="stat"><div class="stat-num">${stats.activeBlockers}</div><div class="stat-label">Active blockers</div></div>
      <div class="stat"><div class="stat-num">${rows.length}</div><div class="stat-label">Rows in overview</div></div>
    </div>
    ${
      rows.length === 0
        ? '<p class="empty">No ledger items have been observed yet.</p>'
        : `
    <table aria-label="Current meta-agent status overview">
      <thead><tr><th>Work</th><th>Type</th><th>Status</th><th>Owner</th><th>Sources</th><th>Updated</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (row) => `
        <tr>
          <td>${renderStatusAnchor(row.primaryUrl, row.title, "title")}<div class="muted">${escapeHtml(row.externalId)}</div></td>
          <td><span class="badge badge--${escapeHtml(row.kind)}">${escapeHtml(formatKind(row.kind))}</span>${row.blockerCount > 0 ? ` <span class="badge badge--blocker">${row.blockerCount} blocker${row.blockerCount === 1 ? "" : "s"}</span>` : ""}</td>
          <td><span class="badge badge--status">${escapeHtml(row.status ?? "unknown")}</span></td>
          <td>${escapeHtml(row.owner ?? "—")}</td>
          <td><div class="links">${row.links.map((link) => renderStatusAnchor(link.url, link.label)).join("")}</div></td>
          <td>${escapeHtml(formatDateTime(row.updatedAt))}</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>`
    }
    <footer>
      Database: <code>${escapeHtml(database.path)}</code> &nbsp;|&nbsp;
      Tracked repos: ${config.github.repositories ? escapeHtml(config.github.repositories.join(", ")) : "all installed"}
    </footer>
  </main>
</body>
</html>`;
  });

  // ── Active Work Discovery ─────────────────────────────────────

  app.get("/api/active-work", async (_request, reply) => {
    const repos = config.github.repositories;
    const assignees = config.github.assignedTo;

    const query: Record<string, unknown> = { limit: 50 };
    if (assignees) query.assignees = assignees;
    if (repos) query.repositoryNames = repos;

    const items = getActiveWorkItems(database, query as Parameters<typeof getActiveWorkItems>[1]);

    return reply.send({
      ok: true,
      count: items.length,
      filters: {
        repositories: repos ?? "(all installed)",
        assignedTo: assignees ?? "(all)"
      },
      items: items.map((i) => ({
        id: i.id,
        source: i.source,
        kind: i.kind,
        title: i.title,
        status: i.status,
        owner: i.owner,
        externalId: i.externalId,
        externalUrl: i.externalUrl,
        updatedAt: i.updatedAt
      }))
    });
  });

  app.get("/api/recent-work", async (_request, reply) => {
    const rows = database.sqlite
      .prepare(
        `SELECT id, source, kind, title, status, owner, external_id AS externalId,
                external_url AS externalUrl, updated_at AS updatedAt
         FROM work_items
         WHERE kind = 'plan'
            OR (kind = 'pull_request' AND status IN ('merged', 'closed'))
         ORDER BY updated_at DESC
         LIMIT 100`
      )
      .all() as Array<Record<string, unknown>>;

    return reply.send({
      ok: true,
      count: rows.length,
      items: rows
    });
  });

  app.get("/api/repos", async (_request, reply) => {
    return reply.send({
      ok: true,
      installed: "(see docs/source-scoping.md or run check_install.py for live list)",
      tracked: config.github.repositories ?? "(all installed repos — no allowlist set)"
    });
  });

  app.get("/api/agent-contract", async (_request, reply) => {
    return reply.send({
      ok: true,
      contractVersion: "2026-06-18.agent-ledger-v1",
      endpoint: "POST /api/agent-events",
      auth: config.agentEvents.token ? "bearer-token-required" : "not-configured-local-dev-only",
      truthModel: {
        rule: "Agent events are append-only evidence, not final ledger truth.",
        confidence: AGENT_EVENT_CONFIDENCES,
        verification:
          "Only deterministic system verification or manual override should promote work to final truth."
      },
      requiredFields: ["agent", "eventType", "task", "occurredAt"],
      recommendedCorrelation: [
        "ledgerTopic",
        "repo",
        "branch",
        "prUrl",
        "commitSha",
        "jiraKey",
        "plan.repo",
        "plan.path",
        "plan.items"
      ],
      eventTypes: AGENT_EVENT_TYPES,
      docs: "docs/agent-ledger-contracts.md"
    });
  });

  app.get("/api/agent-events", async (request, reply) => {
    const query = request.query as { limit?: string | number };
    const limitRaw = Number(query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 50;
    const events = getRecentAgentEvents(database, limit).map(formatAgentEventRow);

    return reply.send({
      ok: true,
      count: events.length,
      truthModel:
        "agent_events are evidence; verified ledger truth still comes from reconcilers/manual acceptance",
      items: events
    });
  });

  app.post(
    "/api/agent-events",
    {
      config: { bodyLimit: 1024 * 1024 }
    },
    async (request, reply) => {
      const authResult = authorizeAgentEvent(
        request.headers["authorization"],
        config.agentEvents.token
      );
      if (!authResult.ok) {
        return reply.code(authResult.status).send({ ok: false, error: authResult.error });
      }

      const payload = typeof request.body === "string" ? request.body : "";
      if (!payload) {
        return reply.code(400).send({ ok: false, error: "Missing JSON payload" });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return reply.code(400).send({ ok: false, error: "Invalid JSON payload" });
      }

      const normalized = normalizeAgentEventPayload(parsed);
      if (!normalized.ok) {
        return reply.code(400).send({ ok: false, error: normalized.error });
      }

      const result = recordAgentEvent(database, normalized.event);
      app.log.info(
        {
          eventType: normalized.event.eventType,
          agent: normalized.event.agent,
          created: result.created
        },
        "agent event recorded"
      );

      return reply.code(202).send({
        ok: true,
        created: result.created,
        id: result.id,
        truth: "accepted_as_evidence_not_verified_truth",
        confidence: normalized.event.confidence ?? "agent_claimed"
      });
    }
  );

  app.get("/webhooks/github", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GitHub Webhook - Meta Agent</title>
  </head>
  <body>
    <main>
      <h1>GitHub Webhook</h1>
      <p>This endpoint is reachable. GitHub must call it with <code>POST</code>.</p>
      <p>Signed deliveries are verified with <code>X-Hub-Signature-256</code>.</p>
    </main>
  </body>
</html>`;
  });

  app.post(
    "/webhooks/github",
    {
      config: { bodyLimit: 5 * 1024 * 1024 }
    },
    async (request, reply) => {
      if (!config.github.webhookSecret) {
        return reply.code(503).send({
          ok: false,
          error: "GitHub webhook secret is not configured"
        });
      }

      const payload = typeof request.body === "string" ? request.body : "";
      const signature = getRequiredHeader(request.headers["x-hub-signature-256"]);
      const event = getRequiredHeader(request.headers["x-github-event"]);
      const delivery = getRequiredHeader(request.headers["x-github-delivery"]);

      if (!payload || !signature || !event || !delivery) {
        return reply.code(400).send({
          ok: false,
          error: "Missing GitHub webhook payload or required headers"
        });
      }

      if (!verifyGitHubWebhookSignature(payload, signature, config.github.webhookSecret)) {
        return reply.code(401).send({
          ok: false,
          error: "Invalid GitHub webhook signature"
        });
      }

      let parsedPayload: unknown;

      try {
        parsedPayload = JSON.parse(payload);
      } catch {
        return reply.code(400).send({
          ok: false,
          error: "Invalid JSON payload"
        });
      }

      // Repository allowlist: skip repos not in the configured list
      if (config.github.repositories) {
        const repoFullName = extractRepoName(parsedPayload);
        if (repoFullName && !config.github.repositories.includes(repoFullName)) {
          app.log.debug({ repo: repoFullName }, "webhook skipped: repo not in allowlist");
          return reply.code(202).send({
            ok: true,
            event,
            delivery,
            skipped: "repository not in allowlist"
          });
        }
      }

      recordSourceChange(database, {
        source: "github",
        externalId: delivery,
        changeType: event,
        idempotencyKey: `github:webhook:${delivery}`,
        occurredAt: new Date(),
        payloadJson: JSON.stringify(parsedPayload)
      });

      // Normalize the webhook event into the ledger and deliver to Hermes
      const result = await normalizeWebhookEvent(database, event, parsedPayload, hermes);

      app.log.info({ event, effects: result.effects }, "webhook normalized");

      return reply.code(202).send({
        ok: true,
        event,
        delivery,
        effects: result.effects.map((e) => e.detail)
      });
    }
  );

  // ── Jira Webhook ────────────────────────────────────────────────

  // Jira client (real if configured, noop otherwise)
  const jira: JiraClient =
    config.jira.url && config.jira.pat
      ? new HttpJiraClient({ url: config.jira.url, pat: config.jira.pat })
      : new NoopJiraClient();

  app.post(
    "/webhooks/jira",
    {
      config: { bodyLimit: 5 * 1024 * 1024 }
    },
    async (request, reply) => {
      if (!config.jira.webhookSecret) {
        return reply.code(503).send({
          ok: false,
          error: "Jira webhook secret is not configured"
        });
      }

      const payload = typeof request.body === "string" ? request.body : "";
      const providedSecret = getRequiredHeader(request.headers[JIRA_WEBHOOK_SECRET_HEADER]);

      if (!providedSecret) {
        return reply.code(400).send({
          ok: false,
          error: `Missing ${JIRA_WEBHOOK_SECRET_HEADER} header`
        });
      }

      if (!verifyJiraWebhookSecret(providedSecret, config.jira.webhookSecret)) {
        return reply.code(401).send({
          ok: false,
          error: "Invalid Jira webhook secret"
        });
      }

      let parsedPayload: unknown;

      try {
        parsedPayload = JSON.parse(payload);
      } catch {
        return reply.code(400).send({
          ok: false,
          error: "Invalid JSON payload"
        });
      }

      // Extract the Jira event name from the payload
      const webhookEvent = extractJiraEvent(parsedPayload);
      if (!webhookEvent) {
        return reply.code(400).send({
          ok: false,
          error: "Missing webhookEvent in Jira payload"
        });
      }

      // Derive an idempotency key from webhookEvent + timestamp
      const timestamp = extractJiraTimestamp(parsedPayload);
      const delivery = `${webhookEvent}:${timestamp}`;

      recordSourceChange(database, {
        source: "jira",
        externalId: delivery,
        changeType: webhookEvent,
        idempotencyKey: `jira:webhook:${delivery}`,
        occurredAt: timestamp ? new Date(timestamp) : new Date(),
        payloadJson: JSON.stringify(parsedPayload)
      });

      // Normalize the Jira webhook event into the ledger and deliver to Hermes
      const result = await normalizeJiraEvent(database, webhookEvent, parsedPayload, hermes);

      app.log.info({ event: webhookEvent, effects: result.effects }, "jira webhook normalized");

      return reply.code(202).send({
        ok: true,
        event: webhookEvent,
        effects: result.effects.map((e) => e.detail)
      });
    }
  );

  return { app, config, database };
}

interface StatusOverviewLink {
  label: string;
  url?: string;
}

interface StatusOverviewRow {
  id: number;
  source: string;
  externalId: string;
  kind: string;
  title: string;
  status: string | null;
  owner: string | null;
  primaryUrl: string;
  updatedAt: string;
  blockerCount: number;
  links: StatusOverviewLink[];
}

function getStatusOverviewRows(
  database: ReturnType<typeof openDatabase>,
  jiraBaseUrl: string | undefined,
  limit = 60
): StatusOverviewRow[] {
  const rows = database.sqlite
    .prepare(
      `SELECT
        wi.id,
        wi.source,
        wi.external_id AS externalId,
        wi.kind,
        wi.title,
        wi.status,
        wi.owner,
        wi.external_url AS primaryUrl,
        wi.updated_at AS updatedAt,
        COUNT(b.id) AS blockerCount
      FROM work_items wi
      LEFT JOIN blockers b ON b.work_item_id = wi.id AND b.status = 'active'
      WHERE wi.status IN ('open', 'draft')
         OR wi.kind = 'plan'
         OR (wi.kind = 'pull_request' AND wi.status IN ('merged', 'closed'))
         OR wi.source = 'jira'
      GROUP BY wi.id
      ORDER BY
        CASE WHEN wi.status IN ('open', 'draft') THEN 0 ELSE 1 END,
        wi.updated_at DESC
      LIMIT ?`
    )
    .all(limit) as Array<Omit<StatusOverviewRow, "links">>;

  const externalIds = rows.map((row) => row.externalId);
  const placeholders = externalIds.map(() => "?").join(", ");
  const relatedRows =
    externalIds.length === 0
      ? []
      : (database.sqlite
          .prepare(
            `SELECT
        l.from_external_id AS fromExternalId,
        l.to_external_id AS toExternalId,
        l.relation,
        l.origin,
        COALESCE(wi_to.title, l.to_external_id) AS toTitle,
        wi_to.external_url AS toUrl,
        wi_to.kind AS toKind,
        COALESCE(wi_from.title, l.from_external_id) AS fromTitle,
        wi_from.external_url AS fromUrl,
        wi_from.kind AS fromKind
      FROM links l
      LEFT JOIN work_items wi_to ON wi_to.external_id = l.to_external_id
      LEFT JOIN work_items wi_from ON wi_from.external_id = l.from_external_id
      WHERE l.from_external_id IN (${placeholders})
         OR l.to_external_id IN (${placeholders})`
          )
          .all(...externalIds, ...externalIds) as Array<Record<string, unknown>>);

  const linksByExternalId = new Map<string, StatusOverviewLink[]>();
  for (const link of relatedRows) {
    const fromExternalId = String(link["fromExternalId"] ?? "");
    const toExternalId = String(link["toExternalId"] ?? "");
    const origin = String(link["origin"] ?? "");
    const relation = String(link["relation"] ?? "references");
    const suffix =
      origin === "llm_proposed" ? " (proposed)" : relation === "proposes" ? " (proposed)" : "";
    addLink(
      linksByExternalId,
      fromExternalId,
      statusLink(
        `${formatKind(String(link["toKind"] ?? "link"))}: ${String(link["toTitle"] ?? toExternalId)}${suffix}`,
        nonEmpty(link["toUrl"])
      )
    );
    addLink(
      linksByExternalId,
      toExternalId,
      statusLink(
        `${formatKind(String(link["fromKind"] ?? "link"))}: ${String(link["fromTitle"] ?? fromExternalId)}${suffix}`,
        nonEmpty(link["fromUrl"])
      )
    );
  }

  return rows.map((row) => {
    const links = baseSourceLinks(row, jiraBaseUrl);
    for (const related of linksByExternalId.get(row.externalId) ?? []) links.push(related);
    return { ...row, blockerCount: Number(row.blockerCount), links: dedupeLinks(links) };
  });
}

function baseSourceLinks(
  row: Omit<StatusOverviewRow, "links">,
  jiraBaseUrl?: string
): StatusOverviewLink[] {
  const links: StatusOverviewLink[] = [];
  if (row.primaryUrl) {
    links.push({ label: primarySourceLabel(row), url: row.primaryUrl });
  }
  const repo = repoFromExternalId(row.externalId) ?? repoFromGitHubUrl(row.primaryUrl);
  if (repo) {
    links.push({ label: "GitHub Actions", url: `https://github.com/${repo}/actions` });
  }
  const jiraKey = jiraKeyFromExternalId(row.externalId) ?? jiraKeyFromTitle(row.title);
  const normalizedJiraBase = jiraBaseUrl?.replace(/\/+$/, "");
  if (jiraKey) {
    links.push(
      statusLink(
        `Jira ${jiraKey}`,
        normalizedJiraBase
          ? `${normalizedJiraBase}/browse/${encodeURIComponent(jiraKey)}`
          : undefined
      )
    );
  }
  return links;
}

function primarySourceLabel(row: Omit<StatusOverviewRow, "links">) {
  if (row.kind === "plan") return "Implementation plan";
  if (row.kind === "pull_request") return "Pull request";
  if (row.source === "jira" || row.kind === "story" || row.kind === "task") return "Jira issue";
  if (row.kind === "issue") return "GitHub issue";
  return "Source";
}

function statusLink(label: string, url?: string): StatusOverviewLink {
  const link: StatusOverviewLink = { label };
  if (url) link.url = url;
  return link;
}

function addLink(map: Map<string, StatusOverviewLink[]>, key: string, link: StatusOverviewLink) {
  if (!key) return;
  const existing = map.get(key) ?? [];
  existing.push(link);
  map.set(key, existing);
}

function dedupeLinks(links: StatusOverviewLink[]): StatusOverviewLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.label}\n${link.url ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function repoFromExternalId(externalId: string): string | undefined {
  const match = externalId.match(/^(?:issue|pr|plan):([^#:]+\/[^#:]+)/);
  return match?.[1];
}

function repoFromGitHubUrl(url: string): string | undefined {
  const match = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)/);
  return match?.[1];
}

function jiraKeyFromExternalId(externalId: string): string | undefined {
  return externalId.match(/(?:^|:)([A-Z][A-Z0-9]+-\d+)$/)?.[1];
}

function jiraKeyFromTitle(title: string): string | undefined {
  return title.match(/\b([A-Z][A-Z0-9]+-\d+)\b/)?.[1];
}

function renderStatusAnchor(url: string | undefined, label: string, className?: string) {
  const classAttribute = className ? ` class="${escapeHtml(className)}"` : "";
  const safeUrl = safeHttpUrl(url);
  if (!safeUrl) return `<span${classAttribute}>${escapeHtml(label)}</span>`;
  return `<a${classAttribute} href="${escapeHtml(safeUrl)}">${escapeHtml(label)}</a>`;
}

function safeHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function latestUpdatedAt(rows: Pick<StatusOverviewRow, "updatedAt">[]): string | undefined {
  let latest: string | undefined;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const time = new Date(row.updatedAt).getTime();
    if (!Number.isNaN(time) && time > latestTime) {
      latest = row.updatedAt;
      latestTime = time;
    }
  }
  return latest;
}

function formatKind(kind: string) {
  return kind.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDateTime(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

const AGENT_EVENT_CONFIDENCES = [
  "agent_claimed",
  "agent_observed",
  "system_observed",
  "verified",
  "manual_override"
] as const;
const AGENT_EVENT_TYPES = [
  "task_started",
  "task_correlated",
  "pr_opened",
  "commit_pushed",
  "tests_passed",
  "tests_failed",
  "runtime_verified",
  "blocker_detected",
  "blocker_resolved_claimed",
  "plan_status_stale_suspected",
  "task_completed_claimed",
  "task_abandoned"
] as const;

function authorizeAgentEvent(
  header: string | string[] | undefined,
  configuredToken: string | undefined
) {
  if (!configuredToken) return { ok: true as const };
  const value = getRequiredHeader(header);
  if (!value?.startsWith("Bearer ")) {
    return { ok: false as const, status: 401, error: "Missing bearer token" };
  }
  const provided = value.slice("Bearer ".length).trim();
  if (provided !== configuredToken) {
    return { ok: false as const, status: 403, error: "Invalid bearer token" };
  }
  return { ok: true as const };
}

function normalizeAgentEventPayload(payload: unknown) {
  if (payload == null || typeof payload !== "object") {
    return { ok: false as const, error: "Payload must be a JSON object" };
  }
  const raw = payload as Record<string, unknown>;
  const agent = nonEmpty(raw["agent"]);
  const eventType = nonEmpty(raw["eventType"]);
  const task = nonEmpty(raw["task"]);
  const occurredAtValue = raw["occurredAt"];
  const occurredAtRaw = typeof occurredAtValue === "string" ? nonEmpty(occurredAtValue) : undefined;
  if (!agent || !eventType || !task || !occurredAtRaw) {
    return { ok: false as const, error: "Required fields: agent, eventType, task, occurredAt" };
  }
  const occurredAt = new Date(occurredAtRaw);
  if (Number.isNaN(occurredAt.getTime())) {
    return { ok: false as const, error: "occurredAt must be an ISO timestamp" };
  }

  const correlation = objectValue(raw["correlation"]);
  const plan = objectValue(correlation?.["plan"]);
  const evidence = Array.isArray(raw["evidence"]) ? raw["evidence"] : undefined;
  const confidenceRaw = nonEmpty(raw["confidence"]);
  const confidence = isAgentEventConfidence(confidenceRaw) ? confidenceRaw : undefined;
  const planItems = Array.isArray(plan?.["items"])
    ? plan["items"].map((item) => nonEmpty(item)).filter((item): item is string => item != null)
    : undefined;

  return {
    ok: true as const,
    event: {
      agent,
      externalSessionId: nonEmpty(raw["sessionId"]),
      eventType,
      task,
      status: nonEmpty(raw["status"]),
      confidence,
      ledgerTopic: nonEmpty(correlation?.["ledgerTopic"]),
      repo: nonEmpty(correlation?.["repo"]),
      branch: nonEmpty(correlation?.["branch"]),
      prUrl: nonEmpty(correlation?.["prUrl"]),
      commitSha: nonEmpty(correlation?.["commitSha"]),
      jiraKey: nonEmpty(correlation?.["jiraKey"]),
      planRepo: nonEmpty(plan?.["repo"]),
      planPath: nonEmpty(plan?.["path"]),
      planItems,
      evidence,
      payload,
      idempotencyKey: nonEmpty(raw["idempotencyKey"]),
      occurredAt
    }
  };
}

function formatAgentEventRow(row: AgentEventRow) {
  return {
    ...row,
    planItems: parseJson(row["planItemsJson"]),
    evidence: parseJson(row["evidenceJson"]),
    payload: parseJson(row["payloadJson"]),
    planItemsJson: undefined,
    evidenceJson: undefined,
    payloadJson: undefined
  };
}

function isAgentEventConfidence(value: string | undefined): value is AgentEventConfidence {
  return value != null && (AGENT_EVENT_CONFIDENCES as readonly string[]).includes(value);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function getRequiredHeader(header: string | string[] | undefined) {
  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
}

function extractRepoName(payload: unknown): string | undefined {
  if (payload == null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const repo = p["repository"];
  if (repo == null || typeof repo !== "object") return undefined;
  const r = repo as Record<string, unknown>;
  return typeof r["full_name"] === "string" ? r["full_name"] : undefined;
}

function extractJiraEvent(payload: unknown): string | undefined {
  if (payload == null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  return str(p["webhookEvent"]);
}

function extractJiraTimestamp(payload: unknown): number | undefined {
  if (payload == null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  return typeof p["timestamp"] === "number" ? p["timestamp"] : undefined;
}

function str(v: unknown): string | undefined {
  return v != null ? String(v) : undefined;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, config } = await buildServer();

  await app.listen({
    host: config.api.host,
    port: config.api.port
  });
}
