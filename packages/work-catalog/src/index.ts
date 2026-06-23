/**
 * Work Catalog — Phase 1
 *
 * Scans GitHub repos for open PRs/issues, matches them to Jira issues
 * via semantic LLM matching, and builds a daily digest delivered to Slack.
 */

import type { JiraClient, JiraIssue } from "@meta-agent/jira-adapter";
import type { LlmClient } from "@meta-agent/llm-client";
import type { HermesClient } from "@meta-agent/hermes";
import type { OpenedDatabase } from "@meta-agent/storage";
import type { PlanDocument } from "./plan-docs.js";

export {
  reconcileLedger,
  reconcileJiraLedger,
  reconcileWorkflowBlockers,
  reconcileAgentEvidence,
  persistCatalogLinks,
  buildStatusDigest,
  deliverStatusDigest,
  type ReconcileResult,
  type StatusDigestOptions
} from "./reconcile.js";

export {
  parsePlanDocument,
  reconcilePlanDocuments,
  planExternalId,
  isDonePlanStatus,
  type PlanDocument,
  type ParsedPlanDocument,
  type PlanStatusRow
} from "./plan-docs.js";

export {
  detectGitHubJiraDrift,
  detectJiraWithoutGithub,
  deliverDrift,
  type DriftFinding,
  type DriftType
} from "./drift.js";

export { reconcileConfluenceLedger, detectConfluenceRequirementDrift } from "./confluence.js";

// ── GitHub API types (lightweight) ──────────────────────────────

export interface GitHubPr {
  kind: "pull_request";
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  state: "open" | "closed";
  draft?: boolean | undefined;
  mergedAt?: string | null | undefined;
  user: { login?: string | undefined } | undefined;
  repo: string; // "owner/repo"
  createdAt: string;
  updatedAt: string;
  labels: Array<{ name: string }>;
}

export interface GitHubIssue {
  kind: "issue";
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  state: "open" | "closed";
  user: { login?: string | undefined } | undefined;
  repo: string;
  createdAt: string;
  updatedAt: string;
  labels: Array<{ name: string }>;
}

export interface GitHubWorkflowRun {
  repo: string;
  name: string;
  branch: string;
  conclusion: string;
  status: string;
  htmlUrl: string;
  updatedAt: string;
}

export type GitHubItem = GitHubPr | GitHubIssue;

// ── GitHub API client (REST) ────────────────────────────────────

export interface GitHubApiConfig {
  /** GitHub App authentication */
  appId: string;
  privateKeyPath: string;
  /** Single installation (legacy); use installationIds when multiple. */
  installationId?: string | undefined;
  /** One or more installation IDs — repos are matched to the first that can access them. */
  installationIds?: string[] | undefined;
  /** or a simple PAT for basic access */
  pat?: string | undefined;
}

/**
 * Lightweight GitHub REST client for scanning open PRs/issues.
 * Uses GitHub App JWT + installation token for auth.
 */
export class GitHubApiClient {
  private config: GitHubApiConfig;
  private readonly installationIds: string[];
  private readonly tokens = new Map<string, { token: string; expiry: number }>();
  private readonly repoInstallation = new Map<string, string>();

  constructor(config: GitHubApiConfig) {
    this.config = config;
    this.installationIds = config.installationIds?.length
      ? config.installationIds
      : config.installationId
        ? [config.installationId]
        : [];
  }

  /** List repositories visible to configured GitHub App installation(s). */
  async listInstalledRepos(): Promise<string[]> {
    const repos = new Set<string>();
    for (const installationId of this.installationIds) {
      const token = await this.ensureInstallationToken(installationId);
      let page = 1;
      while (page <= 10) {
        const resp = await fetch(
          `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
          {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(15000)
          }
        );
        if (!resp.ok) break;
        const data = (await resp.json()) as { repositories?: Array<{ full_name?: string }> };
        const pageRepos = data.repositories ?? [];
        for (const repo of pageRepos) {
          if (repo.full_name) repos.add(repo.full_name);
        }
        if (pageRepos.length < 100) break;
        page++;
      }
    }
    return [...repos].sort();
  }

  /**
   * Scan open PRs/issues across a list of repos.
   */
  async scanOpenPrs(repos: string[], assignees?: string[]): Promise<GitHubItem[]> {
    const results: GitHubItem[] = [];

    for (const repo of repos) {
      const token = await this.getTokenForRepo(repo);
      results.push(...(await this.fetchPrs(repo, token, "open", assignees)));

      // Fetch open issues (not PRs) and map them to the same lightweight shape.
      const issues = await this.fetchOpenIssues(repo, token, assignees);
      for (const issue of issues) {
        results.push({
          kind: "issue",
          number: issue.number,
          title: issue.title,
          body: issue.body,
          htmlUrl: issue.htmlUrl,
          state: issue.state,
          user: issue.user,
          repo: issue.repo,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          labels: issue.labels
        });
      }
    }

    return results;
  }

  /** Scan recently closed/merged PRs so completed work remains visible as evidence. */
  async scanRecentClosedPrs(
    repos: string[],
    options: { since?: Date; limitPerRepo?: number } = {}
  ): Promise<GitHubPr[]> {
    const results: GitHubPr[] = [];
    const since = options.since;
    const limitPerRepo = options.limitPerRepo ?? 50;

    for (const repo of repos) {
      const token = await this.getTokenForRepo(repo);
      const prs = await this.fetchPrs(repo, token, "closed");
      let addedForRepo = 0;
      for (const pr of prs) {
        const changedAt = new Date(pr.mergedAt ?? pr.updatedAt);
        if (since && changedAt < since) continue;
        results.push(pr);
        addedForRepo++;
        if (addedForRepo >= limitPerRepo) break;
      }
    }

    return results;
  }

  /** Scan recent completed workflow runs so stale CI blockers can be reconciled even when webhooks were missed. */
  async scanRecentWorkflowRuns(
    repos: string[],
    options: { since?: Date; limitPerRepo?: number } = {}
  ): Promise<GitHubWorkflowRun[]> {
    const results: GitHubWorkflowRun[] = [];
    const since = options.since;
    const limitPerRepo = options.limitPerRepo ?? 100;

    for (const repo of repos) {
      const token = await this.getTokenForRepo(repo);
      const params = new URLSearchParams({
        status: "completed",
        per_page: String(Math.min(limitPerRepo, 100))
      });
      const url = `https://api.github.com/repos/${repo}/actions/runs?${params}`;
      try {
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(15000)
        });
        if (!resp.ok) continue;
        const data = (await resp.json()) as { workflow_runs?: GitHubWorkflowRunResponse[] };
        for (const run of data.workflow_runs ?? []) {
          const updatedAt = run.updated_at ?? run.created_at;
          if (since && updatedAt && new Date(updatedAt) < since) continue;
          results.push({
            repo,
            name: run.name ?? "workflow",
            branch: run.head_branch ?? "",
            conclusion: run.conclusion ?? "",
            status: run.status ?? "",
            htmlUrl: run.html_url ?? "",
            updatedAt: updatedAt ?? new Date().toISOString()
          });
        }
      } catch {
        continue;
      }
    }

    return results;
  }

  /** Fetch implementation plan documents from a repo docs directory. */
  async scanPlanDocuments(
    repos: string[],
    options: { docsPath?: string } = {}
  ): Promise<PlanDocument[]> {
    const docsPath = options.docsPath ?? "docs";
    const documents: PlanDocument[] = [];

    for (const repo of repos) {
      const token = await this.getTokenForRepo(repo);
      const resp = await fetch(`https://api.github.com/repos/${repo}/contents/${docsPath}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15000)
      });
      if (!resp.ok) continue;
      const entries = (await resp.json()) as GitHubContentEntry[];
      if (!Array.isArray(entries)) continue;

      for (const entry of entries) {
        if (entry.type !== "file" || !entry.name.endsWith(".md")) continue;
        if (!/(plan|implementation)/i.test(entry.name)) continue;
        const file = await this.fetchTextFile(entry.download_url, token);
        if (file == null) continue;
        documents.push({
          repo,
          path: entry.path,
          title: titleFromFilename(entry.name),
          body: file.body,
          htmlUrl: entry.html_url,
          updatedAt: file.updatedAt
        });
      }
    }

    return documents;
  }

  private async fetchPrs(
    repo: string,
    token: string,
    state: "open" | "closed",
    assignees?: string[]
  ): Promise<GitHubPr[]> {
    const params = new URLSearchParams({
      state,
      per_page: "100",
      sort: "updated",
      direction: "desc"
    });
    if (assignees?.length) {
      for (const a of assignees) params.append("assignee", a);
    }

    const items: GitHubPr[] = [];
    let page = 1;

    while (page <= 5) {
      params.set("page", String(page));
      const url = `https://api.github.com/repos/${repo}/pulls?${params}`;
      try {
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(15000)
        });
        if (!resp.ok) break;
        const data = (await resp.json()) as GitHubPullResponse[];
        if (!Array.isArray(data) || data.length === 0) break;
        items.push(...data.map((pr) => mapPullResponse(repo, pr)));
        if (data.length < 100) break;
        page++;
      } catch {
        break;
      }
    }

    return items;
  }

  private async fetchOpenIssues(
    repo: string,
    token: string,
    assignees?: string[]
  ): Promise<GitHubIssue[]> {
    const params = new URLSearchParams({
      state: "open",
      per_page: "100",
      sort: "updated",
      direction: "desc"
    });
    if (assignees?.length) {
      for (const a of assignees) params.append("assignee", a);
    }

    const items: GitHubIssue[] = [];
    let page = 1;

    while (page <= 5) {
      params.set("page", String(page));
      const url = `https://api.github.com/repos/${repo}/issues?${params}`;
      try {
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(15000)
        });
        if (!resp.ok) break;
        const data = (await resp.json()) as GitHubIssueResponse[];
        if (!Array.isArray(data) || data.length === 0) break;
        for (const issue of data) {
          if (!("pull_request" in issue)) items.push(mapIssueResponse(repo, issue));
        }
        if (data.length < 100) break;
        page++;
      } catch {
        break;
      }
    }

    return items;
  }

  private async fetchTextFile(
    url: string,
    token: string
  ): Promise<{ body: string; updatedAt: string } | null> {
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/plain" },
        signal: AbortSignal.timeout(15000)
      });
      if (!resp.ok) return null;
      const lastModified = resp.headers.get("last-modified");
      const updatedAt =
        lastModified && !Number.isNaN(Date.parse(lastModified))
          ? new Date(lastModified).toISOString()
          : "1970-01-01T00:00:00.000Z";
      return { body: await resp.text(), updatedAt };
    } catch {
      return null;
    }
  }

  private async getTokenForRepo(repo: string): Promise<string> {
    if (this.config.pat) return this.config.pat;

    const cachedInstallation = this.repoInstallation.get(repo);
    if (cachedInstallation) {
      return this.ensureInstallationToken(cachedInstallation);
    }

    if (this.installationIds.length === 0) {
      throw new Error(
        "GitHub API access requires either a PAT or GitHub App credentials " +
          "(appId, privateKeyPath, installationId)"
      );
    }

    for (const installationId of this.installationIds) {
      const token = await this.ensureInstallationToken(installationId);
      if (await this.canAccessRepo(repo, token)) {
        this.repoInstallation.set(repo, installationId);
        return token;
      }
    }

    throw new Error(`No GitHub App installation can access repository ${repo}`);
  }

  private async ensureInstallationToken(installationId: string): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && Date.now() < cached.expiry) {
      return cached.token;
    }

    if (!this.config.appId || !this.config.privateKeyPath) {
      throw new Error(
        "GitHub API access requires either a PAT or GitHub App credentials " +
          "(appId, privateKeyPath, installationId)"
      );
    }

    const { createInstallationToken } = await import("./github-auth.js");
    const result = await createInstallationToken({
      appId: this.config.appId,
      privateKeyPath: this.config.privateKeyPath,
      installationId
    });

    this.tokens.set(installationId, {
      token: result.token,
      expiry: Date.now() + 50 * 60 * 1000
    });
    return result.token;
  }

  private async canAccessRepo(repo: string, token: string): Promise<boolean> {
    try {
      const resp = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10000)
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}

interface GitHubPullResponse {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  merged_at?: string | null;
  user?: { login?: string } | null;
  created_at: string;
  updated_at: string;
  labels?: Array<{ name: string }>;
}

interface GitHubIssueResponse {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  user?: { login?: string } | null;
  created_at: string;
  updated_at: string;
  labels?: Array<{ name: string }>;
  pull_request?: unknown;
}

interface GitHubWorkflowRunResponse {
  name?: string | null;
  head_branch?: string | null;
  conclusion?: string | null;
  status?: string | null;
  html_url?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface GitHubContentEntry {
  type: "file" | "dir" | string;
  name: string;
  path: string;
  download_url: string;
  html_url: string;
}

function mapPullResponse(repo: string, pr: GitHubPullResponse): GitHubPr {
  return {
    kind: "pull_request",
    number: pr.number,
    title: pr.title,
    body: pr.body,
    htmlUrl: pr.html_url,
    state: pr.state,
    draft: pr.draft,
    mergedAt: pr.merged_at,
    user: pr.user ?? undefined,
    repo,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    labels: pr.labels ?? []
  };
}

function mapIssueResponse(repo: string, issue: GitHubIssueResponse): GitHubIssue {
  return {
    kind: "issue",
    number: issue.number,
    title: issue.title,
    body: issue.body,
    htmlUrl: issue.html_url,
    state: issue.state,
    user: issue.user ?? undefined,
    repo,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    labels: issue.labels ?? []
  };
}

function titleFromFilename(name: string): string {
  return name
    .replace(/\.md$/i, "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

// ── Work Catalog Scanner ────────────────────────────────────────

export interface CatalogEntry {
  kind: "pr" | "issue";
  repo: string;
  number: number;
  title: string;
  author: string | undefined;
  url: string;
  updatedAt: string;
  labels: string[];
  matchedJira?: Array<{ key: string; confidence: number; reason: string }> | undefined;
  suggestedJiraDraft?:
    | {
        summary: string;
        description: string;
        labels: string[];
      }
    | undefined;
}

export interface WorkCatalogResult {
  entries: CatalogEntry[];
  totalOpenPrs: number;
  totalOpenIssues: number;
  matchedCount: number;
  unmatchedCount: number;
  jiraIssuesScanned: number;
}

/**
 * Scan GitHub repos + Jira, correlate work, and return a catalog.
 */
export async function scanWorkCatalog(options: {
  db: OpenedDatabase;
  github: GitHubApiClient;
  jira?: JiraClient | undefined;
  llm?: LlmClient | undefined;
  repos: string[];
  assignees?: string[] | undefined;
  jiraProjects?: string[] | undefined;
  maxJiraCandidates?: number | undefined;
}): Promise<WorkCatalogResult> {
  const {
    github,
    jira,
    llm,
    repos,
    assignees,
    jiraProjects = [],
    maxJiraCandidates = 30
  } = options;

  // 1. Fetch open PRs/issues from GitHub
  const openItems = await github.scanOpenPrs(repos, assignees);

  // 2. Fetch open Jira issues (if configured)
  let jiraIssues: JiraIssue[] = [];
  if (jira) {
    const jqlParts: string[] = [];
    if (jiraProjects.length) {
      jqlParts.push(`project in (${jiraProjects.join(",")})`);
    }
    jqlParts.push("status != Done AND status != Closed");
    jqlParts.push("order by updated DESC");
    jiraIssues = await jira.searchIssues(jqlParts.join(" AND "), maxJiraCandidates * 2);
  }

  const result: WorkCatalogResult = {
    entries: [],
    totalOpenPrs: 0,
    totalOpenIssues: 0,
    matchedCount: 0,
    unmatchedCount: 0,
    jiraIssuesScanned: jiraIssues.length
  };

  // 3. Build catalog entries
  for (const item of openItems) {
    const entry: CatalogEntry = {
      kind: item.kind === "pull_request" ? "pr" : "issue",
      repo: item.repo,
      number: item.number,
      title: item.title,
      author: item.user?.login,
      url: item.htmlUrl,
      updatedAt: item.updatedAt,
      labels: item.labels.map((l) => l.name)
    };

    if (entry.kind === "pr") result.totalOpenPrs++;
    else result.totalOpenIssues++;

    // 4. Semantic match to Jira (if LLM + Jira configured)
    if (llm && jiraIssues.length > 0) {
      const matches = await llm.matchToJira({
        githubItem: { title: item.title, body: item.body ?? undefined, repo: item.repo },
        jiraCandidates: jiraIssues.map((ji) => ({
          key: ji.key,
          summary: ji.fields.summary ?? "",
          project: ji.fields.project?.key
        })),
        maxMatches: 2
      });

      if (matches.length > 0) {
        // Map jiraKey → key
        entry.matchedJira = matches.map((m) => ({
          key: m.jiraKey,
          confidence: m.confidence,
          reason: m.reason
        }));
        result.matchedCount++;
      } else {
        const draft = await llm.draftJiraIssue({
          githubItem: {
            title: item.title,
            body: item.body ?? undefined,
            repo: item.repo,
            author: item.user?.login
          }
        });
        entry.suggestedJiraDraft = draft;
        result.unmatchedCount++;
      }
    } else {
      result.unmatchedCount++;
    }

    result.entries.push(entry);
  }

  return result;
}

// ── Digest Builder ──────────────────────────────────────────────

/**
 * Build a Slack-friendly digest message from the work catalog.
 */
export function buildDigestMessage(
  catalog: WorkCatalogResult,
  timestamp: Date = new Date()
): {
  category: "daily_digest";
  title: string;
  body: string;
} {
  const lines: string[] = [];
  lines.push(`*Work Catalog — ${timestamp.toISOString().slice(0, 10)}*`);
  lines.push("");

  lines.push(
    `_Open PRs: ${catalog.totalOpenPrs} | Open Issues: ${catalog.totalOpenIssues} | Jira scanned: ${catalog.jiraIssuesScanned}_`
  );
  lines.push("");

  if (catalog.entries.length === 0) {
    lines.push("No open work found.");
    return {
      category: "daily_digest",
      title: "Work Catalog",
      body: lines.join("\n")
    };
  }

  // Group by repo
  const byRepo = new Map<string, CatalogEntry[]>();
  for (const entry of catalog.entries) {
    const arr = byRepo.get(entry.repo) ?? [];
    arr.push(entry);
    byRepo.set(entry.repo, arr);
  }

  const repoEntries = Array.from(byRepo.entries());
  for (const [repo, entries] of repoEntries) {
    lines.push(`📦 *${repo}*`);

    for (const e of entries) {
      const kindIcon = e.kind === "pr" ? "🔀" : "📋";
      const author = e.author ? ` by ${e.author}` : "";
      lines.push(
        `  ${kindIcon} <${e.url}|${e.kind === "pr" ? "PR" : "Issue"} #${e.number}>: ${e.title}${author}`
      );

      if (e.matchedJira?.length) {
        for (const m of e.matchedJira) {
          const conf = Math.round(m.confidence * 100);
          lines.push(`    → ${m.key} (${conf}%): ${m.reason}`);
        }
      } else if (e.suggestedJiraDraft) {
        lines.push(`    ✍️ Suggested: "${e.suggestedJiraDraft.summary}"`);
      } else {
        lines.push(`    ⚠️ No Jira match`);
      }
    }

    lines.push("");
  }

  lines.push(`_Matched: ${catalog.matchedCount} | Unmatched: ${catalog.unmatchedCount}_`);

  return {
    category: "daily_digest",
    title: "Work Catalog Digest",
    body: lines.join("\n")
  };
}

/**
 * Send the digest to Slack via Hermes.
 */
export async function deliverDigest(
  hermes: HermesClient,
  catalog: WorkCatalogResult
): Promise<boolean> {
  const message = buildDigestMessage(catalog);
  return hermes.send(message);
}
