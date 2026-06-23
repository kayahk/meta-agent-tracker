import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "./test-utils.js";
import {
  openDatabase,
  recordSourceChange,
  upsertWorkItem,
  createPlanSnapshot,
  getLatestPlanSnapshot,
  createMilestoneEvent,
  getUnemittedMilestones,
  markMilestoneEmitted,
  createBlocker,
  getActiveBlockers,
  resolveBlocker,
  recordEmittedMessage,
  getActiveWorkItems,
  getDashboardStats,
  getRecentMilestones,
  getWorkItemsWithBlockers,
  getStaleWorkItems,
  getActiveBlockersWithItems,
  getLinksTo,
  recordAgentEvent,
  getRecentAgentEvidenceSignals,
  upsertLink,
  type OpenedDatabase
} from "./index.js";

let db: OpenedDatabase;

beforeEach(() => {
  db = createTestDatabase("meta-agent-storage-");
});

afterEach(() => {
  db.sqlite.close();
});

describe("openDatabase", () => {
  it("creates directory and opens database with WAL mode", () => {
    expect(db.path).toBeDefined();
    const result = db.sqlite.pragma("journal_mode");
    expect(Array.isArray(result) ? result[0]?.journal_mode : result?.journal_mode).toBe("wal");
  });
});

describe("recordSourceChange", () => {
  it("records a source change", () => {
    recordSourceChange(db, {
      source: "github",
      externalId: "pr:owner/repo#1",
      changeType: "opened",
      idempotencyKey: "github:pr:owner/repo#1:opened",
      occurredAt: new Date("2025-01-01"),
      payloadJson: "{}"
    });

    const rows = db.sqlite.prepare("SELECT * FROM source_changes").all() as Array<{
      source: string;
      external_id: string;
      change_type: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("github");
    expect(rows[0].external_id).toBe("pr:owner/repo#1");
  });

  it("is idempotent — duplicate idempotencyKey does not create a second row", () => {
    recordSourceChange(db, {
      source: "github",
      externalId: "pr:owner/repo#1",
      changeType: "opened",
      idempotencyKey: "github:pr:owner/repo#1:opened",
      occurredAt: new Date("2025-01-01"),
      payloadJson: "{}"
    });

    recordSourceChange(db, {
      source: "github",
      externalId: "pr:owner/repo#1",
      changeType: "opened",
      idempotencyKey: "github:pr:owner/repo#1:opened",
      occurredAt: new Date("2025-01-02"),
      payloadJson: '{"v":2}'
    });

    const count = db.sqlite.prepare("SELECT COUNT(*) as cnt FROM source_changes").get() as {
      cnt: number;
    };

    expect(count.cnt).toBe(1);
  });
});

describe("upsertWorkItem", () => {
  it("creates a new work item and returns created: true", () => {
    const result = upsertWorkItem(db, {
      source: "github",
      externalId: "pr:owner/repo#42",
      kind: "pull_request",
      title: "Fix bug",
      status: "open",
      owner: "alice",
      externalUrl: "https://github.com/owner/repo/pull/42",
      updatedAt: new Date("2025-01-01")
    });

    expect(result.created).toBe(true);
    expect(result.id).toBeDefined();
  });

  it("updates an existing work item and returns created: false", () => {
    const first = upsertWorkItem(db, {
      source: "github",
      externalId: "pr:owner/repo#42",
      kind: "pull_request",
      title: "Fix bug",
      status: "open",
      owner: "alice",
      externalUrl: "https://github.com/owner/repo/pull/42",
      updatedAt: new Date("2025-01-01")
    });

    const second = upsertWorkItem(db, {
      source: "github",
      externalId: "pr:owner/repo#42",
      kind: "pull_request",
      title: "Fix bug (updated)",
      status: "open",
      owner: "bob",
      externalUrl: "https://github.com/owner/repo/pull/42",
      updatedAt: new Date("2025-01-02")
    });

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const row = db.sqlite.prepare("SELECT * FROM work_items WHERE id = ?").get(second.id) as {
      title: string;
      owner: string | null;
    };

    expect(row.title).toBe("Fix bug (updated)");
    expect(row.owner).toBe("bob");
  });

  it("handles null body without error", () => {
    const result = upsertWorkItem(db, {
      source: "github",
      externalId: "issue:owner/repo#1",
      kind: "issue",
      title: "No body issue",
      status: "open",
      body: null,
      externalUrl: "https://github.com/owner/repo/issues/1",
      updatedAt: new Date()
    });

    expect(result.created).toBe(true);
  });
});

describe("recordAgentEvent", () => {
  it("preserves the first session start time when later events update the session", () => {
    recordAgentEvent(db, {
      agent: "hermes",
      externalSessionId: "slack:D0B4BBN7TUK:session-1",
      eventType: "task_started",
      task: "Improve ledger transparency",
      payload: { sequence: 1 },
      occurredAt: new Date("2026-06-18T06:40:00.000Z")
    });

    recordAgentEvent(db, {
      agent: "hermes",
      externalSessionId: "slack:D0B4BBN7TUK:session-1",
      eventType: "tests_passed",
      task: "Improve ledger transparency",
      payload: { sequence: 2 },
      occurredAt: new Date("2026-06-18T08:15:00.000Z")
    });

    const session = db.sqlite
      .prepare("SELECT started_at, initial_task FROM agent_sessions WHERE external_session_id = ?")
      .get("slack:D0B4BBN7TUK:session-1") as { started_at: string; initial_task: string };
    const eventCount = db.sqlite
      .prepare("SELECT COUNT(*) as cnt FROM agent_events WHERE external_session_id = ?")
      .get("slack:D0B4BBN7TUK:session-1") as { cnt: number };

    expect(session.started_at).toBe("2026-06-18T06:40:00.000Z");
    expect(session.initial_task).toBe("Improve ledger transparency");
    expect(eventCount.cnt).toBe(2);
  });

  it("returns recent agent evidence signals without generic lifecycle events", () => {
    recordAgentEvent(db, {
      agent: "hermes",
      eventType: "task_started",
      task: "Generic lifecycle event",
      payload: {},
      occurredAt: new Date("2026-06-18T06:40:00.000Z")
    });
    recordAgentEvent(db, {
      agent: "hermes",
      eventType: "runtime_verified",
      task: "Runtime signal",
      confidence: "agent_observed",
      payload: {},
      occurredAt: new Date("2026-06-18T08:15:00.000Z")
    });

    const signals = getRecentAgentEvidenceSignals(db, {
      since: new Date("2026-06-18T00:00:00.000Z")
    });

    expect(signals.map((signal) => signal.task)).toEqual(["Runtime signal"]);
    expect(signals[0]?.confidence).toBe("agent_observed");
  });
});

describe("createPlanSnapshot", () => {
  it("creates a snapshot with steps", () => {
    const item = upsertWorkItem(db, {
      source: "github",
      externalId: "issue:owner/repo#1",
      kind: "issue",
      title: "Task with plan",
      status: "open",
      externalUrl: "https://github.com/owner/repo/issues/1",
      updatedAt: new Date()
    });

    const snapshotId = createPlanSnapshot(db, {
      workItemId: item.id,
      source: "github",
      rawBody: "- [ ] step one\n- [x] step two",
      steps: [
        { stepOrder: 1, text: "step one", completed: false },
        { stepOrder: 2, text: "step two", completed: true }
      ]
    });

    expect(snapshotId).toBeDefined();

    const steps = db.sqlite
      .prepare("SELECT * FROM plan_steps WHERE snapshot_id = ? ORDER BY step_order")
      .all(snapshotId) as Array<{ text: string; completed: number }>;

    expect(steps).toHaveLength(2);
    expect(steps[0].text).toBe("step one");
    expect(steps[0].completed).toBe(0);
    expect(steps[1].text).toBe("step two");
    expect(steps[1].completed).toBe(1);
  });
});

describe("getLatestPlanSnapshot", () => {
  it("returns null for a work item with no snapshots", () => {
    const item = upsertWorkItem(db, {
      source: "github",
      externalId: "issue:owner/repo#1",
      kind: "issue",
      title: "No plan",
      status: "open",
      externalUrl: "https://github.com/owner/repo/issues/1",
      updatedAt: new Date()
    });

    expect(getLatestPlanSnapshot(db, item.id)).toBeNull();
  });

  it("returns the latest snapshot with steps", async () => {
    const item = upsertWorkItem(db, {
      source: "github",
      externalId: "issue:owner/repo#1",
      kind: "issue",
      title: "Planned task",
      status: "open",
      externalUrl: "https://github.com/owner/repo/issues/1",
      updatedAt: new Date()
    });

    createPlanSnapshot(db, {
      workItemId: item.id,
      source: "github",
      rawBody: "- [ ] first",
      steps: [{ stepOrder: 1, text: "first", completed: false }]
    });

    // Small delay so parsedAt differs — orderBy(desc) picks the second
    await new Promise((r) => setTimeout(r, 50));

    createPlanSnapshot(db, {
      workItemId: item.id,
      source: "github",
      rawBody: "- [x] first\n- [ ] second",
      steps: [
        { stepOrder: 1, text: "first", completed: true },
        { stepOrder: 2, text: "second", completed: false }
      ]
    });

    const latest = getLatestPlanSnapshot(db, item.id);
    expect(latest).not.toBeNull();
    expect(latest!.steps).toHaveLength(2);
    expect(latest!.steps[0].completed).toBe(true);
  });
});

describe("createMilestoneEvent", () => {
  it("creates a milestone event", () => {
    const item = upsertWorkItem(db, {
      source: "github",
      externalId: "issue:owner/repo#1",
      kind: "issue",
      title: "Task",
      status: "open",
      externalUrl: "https://github.com/owner/repo/issues/1",
      updatedAt: new Date()
    });

    const snapshot = createPlanSnapshot(db, {
      workItemId: item.id,
      source: "github",
      rawBody: "- [ ] step",
      steps: [{ stepOrder: 1, text: "step", completed: false }]
    });

    const steps = db.sqlite
      .prepare("SELECT id FROM plan_steps WHERE snapshot_id = ?")
      .all(snapshot) as Array<{ id: number }>;

    const event = createMilestoneEvent(db, {
      workItemId: item.id,
      stepId: steps[0].id,
      previousState: "open",
      newState: "completed",
      occurredAt: new Date()
    });

    expect(event).toBeDefined();
    // emitted defaults to false — verify by querying
    const row = db.sqlite
      .prepare("SELECT emitted FROM milestone_events WHERE id = ?")
      .get(event!.id) as { emitted: number };
    expect(row.emitted).toBe(0);
  });
});

describe("milestone tracking", () => {
  it("tracks unemitted milestones and marks them as emitted", () => {
    const item = upsertWorkItem(db, {
      source: "github",
      externalId: "issue:owner/repo#1",
      kind: "issue",
      title: "Task",
      status: "open",
      externalUrl: "https://github.com/owner/repo/issues/1",
      updatedAt: new Date()
    });

    const snapshot = createPlanSnapshot(db, {
      workItemId: item.id,
      source: "github",
      rawBody: "- [ ] step",
      steps: [{ stepOrder: 1, text: "step", completed: false }]
    });

    const steps = db.sqlite
      .prepare("SELECT id FROM plan_steps WHERE snapshot_id = ?")
      .all(snapshot) as Array<{ id: number }>;

    const event = createMilestoneEvent(db, {
      workItemId: item.id,
      stepId: steps[0].id,
      previousState: "open",
      newState: "completed",
      occurredAt: new Date()
    });

    let unemitted = getUnemittedMilestones(db);
    expect(unemitted).toHaveLength(1);

    markMilestoneEmitted(db, event!.id);

    unemitted = getUnemittedMilestones(db);
    expect(unemitted).toHaveLength(0);
  });
});

describe("createBlocker / getActiveBlockers / resolveBlocker", () => {
  it("creates, queries, and resolves blockers", () => {
    const item = upsertWorkItem(db, {
      source: "github",
      externalId: "pr:owner/repo#1",
      kind: "pull_request",
      title: "PR with blocker",
      status: "open",
      externalUrl: "https://github.com/owner/repo/pull/1",
      updatedAt: new Date()
    });

    const blocker = createBlocker(db, {
      workItemId: item.id,
      type: "ci_failure",
      title: "Build failed",
      detail: "Test suite failed",
      occurredAt: new Date()
    });

    expect(blocker).toBeDefined();
    // status defaults to "active" — verify by querying
    const blockerRow = db.sqlite
      .prepare("SELECT status FROM blockers WHERE id = ?")
      .get(blocker!.id) as { status: string };
    expect(blockerRow.status).toBe("active");

    let active = getActiveBlockers(db);
    expect(active).toHaveLength(1);

    resolveBlocker(db, blocker!.id, new Date());

    active = getActiveBlockers(db);
    expect(active).toHaveLength(0);
  });
});

describe("recordEmittedMessage", () => {
  it("records a message and is idempotent on dedupKey", () => {
    recordEmittedMessage(db, {
      category: "milestone_reached",
      title: "Step completed",
      body: "Step one done",
      dedupKey: "msg:1",
      emittedAt: new Date()
    });

    recordEmittedMessage(db, {
      category: "milestone_reached",
      title: "Step completed",
      body: "Step one done",
      dedupKey: "msg:1",
      emittedAt: new Date()
    });

    const count = db.sqlite.prepare("SELECT COUNT(*) as cnt FROM emitted_feed_messages").get() as {
      cnt: number;
    };

    expect(count.cnt).toBe(1);
  });
});

describe("getActiveWorkItems", () => {
  beforeEach(() => {
    upsertWorkItem(db, {
      source: "github",
      externalId: "pr:owner/repo#1",
      kind: "pull_request",
      title: "PR 1",
      status: "open",
      owner: "alice",
      externalUrl: "https://github.com/owner/repo/pull/1",
      updatedAt: new Date()
    });
    upsertWorkItem(db, {
      source: "github",
      externalId: "pr:other/repo#2",
      kind: "pull_request",
      title: "PR 2",
      status: "closed",
      owner: "bob",
      externalUrl: "https://github.com/other/repo/pull/2",
      updatedAt: new Date()
    });
    upsertWorkItem(db, {
      source: "jira",
      externalId: "story:PROJ-123",
      kind: "story",
      title: "Story 123",
      status: "open",
      owner: "alice",
      externalUrl: "https://jira.example.com/browse/PROJ-123",
      updatedAt: new Date()
    });
  });

  it("returns open and draft items", () => {
    upsertWorkItem(db, {
      source: "github",
      externalId: "pr:owner/repo#3",
      kind: "pull_request",
      title: "Draft PR",
      status: "draft",
      owner: "alice",
      externalUrl: "https://github.com/owner/repo/pull/3",
      updatedAt: new Date()
    });

    const items = getActiveWorkItems(db);
    expect(items).toHaveLength(3);
    expect(items.some((i) => i.status === "draft")).toBe(true);
  });

  it("filters by assignee", () => {
    const items = getActiveWorkItems(db, { assignees: ["bob"] });
    expect(items).toHaveLength(0);
  });

  it("filters by source", () => {
    const items = getActiveWorkItems(db, { source: "jira" });
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("jira");
  });

  it("filters by repository names", () => {
    const items = getActiveWorkItems(db, { repositoryNames: ["other/repo"] });
    expect(items).toHaveLength(0); // PR 2 is closed
  });

  it("respects limit", () => {
    const items = getActiveWorkItems(db, { limit: 1 });
    expect(items).toHaveLength(1);
  });
});

describe("getDashboardStats", () => {
  it("returns zero counts on empty database", () => {
    const stats = getDashboardStats(db);
    expect(stats.openItems).toBe(0);
    expect(stats.activeBlockers).toBe(0);
    expect(stats.recentMilestones).toBe(0);
  });

  it("counts open items and active blockers", () => {
    const item = upsertWorkItem(db, {
      source: "github",
      externalId: "pr:owner/repo#1",
      kind: "pull_request",
      title: "PR",
      status: "open",
      externalUrl: "https://github.com/owner/repo/pull/1",
      updatedAt: new Date()
    });

    createBlocker(db, {
      workItemId: item.id,
      type: "ci_failure",
      title: "CI failed",
      occurredAt: new Date()
    });

    const stats = getDashboardStats(db);
    expect(stats.openItems).toBe(1);
    expect(stats.activeBlockers).toBe(1);
  });
});

describe("getRecentMilestones", () => {
  it("returns milestones joined with work item and step data", () => {
    const item = upsertWorkItem(db, {
      source: "github",
      externalId: "issue:owner/repo#1",
      kind: "issue",
      title: "Task",
      status: "open",
      externalUrl: "https://github.com/owner/repo/issues/1",
      updatedAt: new Date()
    });

    const snapshot = createPlanSnapshot(db, {
      workItemId: item.id,
      source: "github",
      rawBody: "- [ ] step",
      steps: [{ stepOrder: 1, text: "step", completed: false }]
    });

    const steps = db.sqlite
      .prepare("SELECT id FROM plan_steps WHERE snapshot_id = ?")
      .all(snapshot) as Array<{ id: number }>;

    createMilestoneEvent(db, {
      workItemId: item.id,
      stepId: steps[0].id,
      previousState: "open",
      newState: "completed",
      occurredAt: new Date()
    });

    const milestones = getRecentMilestones(db);
    expect(milestones).toHaveLength(1);
    expect(milestones[0].workItemTitle).toBe("Task");
    expect(milestones[0].stepText).toBe("step");
  });
});

describe("getWorkItemsWithBlockers", () => {
  it("returns items with blocker counts", () => {
    const item1 = upsertWorkItem(db, {
      source: "github",
      externalId: "pr:owner/repo#1",
      kind: "pull_request",
      title: "PR 1",
      status: "open",
      externalUrl: "https://github.com/owner/repo/pull/1",
      updatedAt: new Date()
    });

    upsertWorkItem(db, {
      source: "github",
      externalId: "pr:owner/repo#2",
      kind: "pull_request",
      title: "PR 2",
      status: "open",
      externalUrl: "https://github.com/owner/repo/pull/2",
      updatedAt: new Date()
    });

    createBlocker(db, {
      workItemId: item1.id,
      type: "ci_failure",
      title: "CI failed",
      occurredAt: new Date()
    });

    const results = getWorkItemsWithBlockers(db);
    expect(results).toHaveLength(2);
    const pr1 = results.find((r: any) => r.title === "PR 1") as any;
    expect(pr1!.blockerCount).toBe(1);
  });
});

describe("getStaleWorkItems", () => {
  it("returns only open items older than the threshold", () => {
    upsertWorkItem(db, {
      source: "github",
      externalId: "pr:owner/repo#1",
      kind: "pull_request",
      title: "Fresh",
      status: "open",
      externalUrl: "https://github.com/owner/repo/pull/1",
      updatedAt: new Date()
    });

    upsertWorkItem(db, {
      source: "github",
      externalId: "issue:owner/repo#2",
      kind: "issue",
      title: "Stale",
      status: "open",
      externalUrl: "https://github.com/owner/repo/issues/2",
      updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    });

    upsertWorkItem(db, {
      source: "github",
      externalId: "issue:owner/repo#3",
      kind: "issue",
      title: "Stale but closed",
      status: "closed",
      externalUrl: "https://github.com/owner/repo/issues/3",
      updatedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)
    });

    const stale = getStaleWorkItems(db, 2);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.title).toBe("Stale");
  });
});

describe("getLinksTo", () => {
  it("returns links pointing at a target external id", () => {
    upsertLink(db, {
      fromSource: "github",
      fromExternalId: "pr:o/r#1",
      toSource: "jira",
      toExternalId: "issue:PROJ-1"
    });
    upsertLink(db, {
      fromSource: "github",
      fromExternalId: "pr:o/r#2",
      toSource: "jira",
      toExternalId: "issue:PROJ-1"
    });

    const links = getLinksTo(db, "issue:PROJ-1");
    expect(links).toHaveLength(2);
  });
});

describe("getActiveBlockersWithItems", () => {
  it("joins active blockers to their linked work item and tolerates unlinked", () => {
    const item = upsertWorkItem(db, {
      source: "github",
      externalId: "pr:owner/repo#1",
      kind: "pull_request",
      title: "Linked PR",
      status: "open",
      externalUrl: "https://github.com/owner/repo/pull/1",
      updatedAt: new Date()
    });

    createBlocker(db, {
      workItemId: item.id,
      type: "ci_failure",
      title: "Linked failure",
      occurredAt: new Date()
    });
    createBlocker(db, { type: "ci_failure", title: "Unlinked failure", occurredAt: new Date() });

    const blockers = getActiveBlockersWithItems(db);
    expect(blockers).toHaveLength(2);

    const linked = blockers.find((b) => b.title === "Linked failure");
    const unlinked = blockers.find((b) => b.title === "Unlinked failure");
    expect(linked!.workItemTitle).toBe("Linked PR");
    expect(unlinked!.workItemId).toBeNull();
    expect(unlinked!.workItemTitle).toBeNull();
  });
});
