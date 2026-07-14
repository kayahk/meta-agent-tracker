import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLinksFrom, type OpenedDatabase } from "@meta-agent/storage";
import { createTestDatabase } from "@meta-agent/storage/test-utils";
import { extractJiraIssueKeys, syncJiraLinks } from "./index.js";

describe("extractJiraIssueKeys", () => {
  it("finds Jira keys in free text and dedupes", () => {
    const keys = extractJiraIssueKeys("Implements PROJ-482 and proj-482, also ABC-1");
    expect(keys).toContain("PROJ-482");
    expect(keys).toContain("ABC-1");
    expect(keys.filter((k) => k === "PROJ-482")).toHaveLength(1);
  });

  it("returns empty for no keys or empty input", () => {
    expect(extractJiraIssueKeys("no keys here")).toEqual([]);
    expect(extractJiraIssueKeys(null)).toEqual([]);
    expect(extractJiraIssueKeys(undefined)).toEqual([]);
  });
});

describe("syncJiraLinks", () => {
  let db: OpenedDatabase;

  beforeEach(() => {
    db = createTestDatabase("meta-agent-links-");
  });

  afterEach(() => {
    db.sqlite.close();
  });

  it("creates links from a GitHub item to each referenced Jira issue", () => {
    const keys = syncJiraLinks(
      db,
      "github",
      "pr:o/r#1",
      "Fix login (PROJ-482)\nbody mentions DEVOPS-9"
    );
    expect(keys.sort()).toEqual(["DEVOPS-9", "PROJ-482"]);

    const links = getLinksFrom(db, "pr:o/r#1");
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.toExternalId).sort()).toEqual(["issue:DEVOPS-9", "issue:PROJ-482"]);
    expect(links[0]!.origin).toBe("deterministic");
  });

  it("is idempotent on repeated syncs", () => {
    syncJiraLinks(db, "github", "pr:o/r#1", "PROJ-482");
    syncJiraLinks(db, "github", "pr:o/r#1", "PROJ-482");
    expect(getLinksFrom(db, "pr:o/r#1")).toHaveLength(1);
  });
});
