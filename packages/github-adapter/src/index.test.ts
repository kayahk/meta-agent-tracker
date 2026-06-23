import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OpenedDatabase } from "@meta-agent/storage";
import { createTestDatabase } from "@meta-agent/storage/test-utils";
import { normalizeWebhookEvent } from "./index.js";

let db: OpenedDatabase;

beforeEach(() => {
  db = createTestDatabase("meta-agent-gh-adapter-");
  // Disable FK enforcement for testing (adapter uses workItemId=0 as placeholder)
  db.sqlite.pragma("foreign_keys = OFF");
});

afterEach(() => {
  db.sqlite.close();
});

describe("normalizeWebhookEvent", () => {
  it("returns empty effects for unknown events", async () => {
    const result = await normalizeWebhookEvent(db, "star", {});
    expect(result.event).toBe("star");
    expect(result.effects).toHaveLength(0);
  });

  it("handles null payload gracefully", async () => {
    const result = await normalizeWebhookEvent(db, "issues", null);
    expect(result.effects).toHaveLength(0);
  });

  it("handles issues event and creates work item", async () => {
    const result = await normalizeWebhookEvent(db, "issues", {
      action: "opened",
      issue: {
        number: 42,
        title: "Bug in auth",
        body: "Fix login flow\n\n## Implementation Plan\n\n- [ ] Write tests\n- [x] Implement fix",
        html_url: "https://github.com/owner/repo/issues/42",
        updated_at: "2025-01-01T00:00:00Z",
        state: "open",
        assignee: { login: "alice" }
      },
      repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" }
    });

    expect(result.effects).toHaveLength(2); // work_item + plan_snapshot
    expect(result.effects[0].type).toBe("work_item_upserted");
    expect(result.effects[1].type).toBe("plan_snapshot_created");
  });

  it("handles pull_request event and creates work item", async () => {
    const result = await normalizeWebhookEvent(db, "pull_request", {
      action: "opened",
      pull_request: {
        number: 10,
        title: "Fix auth",
        body: "",
        html_url: "https://github.com/owner/repo/pull/10",
        updated_at: "2025-01-01T00:00:00Z",
        state: "open",
        user: { login: "bob" }
      },
      repository: { full_name: "owner/repo" }
    });

    expect(result.effects).toHaveLength(1);
    expect(result.effects[0].type).toBe("work_item_upserted");
  });

  it("delivers PR opened and merged notifications via Hermes", async () => {
    const hermes = {
      send: vi.fn().mockResolvedValue(true)
    };

    const opened = await normalizeWebhookEvent(
      db,
      "pull_request",
      {
        action: "opened",
        pull_request: {
          number: 10,
          title: "Fix auth",
          body: "",
          html_url: "https://github.com/owner/repo/pull/10",
          updated_at: "2025-01-01T00:00:00Z",
          state: "open",
          user: { login: "bob" }
        },
        repository: { full_name: "owner/repo" }
      },
      hermes
    );

    const merged = await normalizeWebhookEvent(
      db,
      "pull_request",
      {
        action: "closed",
        pull_request: {
          number: 10,
          title: "Fix auth",
          body: "",
          html_url: "https://github.com/owner/repo/pull/10",
          updated_at: "2025-01-01T01:00:00Z",
          state: "closed",
          merged: true,
          user: { login: "bob" }
        },
        repository: { full_name: "owner/repo" }
      },
      hermes
    );

    expect(hermes.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ category: "pr_opened", dedupKey: "pr_opened:owner/repo#10" })
    );
    expect(hermes.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ category: "pr_merged", dedupKey: "pr_merged:owner/repo#10" })
    );
    expect(opened.effects.map((effect) => effect.type)).toContain("feed_delivered");
    expect(merged.effects.map((effect) => effect.type)).toContain("feed_delivered");
  });

  it("retries PR notifications after a failed Hermes delivery", async () => {
    const hermes = {
      send: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    };
    const payload = {
      action: "opened",
      pull_request: {
        number: 12,
        title: "Retry auth notification",
        body: "",
        html_url: "https://github.com/owner/repo/pull/12",
        updated_at: "2025-01-01T00:00:00Z",
        state: "open",
        user: { login: "bob" }
      },
      repository: { full_name: "owner/repo" }
    };

    const first = await normalizeWebhookEvent(db, "pull_request", payload, hermes);
    const second = await normalizeWebhookEvent(db, "pull_request", payload, hermes);

    expect(hermes.send).toHaveBeenCalledTimes(2);
    expect(first.effects.find((effect) => effect.type === "feed_delivered")?.delivered).toBe(false);
    expect(second.effects.find((effect) => effect.type === "feed_delivered")?.delivered).toBe(true);
  });

  it("handles pull_request with plan body", async () => {
    const result = await normalizeWebhookEvent(db, "pull_request", {
      action: "opened",
      pull_request: {
        number: 11,
        title: "Feature PR",
        body: "Implementation plan:\n\n## Implementation Plan\n\n- [ ] Backend\n- [ ] Frontend\n- [ ] Tests",
        html_url: "https://github.com/owner/repo/pull/11",
        updated_at: "2025-01-01T00:00:00Z",
        state: "open",
        user: { login: "bob" }
      },
      repository: { full_name: "owner/repo" }
    });

    expect(result.effects).toHaveLength(2);
    expect(result.effects[1].type).toBe("plan_snapshot_created");
  });

  it("handles merged PR with correct status", async () => {
    const result = await normalizeWebhookEvent(db, "pull_request", {
      action: "closed",
      pull_request: {
        number: 10,
        title: "Fix auth",
        body: "",
        html_url: "https://github.com/owner/repo/pull/10",
        updated_at: "2025-01-01T00:00:00Z",
        state: "closed",
        merged: true,
        user: { login: "bob" }
      },
      repository: { full_name: "owner/repo" }
    });

    expect(result.effects[0].type).toBe("work_item_upserted");

    const rows = db.sqlite
      .prepare("SELECT status FROM work_items WHERE external_id = ?")
      .all("pr:owner/repo#10") as Array<{ status: string }>;

    expect(rows[0].status).toBe("merged");
  });

  it("delivers review_needed when PR review requests changes", async () => {
    const hermes = {
      send: vi.fn().mockResolvedValue(true)
    };

    const result = await normalizeWebhookEvent(
      db,
      "pull_request_review",
      {
        action: "submitted",
        pull_request: {
          number: 10,
          title: "Fix auth",
          body: "PROJ-42",
          html_url: "https://github.com/owner/repo/pull/10",
          updated_at: "2025-01-01T00:00:00Z",
          state: "open",
          user: { login: "bob" }
        },
        review: {
          id: 9001,
          state: "changes_requested",
          submitted_at: "2025-01-01T02:00:00Z",
          html_url: "https://github.com/owner/repo/pull/10#pullrequestreview-9001",
          user: { login: "reviewer" }
        },
        repository: { full_name: "owner/repo" }
      },
      hermes
    );

    expect(result.effects.map((effect) => effect.type)).toEqual([
      "work_item_upserted",
      "feed_delivered"
    ]);
    expect(hermes.send).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "review_needed",
        dedupKey: "review_needed:owner/repo#10:9001",
        sourceUrl: "https://github.com/owner/repo/pull/10#pullrequestreview-9001"
      })
    );
  });

  it("does not deliver review_needed for approved PR reviews", async () => {
    const hermes = {
      send: vi.fn().mockResolvedValue(true)
    };

    const result = await normalizeWebhookEvent(
      db,
      "pull_request_review",
      {
        action: "submitted",
        pull_request: {
          number: 10,
          title: "Fix auth",
          body: "",
          html_url: "https://github.com/owner/repo/pull/10",
          updated_at: "2025-01-01T00:00:00Z",
          state: "open",
          user: { login: "bob" }
        },
        review: {
          id: 9002,
          state: "approved",
          submitted_at: "2025-01-01T02:00:00Z",
          user: { login: "reviewer" }
        },
        repository: { full_name: "owner/repo" }
      },
      hermes
    );

    expect(result.effects.map((effect) => effect.type)).toEqual(["work_item_upserted"]);
    expect(hermes.send).not.toHaveBeenCalled();
  });

  it("keeps merged status for review events on merged PRs", async () => {
    const result = await normalizeWebhookEvent(db, "pull_request_review", {
      action: "submitted",
      pull_request: {
        number: 10,
        title: "Fix auth",
        body: "",
        html_url: "https://github.com/owner/repo/pull/10",
        updated_at: "2025-01-01T00:00:00Z",
        state: "closed",
        merged: true,
        user: { login: "bob" }
      },
      review: {
        id: 9003,
        state: "commented",
        submitted_at: "2025-01-01T02:00:00Z",
        user: { login: "reviewer" }
      },
      repository: { full_name: "owner/repo" }
    });

    expect(result.effects.map((effect) => effect.type)).toEqual(["work_item_upserted"]);

    const rows = db.sqlite
      .prepare("SELECT status FROM work_items WHERE external_id = ?")
      .all("pr:owner/repo#10") as Array<{ status: string }>;

    expect(rows[0].status).toBe("merged");
  });

  it("does not record feed effects for change-request reviews without Hermes", async () => {
    const result = await normalizeWebhookEvent(db, "pull_request_review", {
      action: "submitted",
      pull_request: {
        number: 10,
        title: "Fix auth",
        body: "",
        html_url: "https://github.com/owner/repo/pull/10",
        updated_at: "2025-01-01T00:00:00Z",
        state: "open",
        user: { login: "bob" }
      },
      review: {
        id: 9004,
        state: "changes_requested",
        submitted_at: "2025-01-01T02:00:00Z",
        user: { login: "reviewer" }
      },
      repository: { full_name: "owner/repo" }
    });

    expect(result.effects.map((effect) => effect.type)).toEqual(["work_item_upserted"]);
  });

  it("extracts Jira links from PR review metadata without heredoc indentation artifacts", async () => {
    await normalizeWebhookEvent(db, "pull_request_review", {
      action: "submitted",
      pull_request: {
        number: 10,
        title: "Fix auth",
        body: "PROJ-42",
        head: { ref: "feature/DEVOPS-9-review" },
        html_url: "https://github.com/owner/repo/pull/10",
        updated_at: "2025-01-01T00:00:00Z",
        state: "open",
        user: { login: "bob" }
      },
      review: {
        id: 9005,
        state: "commented",
        submitted_at: "2025-01-01T02:00:00Z",
        user: { login: "reviewer" }
      },
      repository: { full_name: "owner/repo" }
    });

    const links = db.sqlite
      .prepare(
        "SELECT to_external_id AS toExternalId FROM links WHERE from_external_id = ? ORDER BY to_external_id"
      )
      .all("pr:owner/repo#10") as Array<{ toExternalId: string }>;

    expect(links.map((link) => link.toExternalId)).toEqual(["issue:DEVOPS-9", "issue:PROJ-42"]);
  });

  it("handles workflow_run failure → creates blocker", async () => {
    const result = await normalizeWebhookEvent(db, "workflow_run", {
      action: "completed",
      workflow_run: {
        name: "CI Build",
        conclusion: "failure",
        head_branch: "main",
        html_url: "https://github.com/owner/repo/actions/runs/1"
      },
      repository: { full_name: "owner/repo" }
    });

    expect(result.effects).toHaveLength(1);
    expect(result.effects[0].type).toBe("blocker_created");
    expect(result.effects[0].detail).toContain("CI Build");
  });

  it("handles workflow_run success → resolves matching blockers", async () => {
    // First create a blocker using the adapter itself
    await normalizeWebhookEvent(db, "workflow_run", {
      action: "completed",
      workflow_run: {
        name: "CI Build",
        conclusion: "failure",
        head_branch: "main",
        html_url: "https://github.com/owner/repo/actions/1"
      },
      repository: { full_name: "owner/repo" }
    });

    const result = await normalizeWebhookEvent(db, "workflow_run", {
      action: "completed",
      workflow_run: {
        name: "CI Build",
        conclusion: "success",
        head_branch: "main"
      },
      repository: { full_name: "owner/repo" }
    });

    expect(result.effects).toHaveLength(1);
    expect(result.effects[0].type).toBe("blocker_resolved");
  });

  it("handles check_run failure → creates blocker", async () => {
    const result = await normalizeWebhookEvent(db, "check_run", {
      action: "completed",
      check_run: {
        name: "Lint",
        conclusion: "failure",
        html_url: "https://github.com/owner/repo/checks/1"
      },
      repository: { full_name: "owner/repo" }
    });

    expect(result.effects).toHaveLength(1);
    expect(result.effects[0].type).toBe("blocker_created");
  });

  it("delivers via Hermes when client is provided", async () => {
    const hermes = {
      send: vi.fn().mockResolvedValue(true)
    };

    await normalizeWebhookEvent(
      db,
      "issues",
      {
        action: "opened",
        issue: {
          number: 1,
          title: "New issue",
          body: "",
          html_url: "https://github.com/owner/repo/issues/1",
          updated_at: "2025-01-01T00:00:00Z",
          state: "open"
        },
        repository: { full_name: "owner/repo" }
      },
      hermes
    );

    // No delivery expected for plain issues (only milestones/blockers trigger delivery)
    expect(hermes.send).not.toHaveBeenCalled();
  });

  it("delivers blocker notification via Hermes", async () => {
    const hermes = {
      send: vi.fn().mockResolvedValue(true)
    };

    await normalizeWebhookEvent(
      db,
      "workflow_run",
      {
        action: "completed",
        workflow_run: {
          name: "CI",
          conclusion: "failure",
          head_branch: "feature",
          html_url: "https://github.com/owner/repo/actions/1"
        },
        repository: { full_name: "owner/repo" }
      },
      hermes
    );

    expect(hermes.send).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "blocker_detected",
        sourceUrl: "https://github.com/owner/repo/actions/1"
      })
    );
  });

  it("detects milestone when plan step is completed", async () => {
    const hermes = {
      send: vi.fn().mockResolvedValue(true)
    };

    // First update — incomplete step
    await normalizeWebhookEvent(
      db,
      "issues",
      {
        action: "opened",
        issue: {
          number: 1,
          title: "Task",
          body: "## Implementation Plan\n\n- [ ] Step one\n- [ ] Step two",
          html_url: "https://github.com/owner/repo/issues/1",
          updated_at: "2025-01-01T00:00:00Z",
          state: "open"
        },
        repository: { full_name: "owner/repo" }
      },
      hermes
    );

    expect(hermes.send).not.toHaveBeenCalled();

    // Second update — step one completed
    await normalizeWebhookEvent(
      db,
      "issues",
      {
        action: "edited",
        issue: {
          number: 1,
          title: "Task",
          body: "## Implementation Plan\n\n- [x] Step one\n- [ ] Step two",
          html_url: "https://github.com/owner/repo/issues/1",
          updated_at: "2025-01-01T01:00:00Z",
          state: "open"
        },
        repository: { full_name: "owner/repo" }
      },
      hermes
    );

    expect(hermes.send).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "milestone_reached",
        title: "Milestone: Step one"
      })
    );
  });
});
