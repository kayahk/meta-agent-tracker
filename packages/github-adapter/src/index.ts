/**
 * Phase 3+4: GitHub Adapter MVP + Hermes Feed Integration
 *
 * Normalizes GitHub webhook events into ledger entities,
 * and delivers blocker/milestone notifications via HermesClient.
 *
 * - issues → work_items
 * - pull_request → work_items
 * - workflow_run/check_run (failure) → blockers + Hermes delivery
 * - workflow_run/check_run (success) → resolve blockers + Hermes delivery
 * - plan body updates → plan_snapshots + milestone_events + Hermes delivery
 */

import type { HermesClient, HermesMessage } from "@meta-agent/hermes";
import {
  upsertWorkItem,
  getLatestPlanSnapshot,
  createPlanSnapshot,
  createMilestoneEvent,
  getActiveBlockers,
  createBlocker,
  findActiveBlocker,
  getWorkItemByExternalId,
  resolveBlocker,
  claimEmittedMessage,
  removeEmittedMessageClaim,
  type CreateBlockerInput,
  type OpenedDatabase
} from "@meta-agent/storage";
import { parsePlans, diffSteps, extractMilestones } from "@meta-agent/plan-parser";
import { syncJiraLinks } from "@meta-agent/jira-adapter";

export interface NormalizeResult {
  event: string;
  effects: EffectDescription[];
}

export interface EffectDescription {
  type:
    | "work_item_upserted"
    | "blocker_created"
    | "blocker_resolved"
    | "plan_snapshot_created"
    | "milestone_created"
    | "feed_delivered";
  detail: string;
  delivered: boolean;
}

type NormalizableEvent =
  | "issues"
  | "pull_request"
  | "pull_request_review"
  | "workflow_run"
  | "check_run";

interface WebhookPayload {
  action?: string;
  issue?: Record<string, unknown>;
  pull_request?: Record<string, unknown>;
  review?: Record<string, unknown>;
  workflow_run?: Record<string, unknown>;
  check_run?: Record<string, unknown>;
  repository?: { full_name?: string; html_url?: string };
  sender?: { login?: string };
}

/**
 * Process a webhook event and optionally deliver notifications via Hermes.
 * Pass `hermes` to enable live feed delivery, or omit for ledger-only mode.
 */
export async function normalizeWebhookEvent(
  database: OpenedDatabase,
  event: string,
  payload: unknown,
  hermes?: HermesClient
): Promise<NormalizeResult> {
  const r: NormalizeResult = { event, effects: [] };
  if (!isNormalizableEvent(event)) return r;

  const p = (payload ?? {}) as WebhookPayload;

  switch (event) {
    case "issues":
      await handleIssues(database, p, r, hermes);
      break;
    case "pull_request":
      await handlePullRequest(database, p, r, hermes);
      break;
    case "pull_request_review":
      await handlePullRequestReview(database, p, r, hermes);
      break;
    case "workflow_run":
      await handleWorkflowRun(database, p, r, hermes);
      break;
    case "check_run":
      await handleCheckRun(database, p, r, hermes);
      break;
  }

  return r;
}

// ── Hermes delivery helper ──────────────────────────────────────

async function deliver(
  hermes: HermesClient | undefined,
  db: OpenedDatabase,
  category: string,
  title: string,
  body: string,
  sourceUrl?: string,
  explicitDedupKey?: string
) {
  if (!hermes) return false;

  // Dedup via the emitted_feed_messages table (persistent across restarts)
  const dedupKey = explicitDedupKey ?? `${category}:${title}`;
  const claimed = claimEmittedMessage(db, {
    category,
    title,
    body,
    dedupKey,
    emittedAt: new Date(),
    ...(sourceUrl ? { sourceUrl } : {})
  });
  if (!claimed) return false;

  // exactOptionalPropertyTypes: only include sourceUrl when present
  const delivered = await hermes.send(
    sourceUrl
      ? { category: category as HermesMessage["category"], title, body, sourceUrl, dedupKey }
      : { category: category as HermesMessage["category"], title, body, dedupKey }
  );
  if (!delivered) removeEmittedMessageClaim(db, dedupKey);
  return delivered;
}

// ── Event handlers ──────────────────────────────────────────────

async function handleIssues(
  db: OpenedDatabase,
  p: WebhookPayload,
  r: NormalizeResult,
  h?: HermesClient
) {
  const issue = p.issue;
  if (!issue || !p.repository) return;
  const num = str(issue["number"]);
  if (!num) return;
  const repo = str(p.repository["full_name"]);

  const externalUrl = str(issue["html_url"]) || `https://github.com/${repo}/issues/${num}`;

  const wi = upsertWorkItem(
    db,
    buildItemInput({
      source: "github",
      externalId: `issue:${repo}#${num}`,
      kind: "issue" as const,
      title: str(issue["title"]),
      externalUrl,
      updatedAt: date(issue["updated_at"]),
      status: normalizeIssueStatus(p.action, issue),
      owner: login(issue["assignee"]),
      body: strOrNull(issue["body"])
    })
  );

  r.effects.push({
    type: "work_item_upserted",
    detail: `issue ${repo}#${num} → ${wi.created ? "created" : "updated"}`,
    delivered: false
  });
  syncJiraLinks(
    db,
    "github",
    `issue:${repo}#${num}`,
    `${str(issue["title"])}\n${str(issue["body"])}`
  );
  await handlePlanBody(db, wi.id, str(issue["body"]), externalUrl, r, h);
}

async function handlePullRequest(
  db: OpenedDatabase,
  p: WebhookPayload,
  r: NormalizeResult,
  h?: HermesClient
) {
  const pr = p.pull_request;
  if (!pr || !p.repository) return;
  const num = str(pr["number"]);
  if (!num) return;
  const repo = str(p.repository["full_name"]);

  const externalUrl = str(pr["html_url"]) || `https://github.com/${repo}/pull/${num}`;
  const externalId = `pr:${repo}#${num}`;
  const status = normalizePrStatus(p.action, pr);

  const wi = upsertWorkItem(
    db,
    buildItemInput({
      source: "github",
      externalId,
      kind: "pull_request" as const,
      title: str(pr["title"]),
      externalUrl,
      updatedAt: date(pr["updated_at"]),
      status,
      owner: login(pr["user"]),
      body: strOrNull(pr["body"])
    })
  );

  r.effects.push({
    type: "work_item_upserted",
    detail: `PR ${repo}#${num} → ${wi.created ? "created" : "updated"}`,
    delivered: false
  });
  if (h) {
    await deliverPrTransition(db, h, r, {
      repo,
      num,
      title: str(pr["title"]),
      externalUrl,
      status,
      owner: login(pr["user"])
    });
  }
  syncJiraLinks(
    db,
    "github",
    externalId,
    `${str(pr["title"])}\n${str(pr["head"] && (pr["head"] as Record<string, unknown>)["ref"])}\n${str(pr["body"])}`
  );
  await handlePlanBody(db, wi.id, str(pr["body"]), externalUrl, r, h);
}

interface PullRequestTransitionInput {
  repo: string;
  num: string;
  title: string;
  externalUrl: string;
  status: string | null;
  owner: string | null;
}

async function deliverPrTransition(
  db: OpenedDatabase,
  h: HermesClient | undefined,
  r: NormalizeResult,
  input: PullRequestTransitionInput
) {
  if (!h) return;

  if (input.status === "open") {
    const delivered = await deliver(
      h,
      db,
      "pr_opened",
      `PR opened: ${input.repo}#${input.num} ${input.title}`,
      `New pull request opened by ${input.owner ?? "unknown"}: ${input.title}`,
      input.externalUrl,
      `pr_opened:${input.repo}#${input.num}`
    );
    r.effects.push({
      type: "feed_delivered",
      detail: `pr_opened ${input.repo}#${input.num}`,
      delivered
    });
    return;
  }

  if (input.status === "merged") {
    const delivered = await deliver(
      h,
      db,
      "pr_merged",
      `PR merged: ${input.repo}#${input.num} ${input.title}`,
      `Pull request merged: ${input.title}`,
      input.externalUrl,
      `pr_merged:${input.repo}#${input.num}`
    );
    r.effects.push({
      type: "feed_delivered",
      detail: `pr_merged ${input.repo}#${input.num}`,
      delivered
    });
  }
}

async function handlePullRequestReview(
  db: OpenedDatabase,
  p: WebhookPayload,
  r: NormalizeResult,
  h?: HermesClient
) {
  const pr = p.pull_request;
  const review = p.review;
  if (!pr || !review || !p.repository) return;
  const num = str(pr["number"]);
  if (!num) return;
  const repo = str(p.repository["full_name"]);
  const title = str(pr["title"]);
  const externalUrl = str(pr["html_url"]) || `https://github.com/${repo}/pull/${num}`;
  const externalId = `pr:${repo}#${num}`;
  const state = str(review["state"]).toLowerCase();
  const reviewer = login(review["user"]);
  const prStatusAction = str(pr["state"]) === "closed" ? "closed" : undefined;
  const headRef = str(pr["head"] && (pr["head"] as Record<string, unknown>)["ref"]);

  const wi = upsertWorkItem(
    db,
    buildItemInput({
      source: "github",
      externalId,
      kind: "pull_request" as const,
      title,
      externalUrl,
      updatedAt: date(review["submitted_at"] || pr["updated_at"]),
      status: normalizePrStatus(prStatusAction, pr),
      owner: login(pr["user"]),
      body: strOrNull(pr["body"])
    })
  );

  r.effects.push({
    type: "work_item_upserted",
    detail: `PR review ${repo}#${num} → ${wi.created ? "created" : "updated"}`,
    delivered: false
  });
  syncJiraLinks(db, "github", externalId, [title, headRef, str(pr["body"])].join("\n"));

  if (h && state === "changes_requested") {
    const reviewUrl = str(review["html_url"]) || externalUrl;
    const delivered = await deliver(
      h,
      db,
      "review_needed",
      `Review changes requested: ${repo}#${num} ${title}`,
      `Changes requested by ${reviewer ?? "unknown reviewer"}: ${title}`,
      reviewUrl,
      `review_needed:${repo}#${num}:${str(review["id"]) || str(review["submitted_at"]) || state}`
    );
    r.effects.push({ type: "feed_delivered", detail: `review_needed ${repo}#${num}`, delivered });
  }
}

async function handleWorkflowRun(
  db: OpenedDatabase,
  p: WebhookPayload,
  r: NormalizeResult,
  h?: HermesClient
) {
  const wf = p.workflow_run;
  if (!wf || !p.repository) return;
  const action = p.action ?? "";
  const conclusion = str(wf["conclusion"]);
  if (action !== "completed" && conclusion === "") return;

  const repo = str(p.repository["full_name"]);
  const wfName = str(wf["name"]) || "workflow";
  const branch = str(wf["head_branch"]);
  const htmlUrl = str(wf["html_url"]);
  const workItemId = resolveWorkItemId(db, repo, wf["pull_requests"]);

  if (isFailure(conclusion)) {
    const title = `${wfName} failed on ${repo} (${branch})`;
    await createBlockerOnce(db, r, h, {
      type: "ci_failure",
      title,
      workItemId,
      detail: htmlUrl || undefined,
      body: htmlUrl ? `Workflow run: ${htmlUrl}` : `${wfName} failed on ${repo}/${branch}`,
      sourceUrl: htmlUrl || undefined
    });
  } else if (conclusion === "success") {
    resolveMatching(db, repo, branch || undefined, workItemId, r, h);
  }
}

async function handleCheckRun(
  db: OpenedDatabase,
  p: WebhookPayload,
  r: NormalizeResult,
  h?: HermesClient
) {
  const cr = p.check_run;
  if (!cr || !p.repository) return;
  const repo = str(p.repository["full_name"]);
  const name = str(cr["name"]) || "check";
  const conclusion = str(cr["conclusion"]);
  const htmlUrl = str(cr["html_url"]) || str(cr["details_url"]);
  const branch = checkRunBranch(cr);
  const workItemId = resolveWorkItemId(db, repo, cr["pull_requests"]);

  if (p.action === "completed" && isFailure(conclusion)) {
    const title = `Check "${name}" failed on ${repo}`;
    await createBlockerOnce(db, r, h, {
      type: "ci_failure",
      title,
      workItemId,
      detail: htmlUrl || undefined,
      body: htmlUrl ? `Check run: ${htmlUrl}` : `Check "${name}" failed on ${repo}`,
      sourceUrl: htmlUrl || undefined
    });
  } else if (p.action === "completed" && conclusion === "success") {
    resolveMatching(db, repo, branch, workItemId, r, h);
  }
}

// ── Blocker helpers ─────────────────────────────────────────────

interface CreateBlockerOnceInput {
  type: string;
  title: string;
  workItemId: number | null;
  detail: string | undefined;
  body: string;
  sourceUrl: string | undefined;
}

/**
 * Create a blocker (linked to a work item when one is known) unless an
 * identical active blocker already exists. Avoids duplicate rows and
 * duplicate Hermes alerts when the same pipeline fails repeatedly.
 */
async function createBlockerOnce(
  db: OpenedDatabase,
  r: NormalizeResult,
  h: HermesClient | undefined,
  input: CreateBlockerOnceInput
) {
  if (findActiveBlocker(db, input.type, input.title)) return;

  const blockerInput: CreateBlockerInput = {
    type: input.type,
    title: input.title,
    occurredAt: new Date()
  };
  if (input.workItemId != null) blockerInput.workItemId = input.workItemId;
  if (input.detail) blockerInput.detail = input.detail;
  createBlocker(db, blockerInput);

  const delivered = await deliver(
    h,
    db,
    "blocker_detected",
    input.title,
    input.body,
    input.sourceUrl
  );
  r.effects.push({ type: "blocker_created", detail: input.title, delivered });
}

/**
 * Resolve a PR work item id from a GitHub `pull_requests` array
 * (present on workflow_run / check_run payloads). Returns the first
 * matching tracked work item, or null when none is tracked.
 */
function resolveWorkItemId(db: OpenedDatabase, repo: string, pullRequests: unknown): number | null {
  if (!Array.isArray(pullRequests)) return null;
  for (const pr of pullRequests) {
    if (pr == null || typeof pr !== "object") continue;
    const num = (pr as Record<string, unknown>)["number"];
    if (num == null) continue;
    const wi = getWorkItemByExternalId(db, "github", `pr:${repo}#${num}`);
    if (wi) return wi.id;
  }
  return null;
}

function checkRunBranch(cr: Record<string, unknown>): string | undefined {
  const suite = cr["check_suite"];
  if (suite != null && typeof suite === "object") {
    const b = (suite as Record<string, unknown>)["head_branch"];
    if (b != null) return String(b);
  }
  return undefined;
}

// ── Plan body handling ──────────────────────────────────────────

async function handlePlanBody(
  db: OpenedDatabase,
  workItemId: number,
  body: string,
  externalUrl: string,
  r: NormalizeResult,
  h?: HermesClient
) {
  const effects = await syncPlanFromBody(db, workItemId, body, externalUrl, h);
  r.effects.push(...effects);
}

/**
 * Parse an `## Implementation Plan` section from a work item body, persist a
 * plan snapshot, and emit milestone events (and Hermes alerts) for steps that
 * transitioned from incomplete to complete since the previous snapshot.
 *
 * Shared by the webhook path and the reconciliation scan so both produce
 * identical milestone signals.
 */
export async function syncPlanFromBody(
  db: OpenedDatabase,
  workItemId: number,
  body: string | null | undefined,
  externalUrl: string,
  h?: HermesClient
): Promise<EffectDescription[]> {
  const effects: EffectDescription[] = [];
  if (!body) return effects;

  const plans = parsePlans(body);
  if (plans.length === 0) return effects;

  const plan = plans[0]!;
  const prev = getLatestPlanSnapshot(db, workItemId);

  createPlanSnapshot(db, {
    workItemId,
    source: "github",
    rawBody: plan.rawBody,
    steps: plan.steps
  });

  effects.push({
    type: "plan_snapshot_created",
    detail: `${plan.headingName}: ${plan.steps.length} steps`,
    delivered: false
  });

  if (!prev) return effects;

  const diff = diffSteps(
    prev.steps.map((s) => ({ stepOrder: s.stepOrder, text: s.text, completed: s.completed })),
    plan.steps
  );
  const milestones = extractMilestones(diff);
  if (milestones.length === 0) return effects;

  const fresh = getLatestPlanSnapshot(db, workItemId);
  if (!fresh) return effects;

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

    if (h) {
      const delivered = await deliver(
        h,
        db,
        "milestone_reached",
        `Milestone: ${m.stepText}`,
        `Step ${m.stepOrder}: ${m.stepText} (completed)`,
        externalUrl
      );
      effects.push({ type: "milestone_created", detail: `✅ ${m.stepText}`, delivered });
    } else {
      effects.push({ type: "milestone_created", detail: `✅ ${m.stepText}`, delivered: false });
    }
  }

  return effects;
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

// ── Helpers ─────────────────────────────────────────────────────

function isNormalizableEvent(e: string): e is NormalizableEvent {
  return ["issues", "pull_request", "pull_request_review", "workflow_run", "check_run"].includes(e);
}

function isFailure(c: string): boolean {
  return c === "failure" || c === "cancelled" || c === "timed_out";
}

function str(v: unknown): string {
  return v != null ? String(v) : "";
}
function strOrNull(v: unknown): string | null {
  return v != null ? String(v) : null;
}
function date(v: unknown): Date {
  const s = str(v);
  return s ? new Date(s) : new Date();
}
function login(v: unknown): string | null {
  if (v == null) return null;
  const l = (v as Record<string, unknown>)["login"];
  return l != null ? String(l) : null;
}

function normalizeIssueStatus(
  action: string | undefined,
  issue: Record<string, unknown>
): string | null {
  if (action === "opened" || action === "reopened") return "open";
  if (action === "closed") return "closed";
  const s = issue["state"];
  return s != null ? String(s) : null;
}

function normalizePrStatus(action: string | undefined, pr: Record<string, unknown>): string | null {
  if (action === "opened" || action === "reopened") return "open";
  if (action === "closed") return pr["merged"] === true ? "merged" : "closed";
  if (pr["draft"] === true) return "draft";
  const s = pr["state"];
  return s != null ? String(s) : null;
}

/**
 * Resolve active CI blockers on a successful run.
 *
 * Matching is intentionally conservative to avoid resolving unrelated
 * blockers:
 *  - If the success maps to a tracked work item, resolve blockers linked
 *    to that work item.
 *  - Otherwise, if a branch is known, resolve blockers whose title names
 *    that branch.
 *  - If neither signal is available, resolve nothing (a bare success with
 *    no PR and no branch is too ambiguous to act on).
 */
async function resolveMatching(
  db: OpenedDatabase,
  repo: string,
  branch: string | undefined,
  workItemId: number | null,
  r: NormalizeResult,
  h?: HermesClient
) {
  if (workItemId == null && !branch) return;

  for (const b of getActiveBlockers(db)) {
    if (b.type !== "ci_failure") continue;
    if (!b.title.includes(repo)) continue;

    const matchesWorkItem = workItemId != null && b.workItemId === workItemId;
    const matchesBranch = branch != null && b.title.includes(`(${branch})`);
    if (!matchesWorkItem && !matchesBranch) continue;

    resolveBlocker(db, b.id, new Date());
    const delivered = await deliver(
      h,
      db,
      "blocker_resolved",
      b.title,
      `Blocker resolved: ${b.title}`,
      undefined
    );
    r.effects.push({ type: "blocker_resolved", detail: b.title, delivered });
  }
}
