import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertLink, type OpenedDatabase } from "@meta-agent/storage";
import { createTestDatabase } from "@meta-agent/storage/test-utils";
import type { HermesClient, HermesMessage } from "@meta-agent/hermes";
import { normalizeJiraEvent } from "./index.js";

let db: OpenedDatabase;

beforeEach(() => {
  db = createTestDatabase("meta-agent-jira-drift-");
});

afterEach(() => {
  db.sqlite.close();
});

function issueUpdatedPayload(changelogItems: Array<Record<string, unknown>>) {
  return {
    webhookEvent: "jira:issue_updated",
    timestamp: Date.now(),
    issue: {
      key: "PROJ-1",
      self: "https://jira.example.com/rest/api/3/issue/PROJ-1",
      fields: {
        summary: "Story",
        description: "Details",
        status: { name: "In Progress" },
        issuetype: { name: "Story" },
        updated: new Date().toISOString()
      }
    },
    changelog: { items: changelogItems }
  };
}

describe("acceptance criteria drift", () => {
  it("alerts when AC changes on a Jira issue with linked GitHub work", async () => {
    upsertLink(db, {
      fromSource: "github",
      fromExternalId: "pr:o/r#1",
      toSource: "jira",
      toExternalId: "issue:PROJ-1"
    });

    const sent: HermesMessage[] = [];
    const hermes: HermesClient = {
      async send(m) {
        sent.push(m);
        return true;
      }
    };

    const result = await normalizeJiraEvent(
      db,
      "jira:issue_updated",
      issueUpdatedPayload([
        {
          field: "Acceptance Criteria",
          fromString: "User can log in",
          toString: "User can log in with MFA"
        }
      ]),
      hermes
    );

    expect(result.effects.some((e) => e.type === "requirement_drift")).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.category).toBe("requirement_drift");
    expect(sent[0]!.title).toContain("PROJ-1");
  });

  it("does not alert when there is no linked GitHub work", async () => {
    const sent: HermesMessage[] = [];
    const hermes: HermesClient = {
      async send(m) {
        sent.push(m);
        return true;
      }
    };

    await normalizeJiraEvent(
      db,
      "jira:issue_updated",
      issueUpdatedPayload([
        {
          field: "Acceptance Criteria",
          fromString: "old",
          toString: "new"
        }
      ]),
      hermes
    );

    expect(sent).toHaveLength(0);
  });

  it("does not alert when only proposed GitHub links exist", async () => {
    upsertLink(db, {
      fromSource: "github",
      fromExternalId: "pr:o/r#1",
      toSource: "jira",
      toExternalId: "issue:PROJ-1",
      relation: "proposes",
      origin: "llm_proposed",
      confidence: 0.9
    });
    const sent: HermesMessage[] = [];
    const hermes: HermesClient = {
      async send(m) {
        sent.push(m);
        return true;
      }
    };

    const result = await normalizeJiraEvent(
      db,
      "jira:issue_updated",
      issueUpdatedPayload([
        {
          field: "Acceptance Criteria",
          fromString: "old",
          toString: "new"
        }
      ]),
      hermes
    );

    expect(result.effects.some((e) => e.type === "requirement_drift")).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("dedupes repeated alerts for the same AC text", async () => {
    upsertLink(db, {
      fromSource: "github",
      fromExternalId: "pr:o/r#1",
      toSource: "jira",
      toExternalId: "issue:PROJ-1"
    });

    const sent: HermesMessage[] = [];
    const hermes: HermesClient = {
      async send(m) {
        sent.push(m);
        return true;
      }
    };

    const payload = issueUpdatedPayload([
      {
        field: "Acceptance Criteria",
        fromString: "a",
        toString: "same text"
      }
    ]);

    await normalizeJiraEvent(db, "jira:issue_updated", payload, hermes);
    await normalizeJiraEvent(db, "jira:issue_updated", payload, hermes);

    expect(sent).toHaveLength(1);
  });
});
