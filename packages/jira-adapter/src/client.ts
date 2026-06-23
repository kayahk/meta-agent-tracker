/**
 * Jira Data Center REST API client (v2).
 *
 * Uses Bearer PAT authentication for on-prem Data Center instances.
 */

import type { JiraClient, JiraIssue, JiraField } from "./index.js";

export interface JiraDcConfig {
  url: string; // e.g. "https://jira.example.de"
  pat: string; // Personal Access Token
}

export class HttpJiraClient implements JiraClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: JiraDcConfig) {
    // Normalize URL: remove trailing slash
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.headers = {
      Authorization: `Bearer ${config.pat}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    };
  }

  async fetchIssue(key: string): Promise<JiraIssue | null> {
    const url = `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(key)}`;
    return this.request(url);
  }

  async searchIssues(jql: string, limit: number = 50): Promise<JiraIssue[]> {
    const url = `${this.baseUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${limit}`;
    const response = await this.request<{ issues: JiraIssue[] }>(url);
    return response?.issues ?? [];
  }

  async fetchFields(): Promise<JiraField[]> {
    const url = `${this.baseUrl}/rest/api/2/field`;
    const result = await this.request<JiraField[]>(url);
    return result ?? [];
  }

  // ── Issue creation ──────────────────────────────────────────

  async createIssue(input: {
    projectId: string; // numeric project ID
    issueTypeId: string; // numeric issue type ID
    summary: string;
    description?: string;
    labels?: string[];
  }): Promise<JiraIssue | null> {
    const url = `${this.baseUrl}/rest/api/2/issue`;
    const body = {
      fields: {
        project: { id: input.projectId },
        issuetype: { id: input.issueTypeId },
        summary: input.summary,
        description: input.description ?? "",
        labels: input.labels ?? []
      }
    };

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body)
      });

      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        console.error(`Jira createIssue failed ${resp.status}: ${err.slice(0, 200)}`);
        return null;
      }

      return resp.json() as Promise<JiraIssue>;
    } catch (err) {
      console.error("Jira createIssue error:", err);
      return null;
    }
  }

  // ── Project/Type discovery ──────────────────────────────────

  async fetchProject(
    key: string
  ): Promise<{ id: string; issueTypes: { id: string; name: string }[] } | null> {
    const url = `${this.baseUrl}/rest/api/2/project/${encodeURIComponent(key)}`;
    const response = await this.request<{
      id: string;
      issueTypes?: { id: string; name: string }[];
    }>(url);
    if (!response) return null;
    return {
      id: response.id,
      issueTypes: response.issueTypes ?? []
    };
  }

  // ── HTTP helper ─────────────────────────────────────────────

  private async request<T>(url: string): Promise<T | null> {
    try {
      const resp = await fetch(url, {
        headers: this.headers,
        signal: AbortSignal.timeout(15000)
      });

      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        console.error(`Jira API ${resp.status} ${url}: ${err.slice(0, 200)}`);
        return null;
      }

      return resp.json() as Promise<T>;
    } catch (err) {
      console.error(`Jira request error ${url}:`, err);
      return null;
    }
  }
}
