import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBlocker,
  recordAgentEvent,
  upsertWorkItem,
  getWorkItemByExternalId,
  getLinksFrom,
  type OpenedDatabase
} from "@meta-agent/storage";
import { createTestDatabase } from "@meta-agent/storage/test-utils";
import {
  reconcileLedger,
  reconcileJiraLedger,
  reconcileAgentEvidence,
  persistCatalogLinks,
  buildStatusDigest,
  deliverStatusDigest
} from "./reconcile.js";
import type { JiraIssue } from "@meta-agent/jira-adapter";
import type { GitHubIssue, GitHubItem, GitHubPr, GitHubWorkflowRun } from "./index.js";
import type { HermesClient, HermesMessage } from "@meta-agent/hermes";

let db: OpenedDatabase;

beforeEach(() => {
  db = createTestDatabase("meta-agent-reconcile-");
});

afterEach(() => {
  db.sqlite.close();
});

function pr(overrides: Partial<GitHubPr> = {}): GitHubPr {
  return {
    kind: "pull_request",
    number: 1,
    title: "Add feature",
    body: null,
    htmlUrl: "https://github.com/o/r/pull/1",
    state: "open",
    draft: false,
    user: { login: "alice" },
    repo: "o/r",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    labels: [],
    ...overrides
  };
}

function captureHermes(): { client: HermesClient; messages: HermesMessage[] } {
  const messages: HermesMessage[] = [];
  return {
    messages,
    client: {
      async send(message: HermesMessage) {
        messages.push(message);
        return true;
      }
    }
  };
}

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    kind: "issue",
    number: 2,
    title: "A bug",
    body: null,
    htmlUrl: "https://github.com/o/r/issues/2",
    state: "open",
    user: { login: "alice" },
    repo: "o/r",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    labels: [],
    ...overrides
  };
}

describe("reconcileLedger", () => {
  it("upserts PRs and issues into the ledger with correct kind", async () => {
    const items: GitHubItem[] = [
      pr({ number: 1, htmlUrl: "https://github.com/o/r/pull/1" }),
      issue()
    ];

    const result = await reconcileLedger({ db, items });

    expect(result.upserted).toBe(2);
    expect(result.created).toBe(2);

    const prItem = getWorkItemByExternalId(db, "github", "pr:o/r#1");
    const issueItem = getWorkItemByExternalId(db, "github", "issue:o/r#2");
    expect(prItem).toBeTruthy();
    expect(issueItem).toBeTruthy();
  });

  it("is idempotent: a second scan updates rather than duplicates", async () => {
    const items = [pr()];
    await reconcileLedger({ db, items });
    const second = await reconcileLedger({ db, items });

    expect(second.upserted).toBe(1);
    expect(second.created).toBe(0);
  });

  it("delivers PR opened and merged notifications for new state transitions", async () => {
    const hermes = captureHermes();

    await reconcileLedger({
      db,
      items: [pr({ number: 7, htmlUrl: "https://github.com/o/r/pull/7" })],
      hermes: hermes.client
    });
    await reconcileLedger({
      db,
      items: [
        pr({
          number: 7,
          htmlUrl: "https://github.com/o/r/pull/7",
          state: "closed",
          mergedAt: "2026-06-17T10:00:00Z"
        })
      ],
      hermes: hermes.client
    });

    expect(hermes.messages.map((message) => message.category)).toEqual(["pr_opened", "pr_merged"]);
    expect(hermes.messages[0].dedupKey).toBe("pr_opened:o/r#7");
    expect(hermes.messages[1].dedupKey).toBe("pr_merged:o/r#7");
  });

  it("detects a milestone when a plan step completes between scans", async () => {
    const incomplete = pr({ body: "## Implementation Plan\n\n- [ ] Ship it\n" });
    const first = await reconcileLedger({ db, items: [incomplete] });
    expect(first.milestones).toBe(0);

    const complete = pr({ body: "## Implementation Plan\n\n- [x] Ship it\n" });
    const second = await reconcileLedger({ db, items: [complete] });
    expect(second.milestones).toBe(1);
  });
});

describe("reconcileJiraLedger", () => {
  it("upserts Jira issues into the ledger", () => {
    const issues: JiraIssue[] = [
      {
        key: "PROJ-42",
        id: "10042",
        self: "https://jira.example.com/rest/api/2/issue/PROJ-42",
        fields: {
          summary: "Backend task",
          status: { name: "In Progress" },
          issuetype: { name: "Story" },
          updated: new Date().toISOString()
        }
      }
    ];

    const result = reconcileJiraLedger({ db, issues });
    expect(result.upserted).toBe(1);
    expect(result.created).toBe(1);

    const item = getWorkItemByExternalId(db, "jira", "issue:PROJ-42");
    expect(item).toBeTruthy();
  });
});

describe("reconcileAgentEvidence", () => {
  it("marks PR-opened agent events as system observed when GitHub still sees the PR", () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    recordAgentEvent(db, {
      agent: "hermes",
      eventType: "pr_opened",
      task: "Transparent status contract",
      confidence: "agent_observed",
      prUrl: "https://github.com/o/r/pull/77",
      payload: {},
      occurredAt: recent
    });

    const result = reconcileAgentEvidence({
      db,
      items: [pr({ number: 77, htmlUrl: "https://github.com/o/r/pull/77", state: "open" })],
      runs: []
    });

    const event = db.sqlite.prepare("SELECT confidence FROM agent_events").get() as {
      confidence: string;
    };
    expect(result).toEqual({ verified: 0, observed: 1 });
    expect(event.confidence).toBe("system_observed");
  });

  it("does not reprocess already observed PR-opened events", () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    recordAgentEvent(db, {
      agent: "hermes",
      eventType: "pr_opened",
      task: "Transparent status contract",
      confidence: "system_observed",
      prUrl: "https://github.com/o/r/pull/77",
      payload: {},
      occurredAt: recent
    });

    const result = reconcileAgentEvidence({
      db,
      items: [pr({ number: 77, htmlUrl: "https://github.com/o/r/pull/77", state: "open" })],
      runs: []
    });

    expect(result).toEqual({ verified: 0, observed: 0 });
  });

  it("verifies completion claims only when deterministic GitHub evidence confirms them", () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    recordAgentEvent(db, {
      agent: "hermes",
      eventType: "task_completed_claimed",
      task: "Transparent status contract",
      confidence: "agent_observed",
      prUrl: "https://github.com/o/r/pull/78",
      payload: {},
      occurredAt: recent
    });

    const result = reconcileAgentEvidence({
      db,
      items: [
        pr({
          number: 78,
          htmlUrl: "https://github.com/o/r/pull/78",
          state: "closed",
          mergedAt: "2026-06-18T09:00:00.000Z"
        })
      ],
      runs: []
    });

    const event = db.sqlite
      .prepare("SELECT confidence, evidence_json AS evidenceJson FROM agent_events")
      .get() as { confidence: string; evidenceJson: string };
    expect(result).toEqual({ verified: 1, observed: 0 });
    expect(event.confidence).toBe("verified");
    expect(event.evidenceJson).toContain("github_item");
  });

  it("verifies test-pass events from matching green workflow runs", () => {
    const signalTime = new Date(Date.now() - 60 * 60 * 1000);
    const runTime = new Date(signalTime.getTime() + 30 * 60 * 1000);
    recordAgentEvent(db, {
      agent: "hermes",
      eventType: "tests_passed",
      task: "Transparent status contract",
      confidence: "agent_observed",
      repo: "o/r",
      branch: "feature/transparency",
      payload: {},
      occurredAt: signalTime
    });
    const runs: GitHubWorkflowRun[] = [
      {
        repo: "o/r",
        name: "Build and push Docker image",
        branch: "feature/transparency",
        conclusion: "success",
        status: "completed",
        htmlUrl: "https://github.com/o/r/actions/runs/1",
        updatedAt: runTime.toISOString()
      }
    ];

    const result = reconcileAgentEvidence({ db, items: [], runs });

    const event = db.sqlite.prepare("SELECT confidence FROM agent_events").get() as {
      confidence: string;
    };
    expect(result).toEqual({ verified: 1, observed: 0 });
    expect(event.confidence).toBe("verified");
  });

  it("verifies post-hoc test-pass events against recent green workflow runs", () => {
    const runTime = new Date(Date.now() - 90 * 60 * 1000);
    const signalTime = new Date(runTime.getTime() + 30 * 60 * 1000);
    recordAgentEvent(db, {
      agent: "hermes",
      eventType: "tests_passed",
      task: "Transparent status contract",
      confidence: "agent_observed",
      repo: "o/r",
      branch: "feature/transparency",
      payload: {},
      occurredAt: signalTime
    });
    const runs: GitHubWorkflowRun[] = [
      {
        repo: "o/r",
        name: "Build and push Docker image",
        branch: "feature/transparency",
        conclusion: "success",
        status: "completed",
        htmlUrl: "https://github.com/o/r/actions/runs/1",
        updatedAt: runTime.toISOString()
      }
    ];

    const result = reconcileAgentEvidence({ db, items: [], runs });

    const event = db.sqlite.prepare("SELECT confidence FROM agent_events").get() as {
      confidence: string;
    };
    expect(result).toEqual({ verified: 1, observed: 0 });
    expect(event.confidence).toBe("verified");
  });

  it("does not verify workflow-backed signals without repo and branch correlation", () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    recordAgentEvent(db, {
      agent: "hermes",
      eventType: "tests_passed",
      task: "Ambiguous test pass",
      confidence: "agent_observed",
      payload: {},
      occurredAt: recent
    });
    const runs: GitHubWorkflowRun[] = [
      {
        repo: "o/r",
        name: "Build and push Docker image",
        branch: "feature/transparency",
        conclusion: "success",
        status: "completed",
        htmlUrl: "https://github.com/o/r/actions/runs/1",
        updatedAt: new Date().toISOString()
      }
    ];

    const result = reconcileAgentEvidence({ db, items: [], runs });

    const event = db.sqlite.prepare("SELECT confidence FROM agent_events").get() as {
      confidence: string;
    };
    expect(result).toEqual({ verified: 0, observed: 0 });
    expect(event.confidence).toBe("agent_observed");
  });
});

describe("persistCatalogLinks", () => {
  it("stores model-assisted Jira matches as proposed links only", () => {
    const written = persistCatalogLinks(db, {
      entries: [
        {
          kind: "pr",
          repo: "o/r",
          number: 42,
          title: "Add feature",
          author: undefined,
          url: "https://github.com/o/r/pull/42",
          updatedAt: new Date().toISOString(),
          labels: [],
          matchedJira: [{ key: "PROJ-42", confidence: 0.82, reason: "same feature wording" }]
        }
      ],
      totalOpenPrs: 1,
      totalOpenIssues: 0,
      matchedCount: 1,
      unmatchedCount: 0,
      jiraIssuesScanned: 1
    });

    const links = getLinksFrom(db, "pr:o/r#42");

    expect(written).toBe(1);
    expect(links).toHaveLength(1);
    expect(links[0]!.origin).toBe("llm_proposed");
    expect(links[0]!.relation).toBe("proposes");
    expect(links[0]!.confidence).toBe(0.82);
  });

  it("counts only newly inserted proposed links", () => {
    const catalog = {
      entries: [
        {
          kind: "pr" as const,
          repo: "o/r",
          number: 42,
          title: "Add feature",
          author: undefined,
          url: "https://github.com/o/r/pull/42",
          updatedAt: new Date().toISOString(),
          labels: [],
          matchedJira: [{ key: "PROJ-42", confidence: 0.82, reason: "same feature wording" }]
        }
      ],
      totalOpenPrs: 1,
      totalOpenIssues: 0,
      matchedCount: 1,
      unmatchedCount: 0,
      jiraIssuesScanned: 1
    };

    expect(persistCatalogLinks(db, catalog)).toBe(1);
    expect(persistCatalogLinks(db, catalog)).toBe(0);
  });
});

describe("buildStatusDigest", () => {
  it("summarizes active work, blockers (linked + unlinked), and stale items", async () => {
    // One fresh open PR (active work).
    await reconcileLedger({
      db,
      items: [pr({ number: 10, htmlUrl: "https://github.com/o/r/pull/10", title: "Fresh PR" })]
    });
    const linked = getWorkItemByExternalId(db, "github", "pr:o/r#10");

    // A stale open item (no activity for 5 days).
    const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    upsertWorkItem(db, {
      source: "github",
      externalId: "issue:o/r#99",
      kind: "issue",
      title: "Stale issue",
      status: "open",
      externalUrl: "https://github.com/o/r/issues/99",
      updatedAt: oldDate
    });

    // A blocker linked to the PR, and one with no linked work item.
    createBlocker(db, {
      workItemId: linked!.id,
      type: "ci_failure",
      title: "CI failed on o/r (main)",
      occurredAt: new Date()
    });
    createBlocker(db, { type: "ci_failure", title: "Orphan failure", occurredAt: new Date() });

    const msg = buildStatusDigest(db, { staleDays: 2 });

    expect(msg.category).toBe("daily_digest");
    expect(msg.body).toContain("*Blocked:*");
    expect(msg.body).toContain("CI failed on o/r (main)");
    expect(msg.body).toContain("Fresh PR");
    expect(msg.body).toContain("(unlinked)");
    expect(msg.body).toContain("*Needs attention:*");
    expect(msg.body).toContain("Stale issue");
    expect(msg.body).toContain("Active work:");
  });

  it("keeps plan documents out of the generic stale attention list", () => {
    upsertWorkItem(db, {
      source: "github",
      externalId: "plan:o/r:docs/example-plan.md",
      kind: "plan",
      title: "Example implementation plan",
      status: "open",
      body: "Source: docs/example-plan.md\nStatus rows: 0\nChecklist: 0/0\nReferenced PRs: none",
      externalUrl: "https://github.com/o/r/blob/main/docs/example-plan.md",
      updatedAt: new Date("1970-01-01T00:00:00.000Z")
    });

    const msg = buildStatusDigest(db, {
      staleDays: 2,
      timestamp: new Date("2026-07-02T10:00:00.000Z")
    });

    expect(msg.body).toContain(
      "*Plan-driven work:*\n- <https://github.com/o/r/blob/main/docs/example-plan.md|Example implementation plan>"
    );
    expect(msg.body).toContain("*Needs attention:*\n- none");
    expect(msg.body).not.toContain("Example implementation plan> — no activity for");
  });

  it("renders recent agent evidence as unverified context", () => {
    recordAgentEvent(db, {
      agent: "hermes",
      externalSessionId: "slack:thread-1",
      eventType: "runtime_verified",
      task: "CNPG ApplicationSet runtime smoke",
      status: "claimed_complete",
      confidence: "agent_observed",
      ledgerTopic: "cnpg-database-gitops",
      repo: "example-org/example-service",
      branch: "platform-cnpg-database-gitops",
      prUrl: "https://github.com/example-org/example-service/pull/448",
      payload: { evidence: "argocd app observed healthy" },
      occurredAt: new Date()
    });

    const msg = buildStatusDigest(db);

    expect(msg.body).toContain("*Agent-reported evidence awaiting verification:*");
    expect(msg.body).toContain("Runtime observed healthy");
    expect(msg.body).toContain("CNPG ApplicationSet runtime smoke");
    expect(msg.body).toContain("agent_observed");
    expect(msg.body).toContain("cnpg-database-gitops");
  });

  it("does not list already reconciled agent evidence as awaiting verification", () => {
    const now = Date.now();
    recordAgentEvent(db, {
      agent: "hermes",
      eventType: "runtime_verified",
      task: "Unverified runtime smoke",
      confidence: "agent_observed",
      payload: {},
      occurredAt: new Date(now - 60 * 60 * 1000)
    });
    recordAgentEvent(db, {
      agent: "hermes",
      eventType: "pr_opened",
      task: "Already observed PR",
      confidence: "system_observed",
      payload: {},
      occurredAt: new Date(now - 59 * 60 * 1000)
    });
    recordAgentEvent(db, {
      agent: "hermes",
      eventType: "tests_passed",
      task: "Already verified tests",
      confidence: "verified",
      payload: {},
      occurredAt: new Date(now - 58 * 60 * 1000)
    });

    const msg = buildStatusDigest(db);

    expect(msg.body).toContain("Unverified runtime smoke");
    expect(msg.body).not.toContain("Already observed PR");
    expect(msg.body).not.toContain("Already verified tests");
  });

  it("renders empty sections gracefully", () => {
    const msg = buildStatusDigest(db);
    expect(msg.body).toContain("Active work: 0 open across 0 repo(s)");
    expect(msg.body).toContain("*Milestones reached:*\n- none");
    expect(msg.body).toContain("*Agent-reported evidence awaiting verification:*\n- none");
  });

  it("uses an hour-specific digest title so hourly updates are not deduplicated", () => {
    const msg = buildStatusDigest(db, { timestamp: new Date("2026-06-17T14:39:00Z") });

    expect(msg.title).toBe("Status update — 2026-06-17 14:00 UTC");
    expect(msg.dedupKey).toBe("daily_digest:2026-06-17T14");
  });

  it("returns whether the status digest was actually delivered", async () => {
    const hermes = captureHermes();

    await expect(
      deliverStatusDigest(hermes.client, db, { timestamp: new Date("2026-06-17T14:39:00Z") })
    ).resolves.toBe(true);
    expect(hermes.messages).toHaveLength(1);
    expect(hermes.messages[0].dedupKey).toBe("daily_digest:2026-06-17T14");
  });
});
