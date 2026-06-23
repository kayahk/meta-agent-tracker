import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { eq, and, isNull, desc, lt, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export interface OpenedDatabase {
  path: string;
  sqlite: Database.Database;
  db: ReturnType<typeof drizzle<typeof schema>>;
}

export function openDatabase(databaseUrl: string): OpenedDatabase {
  const root = process.env.META_AGENT_ROOT ?? process.env.INIT_CWD ?? process.cwd();
  const path = isAbsolute(databaseUrl) ? databaseUrl : resolve(root, databaseUrl);
  mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");

  return {
    path,
    sqlite,
    db: drizzle(sqlite, { schema })
  };
}

// ── Source Changes ──────────────────────────────────────────────

export type AgentEventConfidence =
  | "agent_claimed"
  | "agent_observed"
  | "system_observed"
  | "verified"
  | "manual_override";

export interface UpsertAgentSessionInput {
  externalSessionId: string;
  agent: string;
  platform?: string | undefined;
  threadId?: string | undefined;
  initialTask?: string | undefined;
  status?: string | undefined;
  summary?: string | undefined;
  startedAt?: Date | undefined;
  endedAt?: Date | undefined;
}

export interface RecordAgentEventInput {
  agent: string;
  externalSessionId?: string | undefined;
  eventType: string;
  task: string;
  status?: string | undefined;
  confidence?: AgentEventConfidence | undefined;
  ledgerTopic?: string | undefined;
  repo?: string | undefined;
  branch?: string | undefined;
  prUrl?: string | undefined;
  commitSha?: string | undefined;
  jiraKey?: string | undefined;
  planRepo?: string | undefined;
  planPath?: string | undefined;
  planItems?: string[] | undefined;
  evidence?: unknown[] | undefined;
  payload: unknown;
  idempotencyKey?: string | undefined;
  occurredAt: Date;
}

export function upsertAgentSession(database: OpenedDatabase, input: UpsertAgentSessionInput) {
  const now = new Date().toISOString();
  const existing = database.db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.externalSessionId, input.externalSessionId))
    .get();

  const values = {
    agent: input.agent,
    platform: input.platform,
    threadId: input.threadId,
    initialTask: input.initialTask,
    status: input.status ?? "active",
    summary: input.summary,
    startedAt: (input.startedAt ?? new Date()).toISOString(),
    endedAt: input.endedAt?.toISOString(),
    updatedAt: now
  };

  if (existing) {
    const { startedAt: _startedAt, ...updateValues } = values;
    database.db
      .update(schema.agentSessions)
      .set(updateValues)
      .where(eq(schema.agentSessions.id, existing.id))
      .run();
    return { id: existing.id, created: false };
  }

  const result = database.db
    .insert(schema.agentSessions)
    .values({
      externalSessionId: input.externalSessionId,
      ...values,
      createdAt: now
    })
    .returning({ id: schema.agentSessions.id })
    .get();

  return { id: result!.id, created: true };
}

export function recordAgentEvent(database: OpenedDatabase, input: RecordAgentEventInput) {
  const now = new Date().toISOString();
  let sessionId: number | undefined;
  if (input.externalSessionId) {
    sessionId = upsertAgentSession(database, {
      externalSessionId: input.externalSessionId,
      agent: input.agent,
      initialTask: input.task,
      startedAt: input.occurredAt
    }).id;
  }

  const result = database.db
    .insert(schema.agentEvents)
    .values({
      sessionId,
      agent: input.agent,
      externalSessionId: input.externalSessionId,
      eventType: input.eventType,
      task: input.task,
      status: input.status,
      confidence: input.confidence ?? "agent_claimed",
      ledgerTopic: input.ledgerTopic,
      repo: input.repo,
      branch: input.branch,
      prUrl: input.prUrl,
      commitSha: input.commitSha,
      jiraKey: input.jiraKey,
      planRepo: input.planRepo,
      planPath: input.planPath,
      planItemsJson: input.planItems ? JSON.stringify(input.planItems) : undefined,
      evidenceJson: input.evidence ? JSON.stringify(input.evidence) : undefined,
      payloadJson: JSON.stringify(input.payload),
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.occurredAt.toISOString(),
      ingestedAt: now
    })
    .onConflictDoNothing({ target: schema.agentEvents.idempotencyKey })
    .returning({ id: schema.agentEvents.id })
    .get();

  return { id: result?.id ?? null, created: result != null };
}

export interface AgentEventRow {
  id: number;
  agent: string;
  externalSessionId: string | null;
  eventType: string;
  task: string;
  status: string | null;
  confidence: AgentEventConfidence;
  ledgerTopic: string | null;
  repo: string | null;
  branch: string | null;
  prUrl: string | null;
  commitSha: string | null;
  jiraKey: string | null;
  planRepo: string | null;
  planPath: string | null;
  planItemsJson: string | null;
  evidenceJson: string | null;
  payloadJson: string;
  occurredAt: string;
  ingestedAt: string;
}

export function getRecentAgentEvents(database: OpenedDatabase, limit = 50): AgentEventRow[] {
  return database.sqlite
    .prepare(
      `SELECT id, agent, external_session_id AS externalSessionId, event_type AS eventType,
              task, status, confidence, ledger_topic AS ledgerTopic, repo, branch,
              pr_url AS prUrl, commit_sha AS commitSha, jira_key AS jiraKey,
              plan_repo AS planRepo, plan_path AS planPath, plan_items_json AS planItemsJson,
              evidence_json AS evidenceJson, payload_json AS payloadJson,
              occurred_at AS occurredAt, ingested_at AS ingestedAt
       FROM agent_events
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`
    )
    .all(limit) as AgentEventRow[];
}

export function getRecentAgentEvidenceSignals(
  database: OpenedDatabase,
  options: { limit?: number; since?: Date } = {}
): AgentEventRow[] {
  const limit = options.limit ?? 10;
  const since = (options.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)).toISOString();
  return database.sqlite
    .prepare(
      `SELECT id, agent, external_session_id AS externalSessionId, event_type AS eventType,
              task, status, confidence, ledger_topic AS ledgerTopic, repo, branch,
              pr_url AS prUrl, commit_sha AS commitSha, jira_key AS jiraKey,
              plan_repo AS planRepo, plan_path AS planPath, plan_items_json AS planItemsJson,
              evidence_json AS evidenceJson, payload_json AS payloadJson,
              occurred_at AS occurredAt, ingested_at AS ingestedAt
       FROM agent_events
       WHERE occurred_at >= ?
         AND event_type IN (
           'pr_opened', 'commit_pushed', 'tests_passed', 'tests_failed',
           'runtime_verified', 'blocker_resolved_claimed',
           'plan_status_stale_suspected', 'task_completed_claimed'
         )
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`
    )
    .all(since, limit) as AgentEventRow[];
}

export function updateAgentEventConfidence(
  database: OpenedDatabase,
  eventId: number,
  confidence: AgentEventConfidence,
  evidence: unknown[] | undefined
) {
  database.db
    .update(schema.agentEvents)
    .set({
      confidence,
      evidenceJson: evidence ? JSON.stringify(evidence) : undefined
    })
    .where(eq(schema.agentEvents.id, eventId))
    .run();
}

export interface RecordSourceChangeInput {
  source: string;
  externalId: string;
  changeType: string;
  idempotencyKey: string;
  occurredAt: Date;
  payloadJson: string;
}

export function recordSourceChange(database: OpenedDatabase, input: RecordSourceChangeInput) {
  const now = new Date().toISOString();

  return database.db
    .insert(schema.sourceChanges)
    .values({
      source: input.source,
      externalId: input.externalId,
      changeType: input.changeType,
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.occurredAt.toISOString(),
      payloadJson: input.payloadJson,
      createdAt: now
    })
    .onConflictDoNothing({ target: schema.sourceChanges.idempotencyKey })
    .run();
}

// ── Work Items ───────────────────────────────────────────────────

export interface UpsertWorkItemInput {
  source: string;
  externalId: string;
  kind: string;
  title: string;
  status?: string;
  owner?: string;
  body?: string;
  externalUrl: string;
  updatedAt: Date;
}

export function upsertWorkItem(database: OpenedDatabase, input: UpsertWorkItemInput) {
  const now = new Date().toISOString();
  const existing = database.db
    .select({ id: schema.workItems.id, body: schema.workItems.body })
    .from(schema.workItems)
    .where(
      and(
        eq(schema.workItems.source, input.source),
        eq(schema.workItems.externalId, input.externalId)
      )
    )
    .get();

  if (existing) {
    database.db
      .update(schema.workItems)
      .set({
        kind: input.kind,
        title: input.title,
        status: input.status,
        owner: input.owner,
        body: input.body,
        externalUrl: input.externalUrl,
        updatedAt: input.updatedAt.toISOString()
      })
      .where(eq(schema.workItems.id, existing.id))
      .run();
    return { id: existing.id, created: false };
  }

  const result = database.db
    .insert(schema.workItems)
    .values({
      source: input.source,
      externalId: input.externalId,
      kind: input.kind,
      title: input.title,
      status: input.status,
      owner: input.owner,
      body: input.body,
      externalUrl: input.externalUrl,
      updatedAt: input.updatedAt.toISOString(),
      createdAt: now
    })
    .returning({ id: schema.workItems.id })
    .get();

  return { id: result!.id, created: true };
}

export function getWorkItemByExternalId(
  database: OpenedDatabase,
  source: string,
  externalId: string
) {
  return database.db
    .select({ id: schema.workItems.id })
    .from(schema.workItems)
    .where(and(eq(schema.workItems.source, source), eq(schema.workItems.externalId, externalId)))
    .get();
}

/** Fetch the full work item row by (source, externalId), or undefined. */
export function getWorkItem(database: OpenedDatabase, source: string, externalId: string) {
  return database.db
    .select()
    .from(schema.workItems)
    .where(and(eq(schema.workItems.source, source), eq(schema.workItems.externalId, externalId)))
    .get();
}

// ── Plan Snapshots ───────────────────────────────────────────────

export interface CreatePlanSnapshotInput {
  workItemId: number;
  source: string;
  rawBody: string;
  steps: { stepOrder: number; text: string; completed: boolean }[];
}

export function createPlanSnapshot(database: OpenedDatabase, input: CreatePlanSnapshotInput) {
  const now = new Date().toISOString();

  const snapshot = database.db
    .insert(schema.planSnapshots)
    .values({
      workItemId: input.workItemId,
      source: input.source,
      parsedAt: now,
      rawBody: input.rawBody,
      stepCount: input.steps.length,
      createdAt: now
    })
    .returning({ id: schema.planSnapshots.id })
    .get();

  for (const step of input.steps) {
    database.db
      .insert(schema.planSteps)
      .values({
        snapshotId: snapshot!.id,
        stepOrder: step.stepOrder,
        text: step.text,
        completed: step.completed
      })
      .run();
  }

  return snapshot!.id;
}

export function getLatestPlanSnapshot(database: OpenedDatabase, workItemId: number) {
  const snapshot = database.db
    .select()
    .from(schema.planSnapshots)
    .where(eq(schema.planSnapshots.workItemId, workItemId))
    .orderBy(desc(schema.planSnapshots.parsedAt))
    .limit(1)
    .get();

  if (!snapshot) return null;

  const steps = database.db
    .select()
    .from(schema.planSteps)
    .where(eq(schema.planSteps.snapshotId, snapshot.id))
    .orderBy(schema.planSteps.stepOrder)
    .all();

  return { snapshot, steps };
}

// ── Milestone Events ────────────────────────────────────────────

export interface CreateMilestoneEventInput {
  workItemId: number;
  stepId: number;
  previousState: string;
  newState: string;
  occurredAt: Date;
}

export function createMilestoneEvent(database: OpenedDatabase, input: CreateMilestoneEventInput) {
  const now = new Date().toISOString();

  return database.db
    .insert(schema.milestoneEvents)
    .values({
      workItemId: input.workItemId,
      stepId: input.stepId,
      previousState: input.previousState,
      newState: input.newState,
      occurredAt: input.occurredAt.toISOString(),
      createdAt: now
    })
    .returning({ id: schema.milestoneEvents.id })
    .get();
}

export function getUnemittedMilestones(database: OpenedDatabase) {
  return database.db
    .select()
    .from(schema.milestoneEvents)
    .where(eq(schema.milestoneEvents.emitted, false))
    .all();
}

export function markMilestoneEmitted(database: OpenedDatabase, id: number) {
  database.db
    .update(schema.milestoneEvents)
    .set({ emitted: true })
    .where(eq(schema.milestoneEvents.id, id))
    .run();
}

// ── Blockers ─────────────────────────────────────────────────────

export interface CreateBlockerInput {
  workItemId?: number | null;
  sourceChangeId?: number;
  type: string;
  title: string;
  detail?: string;
  occurredAt: Date;
}

export function createBlocker(database: OpenedDatabase, input: CreateBlockerInput) {
  const now = new Date().toISOString();

  return database.db
    .insert(schema.blockers)
    .values({
      workItemId: input.workItemId ?? null,
      sourceChangeId: input.sourceChangeId,
      type: input.type,
      status: "active",
      title: input.title,
      detail: input.detail,
      occurredAt: input.occurredAt.toISOString(),
      createdAt: now
    })
    .returning({ id: schema.blockers.id })
    .get();
}

/**
 * Find an active blocker matching a given type and title.
 * Used to avoid creating duplicate active blockers when the same
 * pipeline fails repeatedly (e.g. flaky reruns).
 */
export function findActiveBlocker(database: OpenedDatabase, type: string, title: string) {
  return database.db
    .select()
    .from(schema.blockers)
    .where(
      and(
        eq(schema.blockers.status, "active"),
        eq(schema.blockers.type, type),
        eq(schema.blockers.title, title)
      )
    )
    .get();
}

export function getActiveBlockers(database: OpenedDatabase) {
  return database.db
    .select()
    .from(schema.blockers)
    .where(eq(schema.blockers.status, "active"))
    .all();
}

export function resolveBlocker(database: OpenedDatabase, blockerId: number, resolvedAt: Date) {
  database.db
    .update(schema.blockers)
    .set({
      status: "resolved",
      resolvedAt: resolvedAt.toISOString()
    })
    .where(eq(schema.blockers.id, blockerId))
    .run();
}

// ── Emitted Feed Messages ────────────────────────────────────────

export interface RecordEmittedMessageInput {
  category: string;
  title: string;
  body: string;
  sourceUrl?: string;
  dedupKey: string;
  emittedAt: Date;
}

export function recordEmittedMessage(database: OpenedDatabase, input: RecordEmittedMessageInput) {
  const now = new Date().toISOString();

  return database.db
    .insert(schema.emittedFeedMessages)
    .values({
      category: input.category,
      title: input.title,
      body: input.body,
      sourceUrl: input.sourceUrl,
      dedupKey: input.dedupKey,
      emittedAt: input.emittedAt.toISOString(),
      createdAt: now
    })
    .onConflictDoNothing({ target: schema.emittedFeedMessages.dedupKey })
    .run();
}

/**
 * Atomically claim a feed-message dedup key before delivery.
 * Returns false when another handler/process has already claimed or emitted it.
 */
export function claimEmittedMessage(
  database: OpenedDatabase,
  input: RecordEmittedMessageInput
): boolean {
  const result = recordEmittedMessage(database, input) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

/** Remove a claimed feed-message key after delivery failure so a later attempt can retry. */
export function removeEmittedMessageClaim(database: OpenedDatabase, dedupKey: string): void {
  database.sqlite.prepare("DELETE FROM emitted_feed_messages WHERE dedup_key = ?").run(dedupKey);
}

/** Whether a feed message with this dedup key has already been emitted. */
export function hasEmittedMessage(database: OpenedDatabase, dedupKey: string): boolean {
  const row = database.db
    .select({ id: schema.emittedFeedMessages.id })
    .from(schema.emittedFeedMessages)
    .where(eq(schema.emittedFeedMessages.dedupKey, dedupKey))
    .get();
  return row != null;
}

// ── Cross-source Links ──────────────────────────────────────────

export interface UpsertLinkInput {
  fromSource: string;
  fromExternalId: string;
  toSource: string;
  toExternalId: string;
  relation?: string;
  origin?: "deterministic" | "llm_proposed" | "manual";
  confidence?: number | null;
}

/**
 * Record a cross-source link (e.g. a GitHub PR references a Jira issue).
 * Idempotent on the (fromExternalId, toExternalId) pair.
 */
export function upsertLink(database: OpenedDatabase, input: UpsertLinkInput) {
  const now = new Date().toISOString();

  return database.db
    .insert(schema.links)
    .values({
      fromSource: input.fromSource,
      fromExternalId: input.fromExternalId,
      toSource: input.toSource,
      toExternalId: input.toExternalId,
      relation: input.relation ?? "references",
      origin: input.origin ?? "deterministic",
      confidence: input.confidence ?? null,
      createdAt: now
    })
    .onConflictDoNothing({
      target: [schema.links.fromExternalId, schema.links.toExternalId]
    })
    .run();
}

export function getLinksFrom(database: OpenedDatabase, fromExternalId: string) {
  return database.db
    .select()
    .from(schema.links)
    .where(eq(schema.links.fromExternalId, fromExternalId))
    .all();
}

export function getLinksBySource(database: OpenedDatabase, fromSource: string) {
  return database.db
    .select()
    .from(schema.links)
    .where(eq(schema.links.fromSource, fromSource))
    .all();
}

/** Links pointing at a given external id (e.g. all GitHub PRs referencing a Jira issue). */
export function getLinksTo(database: OpenedDatabase, toExternalId: string) {
  return database.db
    .select()
    .from(schema.links)
    .where(eq(schema.links.toExternalId, toExternalId))
    .all();
}

const ACTIVE_WORK_STATUSES = ["open", "draft"] as const;

// ── Active Work Queries ─────────────────────────────────────────

export interface ActiveWorkQuery {
  /** Filter by assignee login(s). Omit or empty = all. */
  assignees?: string[];
  /** Filter by source (e.g. "github"). Omit or empty = all. */
  source?: string;
  /** Filter by repository full_name(s). Omit or empty = all. */
  repositoryNames?: string[];
  /** Maximum results (default 100). */
  limit?: number;
}

export function getActiveWorkItems(database: OpenedDatabase, query: ActiveWorkQuery = {}) {
  let q = database.db
    .select()
    .from(schema.workItems)
    .where(inArray(schema.workItems.status, [...ACTIVE_WORK_STATUSES]))
    .orderBy(desc(schema.workItems.updatedAt));

  // Drizzle doesn't support dynamic where easily, so filter in JS
  const rows = q.all();
  const limit = query.limit ?? 100;

  let filtered = rows;
  if (query.assignees && query.assignees.length > 0) {
    filtered = filtered.filter((r) => r.owner != null && query.assignees!.includes(r.owner));
  }
  if (query.source && query.source.length > 0) {
    filtered = filtered.filter((r) => r.source === query.source);
  }
  if (query.repositoryNames && query.repositoryNames.length > 0) {
    filtered = filtered.filter((r) => {
      // external_id format: "issue:owner/repo#123" or "pr:owner/repo#456"
      const parts = r.externalId.split(":");
      if (parts.length < 2) return false;
      const id = parts[1];
      if (!id) return false;
      const hashIdx = id.lastIndexOf("#");
      const repoName = hashIdx >= 0 ? id.substring(0, hashIdx) : id;
      return query.repositoryNames!.includes(repoName);
    });
  }

  return filtered.slice(0, limit);
}

// ── Dashboard aggregation queries ───────────────────────────────

export interface DashboardStats {
  openItems: number;
  activeBlockers: number;
  recentMilestones: number;
}

export interface RecentMilestone {
  id: number;
  workItemTitle: string;
  workItemUrl: string;
  stepText: string;
  stepOrder: number;
  occurredAt: string;
}

export function getDashboardStats(database: OpenedDatabase): DashboardStats {
  const openCount = database.sqlite
    .prepare("SELECT COUNT(*) as cnt FROM work_items WHERE status IN ('open', 'draft')")
    .get() as { cnt: number };

  const blockerCount = database.sqlite
    .prepare("SELECT COUNT(*) as cnt FROM blockers WHERE status = 'active'")
    .get() as { cnt: number };

  const milestoneCount = database.sqlite
    .prepare("SELECT COUNT(*) as cnt FROM milestone_events ORDER BY occurred_at DESC LIMIT 30")
    .get() as { cnt: number };

  return {
    openItems: openCount.cnt,
    activeBlockers: blockerCount.cnt,
    recentMilestones: milestoneCount.cnt
  };
}

export function getRecentMilestones(database: OpenedDatabase, limit = 10): RecentMilestone[] {
  return database.sqlite
    .prepare(
      `SELECT
        me.id,
        wi.title AS workItemTitle,
        wi.external_url AS workItemUrl,
        ps.text AS stepText,
        ps.step_order AS stepOrder,
        me.occurred_at AS occurredAt
      FROM milestone_events me
      JOIN work_items wi ON wi.id = me.work_item_id
      JOIN plan_steps ps ON ps.id = me.step_id
      ORDER BY me.occurred_at DESC
      LIMIT ?`
    )
    .all(limit) as RecentMilestone[];
}

export interface StaleWorkItem {
  id: number;
  source: string;
  externalId: string;
  kind: string;
  title: string;
  status: string | null;
  owner: string | null;
  externalUrl: string;
  updatedAt: string;
}

/**
 * Open work items whose last observed change is older than `olderThanDays`.
 * Used for "needs attention" digest entries (stalled work).
 */
export function getStaleWorkItems(database: OpenedDatabase, olderThanDays = 2): StaleWorkItem[] {
  const threshold = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

  return database.db
    .select({
      id: schema.workItems.id,
      source: schema.workItems.source,
      externalId: schema.workItems.externalId,
      kind: schema.workItems.kind,
      title: schema.workItems.title,
      status: schema.workItems.status,
      owner: schema.workItems.owner,
      externalUrl: schema.workItems.externalUrl,
      updatedAt: schema.workItems.updatedAt
    })
    .from(schema.workItems)
    .where(
      and(
        inArray(schema.workItems.status, [...ACTIVE_WORK_STATUSES]),
        lt(schema.workItems.updatedAt, threshold)
      )
    )
    .orderBy(schema.workItems.updatedAt)
    .all();
}

export interface ActiveBlockerWithItem {
  id: number;
  type: string;
  title: string;
  detail: string | null;
  occurredAt: string;
  workItemId: number | null;
  workItemTitle: string | null;
  workItemUrl: string | null;
}

/**
 * Active blockers joined to their linked work item (when one is known).
 */
export function getActiveBlockersWithItems(database: OpenedDatabase): ActiveBlockerWithItem[] {
  return database.sqlite
    .prepare(
      `SELECT
        b.id,
        b.type,
        b.title,
        b.detail,
        b.occurred_at AS occurredAt,
        b.work_item_id AS workItemId,
        wi.title AS workItemTitle,
        wi.external_url AS workItemUrl
      FROM blockers b
      LEFT JOIN work_items wi ON wi.id = b.work_item_id
      WHERE b.status = 'active'
      ORDER BY b.occurred_at DESC`
    )
    .all() as ActiveBlockerWithItem[];
}

export function getWorkItemsWithBlockers(database: OpenedDatabase, limit = 20) {
  return database.sqlite
    .prepare(
      `SELECT
        wi.id,
        wi.title,
        wi.status,
        wi.owner,
        wi.kind,
        wi.external_url AS externalUrl,
        wi.external_id AS externalId,
        wi.updated_at AS updatedAt,
        COUNT(b.id) AS blockerCount
      FROM work_items wi
      LEFT JOIN blockers b ON b.work_item_id = wi.id AND b.status = 'active'
      WHERE wi.status = 'open'
      GROUP BY wi.id
      ORDER BY wi.updated_at DESC
      LIMIT ?`
    )
    .all(limit);
}

export { schema };
