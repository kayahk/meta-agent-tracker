import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmClient, NoopLlmClient } from "./index.js";

// Mock fetch
beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NoopLlmClient", () => {
  it("returns empty content", async () => {
    const client = new NoopLlmClient();
    const result = await client.complete({
      messages: [{ role: "user", content: "test" }]
    });
    expect(result.content).toBe("");
  });

  it("returns empty matches", async () => {
    const client = new NoopLlmClient();
    const result = await client.matchToJira({
      githubItem: { title: "Test", body: "", repo: "owner/repo" },
      jiraCandidates: [],
      maxMatches: 5
    });
    expect(result).toEqual([]);
  });

  it("returns empty draft", async () => {
    const client = new NoopLlmClient();
    const result = await client.draftJiraIssue({
      githubItem: { title: "Test", body: "" }
    });
    expect(result).toEqual({ summary: "", description: "", labels: [] });
  });
});

describe("LlmClient", () => {
  it("strips trailing slashes from baseUrl", () => {
    const client = new LlmClient({
      apiUrl: "https://api.example.com/v1///",
      apiKey: "key",
      model: "gpt-4"
    });
    expect((client as any).baseUrl).toBe("https://api.example.com/v1");
  });

  it("sends a proper request body", async () => {
    let capturedBody: any = null;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Hello world" } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 }
      })
    });

    const client = new LlmClient({
      apiUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "gpt-4"
    });

    await client.complete({
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Say hello" }
      ]
    });

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://api.example.com/v1/chat/completions");
    expect(call[1].headers["Authorization"]).toBe("Bearer test-key");
    capturedBody = JSON.parse(call[1].body);
    expect(capturedBody.model).toBe("gpt-4");
    expect(capturedBody.messages).toHaveLength(2);
  });

  it("includes json_object format when jsonMode is true", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"key":"value"}' } }]
      })
    });

    const client = new LlmClient({
      apiUrl: "https://api.example.com/v1",
      apiKey: "key",
      model: "gpt-4"
    });

    await client.complete({
      messages: [{ role: "user", content: "test" }],
      jsonMode: true
    });

    const call = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("returns parsed JSON when jsonMode is true", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"name":"test","count":42}' } }]
      })
    });

    const client = new LlmClient({
      apiUrl: "https://api.example.com/v1",
      apiKey: "key",
      model: "gpt-4"
    });

    const result = await client.complete({
      messages: [{ role: "user", content: "test" }],
      jsonMode: true
    });

    expect(result.json).toEqual({ name: "test", count: 42 });
  });

  it("handles markdown-wrapped JSON in jsonMode", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '```json\n{"name":"wrapped"}\n```' } }]
      })
    });

    const client = new LlmClient({
      apiUrl: "https://api.example.com/v1",
      apiKey: "key",
      model: "gpt-4"
    });

    const result = await client.complete({
      messages: [{ role: "user", content: "test" }],
      jsonMode: true
    });

    expect(result.json).toEqual({ name: "wrapped" });
  });

  it("returns empty content when API response has no choices", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({})
    });

    const client = new LlmClient({
      apiUrl: "https://api.example.com/v1",
      apiKey: "key",
      model: "gpt-4"
    });

    const result = await client.complete({
      messages: [{ role: "user", content: "test" }]
    });

    expect(result.content).toBe("");
  });

  it("throws on API error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"unauthorized"}'
    });

    const client = new LlmClient({
      apiUrl: "https://api.example.com/v1",
      apiKey: "bad-key",
      model: "gpt-4"
    });

    await expect(
      client.complete({
        messages: [{ role: "user", content: "test" }]
      })
    ).rejects.toThrow(/LLM API error 401/);
  });

  it("matchToJira parses structured response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify([
                { jiraKey: "PROJ-123", confidence: 0.9, reason: "Same feature" }
              ])
            }
          }
        ]
      })
    });

    const client = new LlmClient({
      apiUrl: "https://api.example.com/v1",
      apiKey: "key",
      model: "gpt-4"
    });

    const matches = await client.matchToJira({
      githubItem: { title: "Fix bug", body: "", repo: "owner/repo" },
      jiraCandidates: [{ key: "PROJ-123", summary: "Fix bug", project: "PROJ" }],
      maxMatches: 5
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].jiraKey).toBe("PROJ-123");
    expect(matches[0].confidence).toBe(0.9);
  });

  it("matchToJira limits candidates to 20", async () => {
    let capturedMessages: any = null;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "[]" } }]
      })
    });

    const client = new LlmClient({
      apiUrl: "https://api.example.com/v1",
      apiKey: "key",
      model: "gpt-4"
    });

    const candidates = Array.from({ length: 30 }, (_, i) => ({
      key: `PROJ-${i}`,
      summary: `Issue ${i}`,
      project: "PROJ"
    }));

    await client.matchToJira({
      githubItem: { title: "Test", body: "", repo: "owner/repo" },
      jiraCandidates: candidates,
      maxMatches: 10
    });

    const call = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    capturedMessages = body.messages;
    // The user message should only contain 20 candidates
    const userMsg = capturedMessages.find((m: any) => m.role === "user");
    const candidateCount = (userMsg.content.match(/PROJ-/g) || []).length;
    expect(candidateCount).toBeLessThanOrEqual(20);
  });

  it("draftJiraIssue parses structured response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Fixed the bug",
                description: "Detailed description",
                labels: ["bugfix", "backend"],
                suggestedProject: "PROJ"
              })
            }
          }
        ]
      })
    });

    const client = new LlmClient({
      apiUrl: "https://api.example.com/v1",
      apiKey: "key",
      model: "gpt-4"
    });

    const draft = await client.draftJiraIssue({
      githubItem: { title: "Fix bug", body: "Fixed it", author: "alice", repo: "owner/repo" },
      suggestedProject: "FALLBACK"
    });

    expect(draft.summary).toBe("Fixed the bug");
    expect(draft.description).toBe("Detailed description");
    expect(draft.labels).toEqual(["bugfix", "backend"]);
    expect(draft.suggestedProject).toBe("PROJ");
  });

  it("draftJiraIssue falls back to GitHub data on parse failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "not valid json" } }]
      })
    });

    const client = new LlmClient({
      apiUrl: "https://api.example.com/v1",
      apiKey: "key",
      model: "gpt-4"
    });

    const draft = await client.draftJiraIssue({
      githubItem: { title: "Fix bug", body: "Details", author: "alice", repo: "owner/repo" },
      suggestedProject: "FALLBACK"
    });

    expect(draft.summary).toBe("Fix bug");
    expect(draft.description).toBe("Details");
    expect(draft.labels).toContain("repo");
    expect(draft.suggestedProject).toBe("FALLBACK");
  });
});
