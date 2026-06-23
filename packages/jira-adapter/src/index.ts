/**
 * Phase 7: Jira Adapter (generic)
 *
 * Normalizes Jira webhook events into ledger entities,
 * and optionally delivers blocker/milestone notifications via a HermesClient.
 *
 * Design principle: keep everything generic — no hardcoded Atlassian field
 * names, no instance-specific assumptions. Custom field discovery, workflow
 * state mapping, and issue type normalization are deferred to config or
 * future runtime introspection.
 */

import { timingSafeEqual } from "node:crypto";
import type { HermesClient, HermesMessage } from "@meta-agent/hermes";
import {
  upsertWorkItem,
  getLatestPlanSnapshot,
  createPlanSnapshot,
  createMilestoneEvent,
  upsertLink,
  getLinksTo,
  hasEmittedMessage,
  recordEmittedMessage,
  type OpenedDatabase
} from "@meta-agent/storage";
import { parsePlans, diffSteps, extractMilestones } from "@meta-agent/plan-parser";

/** Header Jira webhooks must send when a shared secret is configured. */
export const JIRA_WEBHOOK_SECRET_HEADER = "x-meta-agent-jira-secret";

/**
 * Verify the shared secret on an inbound Jira webhook request.
 * Jira has no built-in HMAC signing; configure the same value as a custom
 * header on the Jira webhook and in META_AGENT_JIRA_WEBHOOK_SECRET.
 */
export function verifyJiraWebhookSecret(provided: string | undefined, secret: string): boolean {
  if (!provided || !secret) return false;
  const expected = Buffer.from(secret, "utf8");
  const actual = Buffer.from(provided, "utf8");
  if (expected.byteLength !== actual.byteLength) return false;
  return timingSafeEqual(expected, actual);
}

// ── Cross-source linking ────────────────────────────────────────

const JIRA_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const AUTHORITATIVE_LINK_ORIGINS = new Set(["deterministic", "manual"]);

function isAuthoritativeLink(link: { origin: string }): boolean {
  return AUTHORITATIVE_LINK_ORIGINS.has(link.origin);
}

/**
 * Extract Jira issue keys (e.g. "PROJ-482") from free text such as a PR
 * title, body, or branch name. Deterministic — no LLM.
 */
export function extractJiraIssueKeys(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.toUpperCase().match(JIRA_KEY_PATTERN);
  if (!matches) return [];
  return Array.from(new Set(matches));
}

/**
 * Persist cross-source links from a source item (e.g. a GitHub PR) to every
 * Jira issue key found in the provided text. Jira issues are addressed by the
 * same external id the Jira adapter uses for work items (`issue:KEY`).
 *
 * Returns the list of Jira keys that were linked.
 */
export function syncJiraLinks(
  db: OpenedDatabase,
  fromSource: string,
  fromExternalId: string,
  text: string | null | undefined,
  options: { origin?: "deterministic" | "llm_proposed" | "manual"; confidence?: number } = {}
): string[] {
  const keys = extractJiraIssueKeys(text);
  for (const key of keys) {
    upsertLink(db, {
      fromSource,
      fromExternalId,
      toSource: "jira",
      toExternalId: `issue:${key}`,
      relation: "references",
      origin: options.origin ?? "deterministic",
      confidence: options.confidence ?? null
    });
  }
  return keys;
}

// ── Client interface ────────────────────────────────────────────

/**
 * Generic Jira client interface.
 *
 * The concrete implementation (when available) can use REST API v3
 * (Atlassian Cloud) or v2 (Server/DC). This interface stays source-agnostic
 * so the adapter never depends on a specific Jira API SDK.
 */
export interface JiraClient {
  /** Fetch a single issue by key (e.g. "PROJ-123"). */
  fetchIssue(key: string): Promise<JiraIssue | null>;

  /** Search issues. The `query` is a raw JQL string. */
  searchIssues(jql: string, limit?: number): Promise<JiraIssue[]>;

  /** Fetch all fields visible to the authenticated user. */
  fetchFields(): Promise<JiraField[]>;
}

/** Generic Jira issue — only the fields needed for normalization. */
export interface JiraIssue {
  key: string;
  id: string;
  self?: string; // REST API URL
  fields: {
    summary?: string;
    description?: string; // ADF or wiki markup — normalizer handles both
    status?: { name?: string; id?: string };
    assignee?: { displayName?: string; key?: string; emailAddress?: string };
    issuetype?: { name?: string; id?: string };
    priority?: { name?: string; id?: string };
    project?: { key?: string; id?: string; name?: string };
    labels?: string[];
    components?: { name?: string; id?: string }[];
    created?: string;
    updated?: string;
  };
}

/** Generic Jira custom/standard field metadata. */
export interface JiraField {
  id: string; // e.g. "customfield_10001"
  name: string; // e.g. "Story Points"
  type?: string; // e.g. "number", "option"
}

/** Result from normalizing a Jira webhook event. */
export interface NormalizeResult {
  event: string;
  effects: EffectDescription[];
}

export interface EffectDescription {
  type: "work_item_upserted" | "plan_snapshot_created" | "milestone_created" | "requirement_drift";
  detail: string;
  delivered: boolean;
}

// ── Noop client ─────────────────────────────────────────────────

export class NoopJiraClient implements JiraClient {
  async fetchIssue(): Promise<null> {
    return null;
  }

  async searchIssues(): Promise<JiraIssue[]> {
    return [];
  }

  async fetchFields(): Promise<JiraField[]> {
    return [];
  }
}

// ── HTTP client (Jira Data Center, Bearer PAT) ─────────────────

export { HttpJiraClient, type JiraDcConfig } from "./client.js";

/**
 * Upsert a Jira issue fetched via REST into the ledger.
 * Used by the reconciliation scan to backfill missed webhooks.
 */
export function upsertJiraIssueFromApi(
  db: OpenedDatabase,
  issue: JiraIssue
): { id: number; created: boolean } {
  const key = issue.key;
  const fields = (issue.fields ?? {}) as Record<string, unknown>;
  const selfUrl = issue.self ?? "";
  const externalUrl = issueUrlFromSelf(selfUrl, key);

  const wi = upsertWorkItem(
    db,
    buildItemInput({
      source: "jira",
      externalId: `issue:${key}`,
      kind: mapIssueType(fields),
      title: str(fields["summary"]) || key,
      externalUrl,
      updatedAt: date(fields["updated"]),
      status: extractStatusName(fields),
      owner: extractAssigneeName(fields),
      body: extractDescription(fields)
    })
  );

  return { id: wi.id, created: wi.created };
}

// ── Webhook normalization ───────────────────────────────────────

type NormalizableEvent =
  | "jira:issue_created"
  | "jira:issue_updated"
  | "jira:issue_deleted"
  | "jira:worklog_updated"
  | "comment_created"
  | "comment_updated"
  | "comment_deleted"
  | "issuelink_created"
  | "issuelink_deleted";

/**
 * Generic Jira webhook payload — intentionally loose.
 * Instances differ in version (Cloud/Server), custom fields, and
 * webhook event shape. The normalizer only reaches into known-safe
 * nested paths.
 */
interface WebhookPayload {
  timestamp?: number;
  webhookEvent?: string;
  issue_event_type_name?: string;
  issue?: Record<string, unknown>;
  comment?: Record<string, unknown>;
  changelog?: {
    items?: Array<{ field?: string; fromString?: string; toString?: string }>;
  };
  user?: { displayName?: string; key?: string };
}

/**
 * Process a Jira webhook event and optionally deliver notifications via Hermes.
 * Pass `hermes` to enable live feed delivery, or omit for ledger-only mode.
 */
export async function normalizeJiraEvent(
  database: OpenedDatabase,
  event: string,
  payload: unknown,
  hermes?: HermesClient
): Promise<NormalizeResult> {
  const r: NormalizeResult = { event, effects: [] };
  if (!isNormalizableEvent(event)) return r;

  const p = (payload ?? {}) as WebhookPayload;

  switch (event) {
    case "jira:issue_created":
    case "jira:issue_updated":
      handleIssueChange(p, event, database, r, hermes);
      break;
    case "jira:issue_deleted":
      handleIssueDeleted(p, database, r);
      break;
    // Future: comment, worklog, issuelink events
    default:
      break;
  }

  return r;
}

// ── Event handlers ──────────────────────────────────────────────

function handleIssueChange(
  p: WebhookPayload,
  event: string,
  db: OpenedDatabase,
  r: NormalizeResult,
  h?: HermesClient
) {
  const issue = p.issue;
  if (!issue) return;

  const key = str(issue["key"]);
  if (!key) return;

  const projectKey = extractProjectKey(issue);
  const selfUrl = str(issue["self"]);
  const fields = (issue["fields"] ?? {}) as Record<string, unknown>;

  // Derive external URL from REST API self URL
  const externalUrl = issueUrlFromSelf(selfUrl, key);
  const title = str(fields["summary"]);
  const body = extractDescription(fields);
  const status = extractStatusName(fields);
  const owner = extractAssigneeName(fields);
  const kind = mapIssueType(fields);

  const sourceRepo = projectKey ? `${projectKey}` : "jira";

  const wi = upsertWorkItem(
    db,
    buildItemInput({
      source: "jira",
      externalId: `issue:${key}`,
      kind,
      title,
      externalUrl,
      updatedAt: date(fields["updated"]),
      status,
      owner,
      body
    })
  );

  r.effects.push({
    type: "work_item_upserted",
    detail: `Jira ${key} → ${wi.created ? "created" : "updated"}`,
    delivered: false
  });

  handlePlanBody(db, wi.id, body ?? "", externalUrl, sourceRepo, r, h);

  // Detect status transitions and requirement drift from changelog
  detectStatusTransitions(p, key, db, h, r);
  detectAcceptanceCriteriaDrift(p, key, externalUrl, db, h, r);
}

function handleIssueDeleted(p: WebhookPayload, db: OpenedDatabase, r: NormalizeResult) {
  const issue = p.issue;
  if (!issue) return;
  const key = str(issue["key"]);
  if (!key) return;

  // Mark as deleted/closing — upsert with closed status
  const selfUrl = str(issue["self"]);
  const fields = (issue["fields"] ?? {}) as Record<string, unknown>;
  const title = str(fields["summary"]);

  upsertWorkItem(
    db,
    buildItemInput({
      source: "jira",
      externalId: `issue:${key}`,
      kind: mapIssueType(fields),
      title: title || key,
      externalUrl: issueUrlFromSelf(selfUrl, key),
      updatedAt: new Date(),
      status: "deleted",
      owner: null,
      body: null
    })
  );

  r.effects.push({
    type: "work_item_upserted",
    detail: `Jira ${key} → marked deleted`,
    delivered: false
  });
}

// ── Plan body handling ──────────────────────────────────────────

function handlePlanBody(
  db: OpenedDatabase,
  workItemId: number,
  body: string,
  externalUrl: string,
  sourceRepo: string,
  r: NormalizeResult,
  h?: HermesClient
) {
  if (!body) return;
  const plans = parsePlans(body);
  if (plans.length === 0) return;

  const plan = plans[0]!;
  const prev = getLatestPlanSnapshot(db, workItemId);

  createPlanSnapshot(db, {
    workItemId,
    source: "jira",
    rawBody: plan.rawBody,
    steps: plan.steps
  });

  r.effects.push({
    type: "plan_snapshot_created",
    detail: `${plan.headingName}: ${plan.steps.length} steps`,
    delivered: false
  });

  if (prev && h) {
    const diff = diffSteps(
      prev.steps.map((s) => ({
        stepOrder: s.stepOrder,
        text: s.text,
        completed: s.completed
      })),
      plan.steps
    );
    const milestones = extractMilestones(diff);
    if (milestones.length > 0) {
      const fresh = getLatestPlanSnapshot(db, workItemId);
      if (fresh) {
        const stepIds = new Map(fresh.steps.map((s) => [s.stepOrder, s.id]));
        for (const m of milestones) {
          const sid = stepIds.get(m.stepOrder);
          if (sid == null) continue;
          createMilestoneEvent(db, {
            workItemId,
            stepId: sid,
            previousState: "incomplete",
            newState: "complete",
            occurredAt: new Date()
          });

          h.send({
            category: "milestone_reached",
            title: `Milestone: ${m.stepText}`,
            body: `Step ${m.stepOrder}: ${m.stepText} (completed)`,
            sourceUrl: externalUrl
          }).catch(() => {
            /* delivery failures are non-fatal */
          });

          r.effects.push({
            type: "milestone_created",
            detail: `✅ ${m.stepText}`,
            delivered: true
          });
        }
      }
    }
  }
}

// ── Status transition detection ─────────────────────────────────

function detectStatusTransitions(
  p: WebhookPayload,
  issueKey: string,
  db: OpenedDatabase,
  h: HermesClient | undefined,
  r: NormalizeResult
) {
  if (!p.changelog?.items || !h) return;
  for (const item of p.changelog.items) {
    if (item.field?.toLowerCase() === "status" && item.fromString && item.toString) {
      h.send({
        category: "milestone_reached",
        title: `Jira ${issueKey}: ${item.fromString} → ${item.toString}`,
        body: `Status changed from ${item.fromString} to ${item.toString}`
      }).catch(() => {});
    }
  }
}

/**
 * Alert when acceptance criteria change on a Jira issue that already has
 * linked GitHub work (implementation has started).
 */
function detectAcceptanceCriteriaDrift(
  p: WebhookPayload,
  issueKey: string,
  externalUrl: string,
  db: OpenedDatabase,
  h: HermesClient | undefined,
  r: NormalizeResult
) {
  if (!p.changelog?.items || !h) return;

  const jiraExternalId = `issue:${issueKey}`;
  if (!getLinksTo(db, jiraExternalId).some(isAuthoritativeLink)) return;

  for (const item of p.changelog.items) {
    const field = item.field?.toLowerCase() ?? "";
    if (!field.includes("acceptance")) continue;

    const fromStr = item.fromString ?? "";
    const toStr = item.toString ?? "";
    if (fromStr === toStr) continue;

    const dedupKey = `ac_changed:${issueKey}:${simpleHash(toStr)}`;
    if (hasEmittedMessage(db, dedupKey)) continue;

    const title = `Requirement drift: ${issueKey} acceptance criteria changed`;
    const body =
      `Acceptance criteria changed on ${issueKey} while linked GitHub work exists.\n` +
      `Before: ${truncate(fromStr, 200)}\n` +
      `After: ${truncate(toStr, 200)}`;

    recordEmittedMessage(db, {
      category: "requirement_drift",
      title,
      body,
      dedupKey,
      emittedAt: new Date(),
      sourceUrl: externalUrl
    });

    h.send({
      category: "requirement_drift",
      title,
      body,
      sourceUrl: externalUrl
    }).catch(() => {});

    r.effects.push({
      type: "requirement_drift",
      detail: `${issueKey}: acceptance criteria changed`,
      delivered: true
    });
  }
}

function simpleHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value || "(empty)";
  return `${value.slice(0, max)}…`;
}

// ── Input builder ────────────────────────────────────────────────

function buildItemInput(raw: {
  source: string;
  externalId: string;
  kind: string;
  title: string;
  externalUrl: string;
  updatedAt: Date;
  status: string | null;
  owner: string | null;
  body: string | null;
}) {
  const input: Record<string, unknown> = {
    source: raw.source,
    externalId: raw.externalId,
    kind: raw.kind,
    title: raw.title,
    externalUrl: raw.externalUrl,
    updatedAt: raw.updatedAt
  };
  if (raw.status !== null) input.status = raw.status;
  if (raw.owner !== null) input.owner = raw.owner;
  if (raw.body !== null) input.body = raw.body;
  return input as unknown as Parameters<typeof upsertWorkItem>[1];
}

// ── Extraction helpers (generic — no hardcoded instance specifics) ──

function isNormalizableEvent(e: string): e is NormalizableEvent {
  return [
    "jira:issue_created",
    "jira:issue_updated",
    "jira:issue_deleted",
    "jira:worklog_updated",
    "comment_created",
    "comment_updated",
    "comment_deleted",
    "issuelink_created",
    "issuelink_deleted"
  ].includes(e);
}

function str(v: unknown): string {
  return v != null ? String(v) : "";
}

function date(v: unknown): Date {
  const s = str(v);
  return s ? new Date(s) : new Date();
}

function extractProjectKey(issue: Record<string, unknown>): string | null {
  const fields = issue["fields"] as Record<string, unknown> | undefined;
  if (!fields) {
    // Fallback: parse from issue key (e.g. "PROJ-123" → "PROJ")
    const key = str(issue["key"]);
    const dash = key.indexOf("-");
    return dash > 0 ? key.slice(0, dash) : null;
  }
  const project = fields["project"] as Record<string, unknown> | undefined;
  return project ? str(project["key"]) || null : null;
}

/**
 * Derive a browsable URL from the REST API self URL.
 * e.g. "https://instance.atlassian.net/rest/api/3/issue/PROJ-123"
 *   → "https://instance.atlassian.net/browse/PROJ-123"
 */
function issueUrlFromSelf(selfUrl: string, issueKey: string): string {
  if (!selfUrl) return `https://example.atlassian.net/browse/${issueKey}`;
  try {
    const u = new URL(selfUrl);
    return `${u.protocol}//${u.host}/browse/${issueKey}`;
  } catch {
    return `https://example.atlassian.net/browse/${issueKey}`;
  }
}

/**
 * Extract human-readable description.
 * Handles ADF (Atlassian Document Format — nested JSON), wiki markup, and plain text.
 */
function extractDescription(fields: Record<string, unknown>): string | null {
  const desc = fields["description"];
  if (!desc) return null;

  // Plain text or wiki markup
  if (typeof desc === "string") return desc;

  // ADF (Atlassian Document Format) — deeply nested JSON
  if (typeof desc === "object") {
    return adfToText(desc as Record<string, unknown>);
  }

  return null;
}

/** Naive ADF-to-plain-text fallback: extract all "text" leaf nodes. */
function adfToText(node: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (n: Record<string, unknown>) => {
    if (n["text"] && typeof n["text"] === "string") {
      parts.push(n["text"]);
    }
    const content = n["content"];
    if (Array.isArray(content)) {
      for (const child of content) {
        if (child && typeof child === "object") walk(child as Record<string, unknown>);
      }
    }
  };
  walk(node);
  return parts.length > 0 ? parts.join("\n") : JSON.stringify(node);
}

function extractStatusName(fields: Record<string, unknown>): string | null {
  const status = fields["status"] as Record<string, unknown> | undefined;
  return status ? str(status["name"]) || null : null;
}

function extractAssigneeName(fields: Record<string, unknown>): string | null {
  const assignee = fields["assignee"] as Record<string, unknown> | undefined;
  if (!assignee) return null;
  return (
    str(assignee["displayName"]) || str(assignee["key"]) || str(assignee["emailAddress"]) || null
  );
}

/** Map Jira issue type to core ExternalItemKind. */
function mapIssueType(fields: Record<string, unknown>): string {
  const it = fields["issuetype"] as Record<string, unknown> | undefined;
  const name = it ? (str(it["name"]) || "").toLowerCase() : "";

  if (name === "story") return "story";
  if (name === "task" || name === "sub-task") return "task";
  if (name === "bug") return "issue";
  if (name === "epic") return "issue";
  return "issue";
}
