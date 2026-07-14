import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getActiveBlockers, getWorkItem, type OpenedDatabase } from "@meta-agent/storage";
import type { HermesClient, HermesMessage } from "@meta-agent/hermes";
import { normalizeWebhookEvent } from "@meta-agent/github-adapter";
import { createTestDatabase } from "@meta-agent/storage/test-utils";
import {
  buildStatusDigest,
  parsePlanDocument,
  reconcilePlanDocuments,
  reconcileLedger,
  reconcileWorkflowBlockers,
  type GitHubPr,
  type PlanDocument
} from "./index.js";

let db: OpenedDatabase;

beforeEach(() => {
  db = createTestDatabase("meta-agent-plan-docs-");
});

afterEach(() => {
  db.sqlite.close();
});

function plan(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    repo: "example-org/example-service",
    path: "docs/platform-cost-transparency-plan.md",
    title: "Platform Cost Transparency Plan",
    body: `# Platform Cost Transparency Plan

## Current Status

| Area | Status | Notes |
|---|---|---|
| AKS tier / AKS Cost Analysis | Pilot | dev1 AKS is on Standard tier. |
| Cost evaluation surface | In progress | Evaluate portal billing API. |
| Cost dashboards | Deferred | Build later. |

## Success Criteria

- [x] Cost is visible by cluster.
- [ ] Weekly cost report exists.

Related work: #1, #302, and https://github.com/example-org/example-service/pull/415
`,
    htmlUrl:
      "https://github.com/example-org/example-service/blob/main/docs/platform-cost-transparency-plan.md",
    updatedAt: "2026-06-12T12:00:00Z",
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

function pr(overrides: Partial<GitHubPr> = {}): GitHubPr {
  return {
    kind: "pull_request",
    number: 415,
    title: "docs(cost): evaluate platform portal showback path",
    body: "Updates docs/platform-cost-transparency-plan.md",
    htmlUrl: "https://github.com/example-org/example-service/pull/415",
    state: "closed",
    mergedAt: "2026-06-12T10:43:09Z",
    draft: false,
    user: { login: "example-user" },
    repo: "example-org/example-service",
    createdAt: "2026-06-12T09:00:00Z",
    updatedAt: "2026-06-12T10:43:09Z",
    labels: [],
    ...overrides
  };
}

describe("parsePlanDocument", () => {
  it("extracts status rows, checklist counts, and PR references from a plan doc", () => {
    const parsed = parsePlanDocument(plan());

    expect(parsed.statusRows).toEqual([
      {
        item: "AKS tier / AKS Cost Analysis",
        status: "Pilot",
        notes: "dev1 AKS is on Standard tier."
      },
      {
        item: "Cost evaluation surface",
        status: "In progress",
        notes: "Evaluate portal billing API."
      },
      { item: "Cost dashboards", status: "Deferred", notes: "Build later." }
    ]);
    expect(parsed.checklist.total).toBe(2);
    expect(parsed.checklist.completed).toBe(1);
    expect(parsed.prNumbers).toEqual([1, 302, 415]);
    expect(parsed.summary).toContain("AKS tier / AKS Cost Analysis — Pilot");
  });

  it("treats implemented, verified, and superseded rows as closed truth states", () => {
    const parsed = parsePlanDocument(
      plan({
        body: `# Database GitOps Plan

| Task | Status | Notes |
|---|---|---|
| CNPG ApplicationSet | Implemented | Replaced by static platform database ApplicationSet. |
| Database GitOps | Runtime verified | ArgoCD app is healthy. |
| Old failing workflow | Superseded | New workflow is green. |
`
      })
    );

    expect(parsed.status).toBe("closed");
  });
});

describe("reconcilePlanDocuments", () => {
  it("upserts plan documents as active plan work items and syncs checklist milestones", async () => {
    const result = await reconcilePlanDocuments({ db, documents: [plan()] });

    expect(result.upserted).toBe(1);
    expect(result.created).toBe(1);

    const item = getWorkItem(
      db,
      "github",
      "plan:example-org/example-service:docs/platform-cost-transparency-plan.md"
    );
    expect(item).toBeTruthy();
    expect(item?.kind).toBe("plan");
    expect(item?.status).toBe("open");
    expect(item?.title).toBe("Platform Cost Transparency Plan");
    expect(item?.body).toContain("Status rows: 3");

    const digest = buildStatusDigest(db);
    expect(digest.body).toContain("*Plan-driven work:*");
    expect(digest.body).toContain("Platform Cost Transparency Plan");
    expect(digest.body).toContain("1/2 checklist items complete");
    expect(digest.body).toContain("AKS tier / AKS Cost Analysis: Pilot");
    expect(digest.body).not.toContain("CNPG ApplicationSet");
  });

  it("delivers a plan_updated notification when an existing plan document changes", async () => {
    const hermes = captureHermes();

    await reconcilePlanDocuments({ db, documents: [plan()], hermes: hermes.client });
    await reconcilePlanDocuments({
      db,
      documents: [
        plan({
          updatedAt: "2026-06-12T13:00:00Z",
          body: plan().body.replace(
            "Weekly cost report exists.",
            "Weekly cost report exists and is linked from the portal."
          )
        })
      ],
      hermes: hermes.client
    });

    expect(hermes.messages.map((message) => message.category)).toEqual(["plan_updated"]);
    expect(hermes.messages[0].title).toContain("Platform Cost Transparency Plan");
    expect(hermes.messages[0].dedupKey).toBe(
      "plan_updated:plan:example-org/example-service:docs/platform-cost-transparency-plan.md:2026-06-12T13:00:00Z"
    );
  });

  it("omits closed plan documents from the active plan-driven work section", async () => {
    await reconcilePlanDocuments({
      db,
      documents: [
        plan({
          path: "docs/cnpg-database-gitops-plan.md",
          title: "CNPG Database GitOps Plan",
          body: `# CNPG Database GitOps Plan

| Task | Status | Notes |
|---|---|---|
| CNPG ApplicationSet | Implemented | Merged. |
| Database GitOps | Runtime verified | Green. |
`
        })
      ]
    });

    const digest = buildStatusDigest(db);
    expect(digest.body).toContain("*Plan-driven work:*\n- none");
    expect(digest.body).not.toContain("CNPG Database GitOps Plan");
  });
});

describe("recent merged PR reconciliation", () => {
  it("keeps merged PRs in the ledger and includes them as recent evidence in the digest", async () => {
    const result = await reconcileLedger({ db, items: [pr()] });

    expect(result.upserted).toBe(1);
    const item = getWorkItem(db, "github", "pr:example-org/example-service#415");
    expect(item?.status).toBe("merged");

    const digest = buildStatusDigest(db);
    expect(digest.body).toContain("*Recently completed PRs:*");
    expect(digest.body).toContain("docs(cost): evaluate platform portal showback path");
  });
});

describe("workflow blocker reconciliation", () => {
  it("resolves stale CI blockers when a newer workflow run on the same branch is green", async () => {
    await normalizeWebhookEvent(db, "workflow_run", {
      action: "completed",
      repository: { full_name: "example-org/example-service" },
      workflow_run: {
        name: "OpenTofu CD",
        conclusion: "failure",
        head_branch: "main",
        html_url: "https://github.com/example-org/example-service/actions/runs/1",
        pull_requests: []
      }
    });
    expect(getActiveBlockers(db)).toHaveLength(1);

    const result = reconcileWorkflowBlockers({
      db,
      runs: [
        {
          repo: "example-org/example-service",
          name: "OpenTofu CD",
          branch: "main",
          conclusion: "success",
          status: "completed",
          htmlUrl: "https://github.com/example-org/example-service/actions/runs/2",
          updatedAt: new Date(Date.now() + 1000).toISOString()
        }
      ]
    });

    expect(result.resolved).toBe(1);
    expect(getActiveBlockers(db)).toHaveLength(0);
  });
});
