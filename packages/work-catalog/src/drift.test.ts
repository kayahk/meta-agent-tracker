import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertWorkItem, upsertLink, type OpenedDatabase } from "@meta-agent/storage";
import { createTestDatabase } from "@meta-agent/storage/test-utils";
import type { HermesClient, HermesMessage } from "@meta-agent/hermes";
import { detectGitHubJiraDrift, detectJiraWithoutGithub, deliverDrift } from "./drift.js";

let db: OpenedDatabase;

beforeEach(() => {
  db = createTestDatabase("meta-agent-drift-");
});

afterEach(() => {
  db.sqlite.close();
});

function addPr(externalId: string, status: string, title = "PR") {
  upsertWorkItem(db, {
    source: "github",
    externalId,
    kind: "pull_request",
    title,
    status,
    externalUrl: `https://github.com/o/r/pull/1`,
    updatedAt: new Date()
  });
  upsertLink(db, {
    fromSource: "github",
    fromExternalId: externalId,
    toSource: "jira",
    toExternalId: "issue:PROJ-1"
  });
}

describe("detectGitHubJiraDrift", () => {
  it("flags a merged PR whose Jira issue is not done", () => {
    addPr("pr:o/r#1", "merged");
    const findings = detectGitHubJiraDrift(db, new Map([["issue:PROJ-1", "In Progress"]]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("pr_merged_jira_open");
    expect(findings[0]!.jiraKey).toBe("PROJ-1");
  });

  it("does not flag a merged PR whose Jira issue is done (absent from status map)", () => {
    addPr("pr:o/r#1", "merged");
    const findings = detectGitHubJiraDrift(db, new Map());
    expect(findings).toHaveLength(0);
  });

  it("flags a draft PR whose Jira issue is in review", () => {
    addPr("pr:o/r#1", "draft");
    const findings = detectGitHubJiraDrift(db, new Map([["issue:PROJ-1", "In Review"]]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("pr_draft_jira_review");
  });

  it("does not flag an open PR with an in-progress Jira issue", () => {
    addPr("pr:o/r#1", "open");
    const findings = detectGitHubJiraDrift(db, new Map([["issue:PROJ-1", "In Progress"]]));
    expect(findings).toHaveLength(0);
  });

  it("does not treat model-proposed links as authoritative drift evidence", () => {
    upsertWorkItem(db, {
      source: "github",
      externalId: "pr:o/r#1",
      kind: "pull_request",
      title: "PR",
      status: "merged",
      externalUrl: "https://github.com/o/r/pull/1",
      updatedAt: new Date()
    });
    upsertLink(db, {
      fromSource: "github",
      fromExternalId: "pr:o/r#1",
      toSource: "jira",
      toExternalId: "issue:PROJ-1",
      relation: "proposes",
      origin: "llm_proposed",
      confidence: 0.9
    });

    const findings = detectGitHubJiraDrift(db, new Map([["issue:PROJ-1", "In Progress"]]));

    expect(findings).toHaveLength(0);
  });
});

describe("detectJiraWithoutGithub", () => {
  it("flags Jira issues in implementation status with no linked GitHub work", () => {
    upsertWorkItem(db, {
      source: "jira",
      externalId: "issue:PROJ-9",
      kind: "story",
      title: "Unlinked story",
      status: "In Progress",
      externalUrl: "https://jira.example.com/browse/PROJ-9",
      updatedAt: new Date()
    });

    const findings = detectJiraWithoutGithub(db, new Map([["issue:PROJ-9", "In Progress"]]));

    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("jira_in_progress_no_github");
  });

  it("does not flag Jira issues that already have GitHub links", () => {
    upsertWorkItem(db, {
      source: "jira",
      externalId: "issue:PROJ-9",
      kind: "story",
      title: "Linked story",
      status: "In Progress",
      externalUrl: "https://jira.example.com/browse/PROJ-9",
      updatedAt: new Date()
    });
    upsertLink(db, {
      fromSource: "github",
      fromExternalId: "pr:o/r#1",
      toSource: "jira",
      toExternalId: "issue:PROJ-9"
    });

    const findings = detectJiraWithoutGithub(db, new Map([["issue:PROJ-9", "In Progress"]]));
    expect(findings).toHaveLength(0);
  });

  it("still flags Jira issues when only proposed GitHub links exist", () => {
    upsertWorkItem(db, {
      source: "jira",
      externalId: "issue:PROJ-9",
      kind: "story",
      title: "Proposed story",
      status: "In Progress",
      externalUrl: "https://jira.example.com/browse/PROJ-9",
      updatedAt: new Date()
    });
    upsertLink(db, {
      fromSource: "github",
      fromExternalId: "pr:o/r#1",
      toSource: "jira",
      toExternalId: "issue:PROJ-9",
      relation: "proposes",
      origin: "llm_proposed",
      confidence: 0.9
    });

    const findings = detectJiraWithoutGithub(db, new Map([["issue:PROJ-9", "In Progress"]]));

    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("jira_in_progress_no_github");
  });
});

describe("deliverDrift", () => {
  it("delivers each finding once, suppressing repeats", async () => {
    addPr("pr:o/r#1", "merged");
    const sent: HermesMessage[] = [];
    const hermes: HermesClient = {
      async send(m) {
        sent.push(m);
        return true;
      }
    };

    const findings = detectGitHubJiraDrift(db, new Map([["issue:PROJ-1", "In Progress"]]));
    const first = await deliverDrift(hermes, db, findings);
    const second = await deliverDrift(hermes, db, findings);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.category).toBe("requirement_drift");
  });

  it("does not suppress retry when Hermes delivery fails", async () => {
    addPr("pr:o/r#1", "merged");
    const sent: HermesMessage[] = [];
    const hermes: HermesClient = {
      async send(m) {
        sent.push(m);
        return sent.length > 1;
      }
    };

    const findings = detectGitHubJiraDrift(db, new Map([["issue:PROJ-1", "In Progress"]]));
    const first = await deliverDrift(hermes, db, findings);
    const second = await deliverDrift(hermes, db, findings);
    const third = await deliverDrift(hermes, db, findings);

    expect(first).toBe(0);
    expect(second).toBe(1);
    expect(third).toBe(0);
    expect(sent).toHaveLength(2);
  });
});
