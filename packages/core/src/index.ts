export type SourceName = "github" | "jira" | "confluence" | "local";

export type ExternalItemKind =
  | "issue"
  | "pull_request"
  | "story"
  | "task"
  | "doc"
  | "adr"
  | "requirement";

export interface ExternalLink {
  source: SourceName;
  externalId: string;
  url?: string;
  relationship: "relates_to" | "blocks" | "implements" | "documents" | "supersedes";
}

export interface ExternalItem {
  source: SourceName;
  externalId: string;
  url: string;
  title: string;
  kind: ExternalItemKind;
  status?: string;
  owner?: string;
  body?: string;
  updatedAt: Date;
  links: ExternalLink[];
}

export interface SourceChange {
  source: SourceName;
  externalId: string;
  changeType: string;
  occurredAt: Date;
  idempotencyKey: string;
  payload: unknown;
}

export interface LinkQuery {
  text?: string;
  url?: string;
  externalId?: string;
}

export interface WorkSourceAdapter {
  source: SourceName;
  fetchRecentChanges(since: Date): Promise<SourceChange[]>;
  fetchItem(id: string): Promise<ExternalItem | null>;
  searchLinkedItems(query: LinkQuery): Promise<ExternalItem[]>;
}
