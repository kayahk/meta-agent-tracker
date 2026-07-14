import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLinksFrom, upsertLink, upsertWorkItem, type OpenedDatabase } from "@meta-agent/storage";
import { createTestDatabase } from "@meta-agent/storage/test-utils";
import { detectConfluenceRequirementDrift, reconcileConfluenceLedger } from "./confluence.js";
import type { ConfluencePage } from "@meta-agent/confluence-adapter";

let db: OpenedDatabase;

beforeEach(() => {
  db = createTestDatabase("meta-agent-confluence-");
});

afterEach(() => {
  db.sqlite.close();
});

function page(overrides: Partial<ConfluencePage> = {}): ConfluencePage {
  return {
    id: "42",
    title: "Device Requirements PROJ-9",
    url: "https://confluence.example.com/display/PROJ/Device",
    body: "<p>Implementation tracked by https://github.com/o/r/pull/7</p>",
    version: 3,
    updatedAt: new Date("2026-06-22T10:00:00Z"),
    labels: ["requirements"],
    ...overrides
  };
}

function addActivePr(externalId = "pr:o/r#7") {
  const prNumber = externalId.split("#").at(-1) ?? "7";
  upsertWorkItem(db, {
    source: "github",
    externalId,
    kind: "pull_request",
    title: "Implement device flow",
    status: "open",
    externalUrl: `https://github.com/o/r/pull/${prNumber}`,
    updatedAt: new Date("2026-06-22T09:00:00Z")
  });
}

describe("reconcileConfluenceLedger", () => {
  it("upserts Confluence pages and deterministic links", () => {
    const result = reconcileConfluenceLedger({ db, pages: [page()] });

    expect(result).toMatchObject({ upserted: 1, created: 1 });
    expect(getLinksFrom(db, "page:42")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromSource: "confluence",
          toSource: "jira",
          toExternalId: "issue:PROJ-9",
          origin: "deterministic"
        }),
        expect.objectContaining({
          fromSource: "confluence",
          toSource: "github",
          toExternalId: "pr:o/r#7",
          origin: "deterministic"
        })
      ])
    );
  });
});

describe("detectConfluenceRequirementDrift", () => {
  it("alerts when a changed Confluence page links directly to active GitHub work", () => {
    addActivePr();
    reconcileConfluenceLedger({ db, pages: [page()] });

    const findings = detectConfluenceRequirementDrift(db, [page({ version: 4 })]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      type: "confluence_doc_changed_active_work",
      workItemTitle: "Implement device flow",
      dedupKey: "confluence_doc_changed:page:42:pr:o/r#7:4"
    });
  });

  it("alerts through Jira bridge links to active GitHub work", () => {
    addActivePr("pr:o/r#8");
    upsertLink(db, {
      fromSource: "github",
      fromExternalId: "pr:o/r#8",
      toSource: "jira",
      toExternalId: "issue:PROJ-9",
      origin: "deterministic"
    });
    reconcileConfluenceLedger({
      db,
      pages: [page({ body: "<p>Requirement for proj-9</p>" })]
    });

    const findings = detectConfluenceRequirementDrift(db, [
      page({ body: "<p>Requirement for proj-9</p>", version: 5 })
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.workItemUrl).toBe("https://github.com/o/r/pull/8");
  });

  it("does not alert for merged linked work", () => {
    upsertWorkItem(db, {
      source: "github",
      externalId: "pr:o/r#7",
      kind: "pull_request",
      title: "Already merged",
      status: "merged",
      externalUrl: "https://github.com/o/r/pull/7",
      updatedAt: new Date("2026-06-22T09:00:00Z")
    });
    reconcileConfluenceLedger({ db, pages: [page()] });

    expect(detectConfluenceRequirementDrift(db, [page({ version: 4 })])).toHaveLength(0);
  });
});
