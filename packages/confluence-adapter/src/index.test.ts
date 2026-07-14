import { describe, expect, it, vi } from "vitest";
import {
  ConfluenceAdapter,
  HttpConfluenceClient,
  classifyConfluencePage,
  extractConfluenceLinks,
  normalizeConfluencePage,
  stripConfluenceStorage,
  type ConfluenceClient
} from "./index.js";

describe("confluence-adapter", () => {
  it("normalizes Confluence pages into source-agnostic external items", () => {
    const item = normalizeConfluencePage({
      id: "123",
      spaceKey: "PROJ",
      title: "ADR: Example Assistant rollout references PROJ-42",
      url: "https://confluence.example.com/display/PROJ/ExampleAssistant",
      body: "See https://github.com/example-org/meta-agent-tracker/pull/8",
      version: 7,
      updatedAt: new Date("2026-06-20T12:00:00Z"),
      updatedBy: "Example User",
      labels: ["architecture-decision"]
    });

    expect(item).toMatchObject({
      source: "confluence",
      externalId: "page:123",
      kind: "adr",
      status: "v7",
      owner: "Example User"
    });
    expect(item.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "jira", externalId: "issue:PROJ-42" }),
        expect.objectContaining({
          source: "github",
          externalId: "pr:example-org/meta-agent-tracker#8"
        })
      ])
    );
  });

  it("classifies requirement and generic documentation pages", () => {
    expect(
      classifyConfluencePage({
        id: "1",
        title: "Acceptance Criteria for Platform Status",
        url: "https://example.test/1",
        updatedAt: new Date()
      })
    ).toBe("requirement");
    expect(
      classifyConfluencePage({
        id: "2",
        title: "Runbook: restore webhook tunnel",
        url: "https://example.test/2",
        updatedAt: new Date()
      })
    ).toBe("doc");
  });

  it("extracts unique Jira and GitHub links from page text", () => {
    const links = extractConfluenceLinks("PROJ-42 proj-42 DEVOPS-9 https://github.com/o/r/pull/12");
    expect(links.map((link) => link.externalId).sort()).toEqual([
      "issue:DEVOPS-9",
      "issue:PROJ-42",
      "pr:o/r#12"
    ]);
  });

  it("strips Confluence storage HTML into readable text", () => {
    expect(stripConfluenceStorage("<p>One&nbsp;&amp;</p><ul><li>Two&lt;3</li></ul>")).toBe(
      "One &\nTwo<3"
    );
  });

  it("maps recent page changes to idempotent source changes", async () => {
    const client: ConfluenceClient = {
      fetchPage: vi.fn(),
      searchPages: vi.fn(),
      fetchRecentChanges: vi.fn().mockResolvedValue([
        {
          changeType: "updated",
          page: {
            id: "123",
            title: "Page",
            url: "https://example.test/page",
            version: 4,
            updatedAt: new Date("2026-06-20T12:00:00Z")
          }
        }
      ])
    };

    const adapter = new ConfluenceAdapter(client, ["PROJ"]);
    const changes = await adapter.fetchRecentChanges(new Date("2026-06-19T00:00:00Z"));

    expect(client.fetchRecentChanges).toHaveBeenCalledWith(new Date("2026-06-19T00:00:00Z"), [
      "PROJ"
    ]);
    expect(changes).toEqual([
      expect.objectContaining({
        source: "confluence",
        externalId: "page:123",
        changeType: "updated",
        idempotencyKey: "confluence:123:4:updated"
      })
    ]);
  });

  it("uses bearer auth and parses Data Center REST page responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "456",
        title: "Requirement PROJ-77",
        _links: { webui: "/display/PROJ/Req" },
        space: { key: "PROJ" },
        body: { storage: { value: "<p>Body</p>" } },
        version: { number: 3, when: "2026-06-20T12:00:00Z", by: { displayName: "Alice" } },
        metadata: { labels: { results: [{ name: "requirements" }] } }
      })
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new HttpConfluenceClient({
        url: "https://confluence.example.com/",
        pat: "secret"
      });
      const page = await client.fetchPage("456");

      expect(fetchMock).toHaveBeenCalledWith(
        "https://confluence.example.com/rest/api/content/456?expand=body.storage,version,space,metadata.labels",
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: "Bearer secret" })
        })
      );
      expect(page).toMatchObject({
        id: "456",
        spaceKey: "PROJ",
        title: "Requirement PROJ-77",
        url: "https://confluence.example.com/display/PROJ/Req",
        body: "<p>Body</p>",
        version: 3,
        updatedBy: "Alice",
        labels: ["requirements"]
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("paginates Confluence search results up to the requested limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: Array.from({ length: 100 }, (_, index) => rawPage(index)) })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: Array.from({ length: 50 }, (_, index) => rawPage(index + 100))
        })
      });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new HttpConfluenceClient({
        url: "https://confluence.example.com",
        pat: "secret"
      });
      const pages = await client.searchPages({ text: "Example Assistant", limit: 150 });

      expect(pages).toHaveLength(150);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.get("start")).toBe("0");
      expect(new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.get("limit")).toBe("100");
      expect(new URL(fetchMock.mock.calls[1]?.[0] as string).searchParams.get("start")).toBe("100");
      expect(new URL(fetchMock.mock.calls[1]?.[0] as string).searchParams.get("limit")).toBe("50");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("paginates recent changes beyond the first hundred results", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: Array.from({ length: 100 }, (_, index) => rawPage(index)) })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [rawPage(100)] })
      });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new HttpConfluenceClient({
        url: "https://confluence.example.com",
        pat: "secret"
      });
      const changes = await client.fetchRecentChanges(new Date("2026-06-01T00:00:00Z"), ["PROJ"]);

      expect(changes).toHaveLength(101);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new URL(fetchMock.mock.calls[1]?.[0] as string).searchParams.get("start")).toBe("100");
      expect(new URL(fetchMock.mock.calls[1]?.[0] as string).searchParams.get("limit")).toBe("100");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function rawPage(index: number) {
  return {
    id: String(index),
    title: `Page ${index}`,
    _links: { webui: `/display/PROJ/Page-${index}` },
    space: { key: "PROJ" },
    body: { storage: { value: `<p>Body ${index}</p>` } },
    version: { number: index + 1, when: "2026-06-20T12:00:00Z" },
    metadata: { labels: { results: [] } }
  };
}
