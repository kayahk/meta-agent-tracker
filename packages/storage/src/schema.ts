import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sourceChanges = sqliteTable(
  "source_changes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    changeType: text("change_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: text("occurred_at").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [uniqueIndex("source_changes_idempotency_key_idx").on(table.idempotencyKey)]
);

export const workItems = sqliteTable(
  "work_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    status: text("status"),
    owner: text("owner"),
    body: text("body"),
    externalUrl: text("external_url").notNull(),
    updatedAt: text("updated_at").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [uniqueIndex("work_items_source_external_id_idx").on(table.source, table.externalId)]
);

export const planSnapshots = sqliteTable("plan_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workItemId: integer("work_item_id")
    .notNull()
    .references(() => workItems.id),
  source: text("source").notNull(),
  parsedAt: text("parsed_at").notNull(),
  rawBody: text("raw_body").notNull(),
  stepCount: integer("step_count").notNull(),
  createdAt: text("created_at").notNull()
});

export const planSteps = sqliteTable("plan_steps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotId: integer("snapshot_id")
    .notNull()
    .references(() => planSnapshots.id),
  stepOrder: integer("step_order").notNull(),
  text: text("text").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull()
});

export const milestoneEvents = sqliteTable("milestone_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workItemId: integer("work_item_id")
    .notNull()
    .references(() => workItems.id),
  stepId: integer("step_id")
    .notNull()
    .references(() => planSteps.id),
  previousState: text("previous_state").notNull(),
  newState: text("new_state").notNull(),
  occurredAt: text("occurred_at").notNull(),
  emitted: integer("emitted", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull()
});

export const blockers = sqliteTable("blockers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workItemId: integer("work_item_id").references(() => workItems.id),
  sourceChangeId: integer("source_change_id").references(() => sourceChanges.id),
  type: text("type").notNull(),
  status: text("status").notNull().default("active"),
  title: text("title").notNull(),
  detail: text("detail"),
  occurredAt: text("occurred_at").notNull(),
  resolvedAt: text("resolved_at"),
  createdAt: text("created_at").notNull()
});

export const links = sqliteTable(
  "links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fromSource: text("from_source").notNull(),
    fromExternalId: text("from_external_id").notNull(),
    toSource: text("to_source").notNull(),
    toExternalId: text("to_external_id").notNull(),
    relation: text("relation").notNull().default("references"),
    origin: text("origin").notNull().default("deterministic"),
    confidence: real("confidence"),
    createdAt: text("created_at").notNull()
  },
  (table) => [uniqueIndex("links_from_to_idx").on(table.fromExternalId, table.toExternalId)]
);

export const emittedFeedMessages = sqliteTable(
  "emitted_feed_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    category: text("category").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    sourceUrl: text("source_url"),
    dedupKey: text("dedup_key").notNull(),
    emittedAt: text("emitted_at").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [uniqueIndex("emitted_feed_messages_dedup_key_idx").on(table.dedupKey)]
);

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    externalSessionId: text("external_session_id").notNull(),
    agent: text("agent").notNull(),
    platform: text("platform"),
    threadId: text("thread_id"),
    initialTask: text("initial_task"),
    status: text("status").notNull().default("active"),
    summary: text("summary"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("agent_sessions_external_session_id_idx").on(table.externalSessionId)]
);

export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id").references(() => agentSessions.id),
    agent: text("agent").notNull(),
    externalSessionId: text("external_session_id"),
    eventType: text("event_type").notNull(),
    task: text("task").notNull(),
    status: text("status"),
    confidence: text("confidence").notNull().default("agent_claimed"),
    ledgerTopic: text("ledger_topic"),
    repo: text("repo"),
    branch: text("branch"),
    prUrl: text("pr_url"),
    commitSha: text("commit_sha"),
    jiraKey: text("jira_key"),
    planRepo: text("plan_repo"),
    planPath: text("plan_path"),
    planItemsJson: text("plan_items_json"),
    evidenceJson: text("evidence_json"),
    payloadJson: text("payload_json").notNull(),
    idempotencyKey: text("idempotency_key"),
    occurredAt: text("occurred_at").notNull(),
    ingestedAt: text("ingested_at").notNull()
  },
  (table) => [uniqueIndex("agent_events_idempotency_key_idx").on(table.idempotencyKey)]
);
