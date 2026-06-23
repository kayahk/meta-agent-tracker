/**
 * LLM client for semantic matching and issue drafting.
 *
 * Talks to an OpenAI-compatible API endpoint (OpenRouter, local, or custom provider).
 * Supports structured JSON output for programmatic consumption.
 */

export interface LlmClientConfig {
  /** API base URL (e.g., "https://api.openrouter.ai/v1" or "http://127.0.0.1:8645/v1") */
  apiUrl: string;
  /** API key */
  apiKey: string;
  /** Model name (e.g., "anthropic/claude-sonnet-4") */
  model: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompletionOptions {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /** If true, expect and parse JSON response */
  jsonMode?: boolean;
}

export interface LlmResponse {
  content: string;
  /** Parsed JSON if jsonMode was true */
  json?: unknown;
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * Minimal OpenAI-compatible LLM client.
 * Works with any provider that implements the Chat Completions API.
 */
export class LlmClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(config: LlmClientConfig) {
    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  async complete(options: LlmCompletionOptions): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2048
    };

    if (options.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      throw new Error(`LLM API error ${resp.status}: ${err.slice(0, 300)}`);
    }

    const data = await resp.json();
    const content = (data as any)?.choices?.[0]?.message?.content ?? "";

    const result: LlmResponse = { content };

    if ((data as any)?.usage) {
      result.usage = {
        promptTokens: (data as any).usage.prompt_tokens ?? 0,
        completionTokens: (data as any).usage.completion_tokens ?? 0
      };
    }

    if (options.jsonMode && content) {
      try {
        result.json = JSON.parse(content);
      } catch {
        // JSON mode sometimes wraps in markdown code blocks
        const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (match) {
          try {
            result.json = JSON.parse(match[1]);
          } catch {
            /* leave as-is */
          }
        }
      }
    }

    return result;
  }

  /**
   * Semantic matching: given a GitHub PR/issue description, find the most
   * likely matching Jira issues from a candidate set.
   */
  async matchToJira(options: {
    githubItem: { title: string; body: string | undefined; repo: string | undefined };
    jiraCandidates: Array<{ key: string; summary: string; project: string | undefined }>;
    maxMatches: number;
  }): Promise<Array<{ jiraKey: string; confidence: number; reason: string }>> {
    const candidates = options.jiraCandidates.slice(0, 20); // limit to avoid token overflow

    const response = await this.complete({
      jsonMode: true,
      messages: [
        {
          role: "system",
          content: `You are a work-catalog assistant that matches GitHub pull requests and issues to Jira tickets.
Given a GitHub item and a list of candidate Jira issues, identify the most likely matches.
Return a JSON array of matches, each with jiraKey, confidence (0-1), and reason.
Only include matches where confidence >= 0.5. Return empty array if no good match.
Max matches: ${options.maxMatches}.`
        },
        {
          role: "user",
          content: `GitHub item (${options.githubItem.repo ?? "unknown"}):
Title: ${options.githubItem.title}
${options.githubItem.body ? `Body: ${options.githubItem.body.slice(0, 1500)}` : ""}

Candidate Jira issues:
${candidates.map((c) => `- ${c.key}: ${c.summary}${c.project ? ` [${c.project}]` : ""}`).join("\n")}`
        }
      ],
      maxTokens: 1024
    });

    // Parse response
    const matches: Array<{ jiraKey: string; confidence: number; reason: string }> = [];
    if (response.json && Array.isArray(response.json)) {
      for (const item of response.json) {
        if (typeof item === "object" && item && "jiraKey" in item) {
          matches.push({
            jiraKey: String(item.jiraKey),
            confidence: Number(item.confidence) ?? 0,
            reason: String(item.reason ?? "")
          });
        }
      }
    }
    return matches;
  }

  /**
   * Draft a Jira issue from a GitHub PR/issue.
   */
  async draftJiraIssue(options: {
    githubItem: {
      title: string;
      body: string | undefined;
      repo: string | undefined;
      author: string | undefined;
    };
    suggestedProject?: string | undefined;
  }): Promise<{
    summary: string;
    description: string;
    labels: string[];
    suggestedProject?: string | undefined;
  }> {
    const response = await this.complete({
      jsonMode: true,
      messages: [
        {
          role: "system",
          content: `You are a work-catalog assistant. Given a GitHub pull request or issue,
draft a Jira ticket that captures the work being done.
Return a JSON object with: summary (concise title), description (detailed, includes GitHub context),
labels (array of strings), suggestedProject (project key if identifiable).`
        },
        {
          role: "user",
          content: `GitHub item (${options.githubItem.repo ?? "unknown"}) by ${options.githubItem.author ?? "unknown"}:
Title: ${options.githubItem.title}
${options.githubItem.body ? `Body: ${options.githubItem.body.slice(0, 2000)}` : ""}`
        }
      ],
      maxTokens: 1024
    });

    if (response.json && typeof response.json === "object") {
      const j = response.json as Record<string, unknown>;
      return {
        summary: String(j.summary ?? options.githubItem.title),
        description: String(j.description ?? options.githubItem.body ?? ""),
        labels: Array.isArray(j.labels) ? j.labels.map(String) : [],
        suggestedProject:
          typeof j.suggestedProject === "string" ? j.suggestedProject : options.suggestedProject
      };
    }

    // Fallback
    return {
      summary: options.githubItem.title,
      description: options.githubItem.body ?? "",
      labels: options.githubItem.repo ? [options.githubItem.repo.split("/").pop() ?? ""] : [],
      suggestedProject: options.suggestedProject
    };
  }
}

/** No-op client for when LLM is not configured */
export class NoopLlmClient extends LlmClient {
  constructor() {
    super({ apiUrl: "", apiKey: "", model: "none" });
  }

  async complete(): Promise<LlmResponse> {
    return { content: "" };
  }

  async matchToJira(): Promise<[]> {
    return [];
  }

  async draftJiraIssue(): Promise<{
    summary: string;
    description: string;
    labels: string[];
    suggestedProject?: string;
  }> {
    return { summary: "", description: "", labels: [] };
  }
}
