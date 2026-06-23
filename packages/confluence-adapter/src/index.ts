import type {
  ExternalItem,
  ExternalItemKind,
  ExternalLink,
  SourceChange,
  WorkSourceAdapter
} from "@meta-agent/core";

export interface ConfluenceClient {
  fetchPage(id: string): Promise<ConfluencePage | null>;
  searchPages(query: ConfluenceSearchQuery): Promise<ConfluencePage[]>;
  fetchRecentChanges(since: Date, spaces?: string[]): Promise<ConfluenceChange[]>;
}

export interface ConfluenceSearchQuery {
  text?: string;
  spaces?: string[];
  limit?: number;
}

export interface ConfluencePage {
  id: string;
  spaceKey?: string;
  title: string;
  url: string;
  body?: string;
  version?: number;
  updatedAt: Date;
  updatedBy?: string;
  labels?: string[];
}

export interface ConfluenceChange {
  page: ConfluencePage;
  changeType: "created" | "updated" | "deleted";
}

export class NoopConfluenceClient implements ConfluenceClient {
  async fetchPage(_id: string): Promise<ConfluencePage | null> {
    return null;
  }

  async searchPages(_query: ConfluenceSearchQuery): Promise<ConfluencePage[]> {
    return [];
  }

  async fetchRecentChanges(_since: Date, _spaces?: string[]): Promise<ConfluenceChange[]> {
    return [];
  }
}

export interface HttpConfluenceClientOptions {
  url: string;
  pat: string;
  timeoutMs?: number;
}

export class HttpConfluenceClient implements ConfluenceClient {
  private readonly baseUrl: string;
  private readonly pat: string;
  private readonly timeoutMs: number;
  private readonly pageSize = 100;

  constructor(options: HttpConfluenceClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.pat = options.pat;
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  async fetchPage(id: string): Promise<ConfluencePage | null> {
    const response = await this.request(
      `/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,version,space,metadata.labels`
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Confluence fetch page failed: HTTP ${response.status}`);
    return parseConfluencePage(await response.json(), this.baseUrl);
  }

  async searchPages(query: ConfluenceSearchQuery): Promise<ConfluencePage[]> {
    const cqlParts = ["type=page"];
    if (query.text) cqlParts.push(`text ~ ${quoteCql(query.text)}`);
    if (query.spaces && query.spaces.length > 0)
      cqlParts.push(`space in (${query.spaces.map(quoteCql).join(",")})`);
    const results = await this.searchContent(cqlParts.join(" AND "), query.limit ?? 25, "search");
    return results.map((entry) => parseConfluencePage(entry, this.baseUrl));
  }

  async fetchRecentChanges(since: Date, spaces?: string[]): Promise<ConfluenceChange[]> {
    const cqlParts = ["type=page", `lastmodified >= ${quoteCql(formatConfluenceDate(since))}`];
    if (spaces && spaces.length > 0) cqlParts.push(`space in (${spaces.map(quoteCql).join(",")})`);
    const results = await this.searchContent(cqlParts.join(" AND "), undefined, "recent changes");
    return results.map((entry) => ({
      page: parseConfluencePage(entry, this.baseUrl),
      changeType: "updated" as const
    }));
  }

  private async searchContent(
    cql: string,
    maxResults: number | undefined,
    operation: string
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    let start = 0;
    while (maxResults == null || results.length < maxResults) {
      const remaining = maxResults == null ? this.pageSize : maxResults - results.length;
      const limit = Math.min(this.pageSize, remaining);
      const params = new URLSearchParams({
        cql,
        start: String(start),
        limit: String(limit),
        expand: "body.storage,version,space,metadata.labels"
      });
      const response = await this.request(`/rest/api/content/search?${params.toString()}`);
      if (!response.ok) throw new Error(`Confluence ${operation} failed: HTTP ${response.status}`);
      const payload = (await response.json()) as { results?: unknown[]; size?: number };
      const page = payload.results ?? [];
      results.push(...page);
      if (page.length < limit) break;
      start += page.length;
    }
    return results;
  }

  private async request(path: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.pat}`
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class ConfluenceAdapter implements WorkSourceAdapter {
  readonly source = "confluence" as const;

  constructor(
    private readonly client: ConfluenceClient,
    private readonly spaces: string[] = []
  ) {}

  async fetchRecentChanges(since: Date): Promise<SourceChange[]> {
    const changes = await this.client.fetchRecentChanges(since, this.spaces);
    return changes.map((change) => ({
      source: "confluence",
      externalId: confluenceExternalId(change.page),
      changeType: change.changeType,
      occurredAt: change.page.updatedAt,
      idempotencyKey: `confluence:${change.page.id}:${change.page.version ?? change.page.updatedAt.toISOString()}:${change.changeType}`,
      payload: change.page
    }));
  }

  async fetchItem(id: string): Promise<ExternalItem | null> {
    const pageId = id.startsWith("page:") ? id.slice("page:".length) : id;
    const page = await this.client.fetchPage(pageId);
    return page ? normalizeConfluencePage(page) : null;
  }

  async searchLinkedItems(query: {
    text?: string;
    url?: string;
    externalId?: string;
  }): Promise<ExternalItem[]> {
    if (query.externalId?.startsWith("page:")) {
      const item = await this.fetchItem(query.externalId);
      return item ? [item] : [];
    }
    const searchQuery: ConfluenceSearchQuery = { spaces: this.spaces };
    const text = query.text ?? query.url;
    if (text) searchQuery.text = text;
    const pages = await this.client.searchPages(searchQuery);
    return pages.map(normalizeConfluencePage);
  }
}

export function normalizeConfluencePage(page: ConfluencePage): ExternalItem {
  const body = stripConfluenceStorage(page.body ?? "");
  const item: ExternalItem = {
    source: "confluence",
    externalId: confluenceExternalId(page),
    url: page.url,
    title: page.title,
    kind: classifyConfluencePage(page),
    body,
    updatedAt: page.updatedAt,
    links: extractConfluenceLinks(`${page.title}\n${body}\n${page.url}`)
  };
  if (page.version != null) item.status = `v${page.version}`;
  if (page.updatedBy) item.owner = page.updatedBy;
  return item;
}

export function classifyConfluencePage(page: ConfluencePage): ExternalItemKind {
  const haystack = `${page.title}\n${(page.labels ?? []).join("\n")}`.toLowerCase();
  if (/\badr\b|architecture decision/.test(haystack)) return "adr";
  if (/requirement|specification|acceptance/.test(haystack)) return "requirement";
  return "doc";
}

export function extractConfluenceLinks(text: string): ExternalLink[] {
  const links = new Map<string, ExternalLink>();
  for (const match of text.toUpperCase().matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)) {
    const key = match[1];
    if (!key) continue;
    links.set(`jira:${key}`, {
      source: "jira",
      externalId: `issue:${key}`,
      relationship: "relates_to"
    });
  }
  for (const match of text.matchAll(/https:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/pull\/(\d+)/g)) {
    const repo = match[1];
    const num = match[2];
    if (!repo || !num) continue;
    links.set(`github:${repo}#${num}`, {
      source: "github",
      externalId: `pr:${repo}#${num}`,
      url: match[0],
      relationship: "documents"
    });
  }
  return [...links.values()];
}

export function stripConfluenceStorage(storage: string): string {
  return storage
    .replace(/<br\s*\/?>(\n)?/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseConfluencePage(raw: unknown, baseUrl: string): ConfluencePage {
  const record = raw as Record<string, unknown>;
  const links = (record["_links"] ?? {}) as Record<string, unknown>;
  const version = (record["version"] ?? {}) as Record<string, unknown>;
  const space = (record["space"] ?? {}) as Record<string, unknown>;
  const body = (record["body"] ?? {}) as Record<string, unknown>;
  const storage = (body["storage"] ?? {}) as Record<string, unknown>;
  const metadata = (record["metadata"] ?? {}) as Record<string, unknown>;
  const labels = (metadata["labels"] ?? {}) as Record<string, unknown>;
  const labelResults = Array.isArray(labels["results"])
    ? (labels["results"] as Array<Record<string, unknown>>)
    : [];

  const page: ConfluencePage = {
    id: stringValue(record["id"]),
    title: stringValue(record["title"]),
    url: absoluteConfluenceUrl(
      baseUrl,
      optionalString(links["webui"]) ?? optionalString(links["self"]) ?? ""
    ),
    updatedAt: dateValue(version["when"]),
    labels: labelResults
      .map((label) => optionalString(label["name"]))
      .filter((label): label is string => Boolean(label))
  };
  const spaceKey = optionalString(space["key"]);
  const bodyValue = optionalString(storage["value"]);
  const versionNumber = numberValue(version["number"]);
  const updatedBy = optionalString(
    (version["by"] as Record<string, unknown> | undefined)?.["displayName"]
  );
  if (spaceKey) page.spaceKey = spaceKey;
  if (bodyValue) page.body = bodyValue;
  if (versionNumber != null) page.version = versionNumber;
  if (updatedBy) page.updatedBy = updatedBy;
  return page;
}

function confluenceExternalId(page: ConfluencePage): string {
  return `page:${page.id}`;
}

function absoluteConfluenceUrl(baseUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

function quoteCql(value: string): string {
  return `\"${value.replace(/\\/g, "\\\\").replace(/\"/g, '\\"')}\"`;
}

function formatConfluenceDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function optionalString(value: unknown): string | undefined {
  return value == null || value === "" ? undefined : String(value);
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dateValue(value: unknown): Date {
  const raw = optionalString(value);
  return raw ? new Date(raw) : new Date();
}
