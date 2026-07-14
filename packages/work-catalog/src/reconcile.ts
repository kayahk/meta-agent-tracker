/**
 * Ledger reconciliation + status digest.
 *
 * The webhook pipeline keeps the ledger fresh in real time, but webhook
 * deliveries can be missed. The reconciliation scan re-derives the current
 * open work from the GitHub REST API and upserts it into the same ledger,
 * so the ledger converges to the true state even after dropped webhooks.
 *
 * The status digest is then built *from the ledger* (not from a separate
 * scan), so the digest, the dashboard, and real-time alerts all agree.
 */

import { syncPlanFromBody } from "@meta-agent/github-adapter";
import { parsePlanDocument, isDonePlanStatus, type PlanDocument } from "./plan-docs.js";
import { syncJiraLinks, upsertJiraIssueFromApi, type JiraIssue } from "@meta-agent/jira-adapter";
import {
  upsertWorkItem,
  upsertLink,
  getRecentMilestones,
  getActiveBlockersWithItems,
  getActiveBlockers,
  resolveBlocker,
  getStaleWorkItems,
  getActiveWorkItems,
  getRecentAgentEvidenceSignals,
  updateAgentEventConfidence,
  type AgentEventRow,
  type OpenedDatabase,
  type UpsertWorkItemInput
} from "@meta-agent/storage";
import type { HermesClient, HermesMessage } from "@meta-agent/hermes";
import type { GitHubItem, GitHubPr, GitHubWorkflowRun, WorkCatalogResult } from "./index.js";

export interface ReconcileResult {
  /** Total items upserted into the ledger. */
  upserted: number;
  /** Of those, how many were newly created. */
  created: number;
  /** Milestone events detected during reconciliation. */
  milestones: number;
}

/**
 * Upsert scanned GitHub PRs/issues into the ledger and sync their plans.
 * Callers may include open items plus a recent window of closed/merged PRs.
 */
export async function reconcileLedger(options: {
  db: OpenedDatabase;
  items: GitHubItem[];
  hermes?: HermesClient | undefined;
}): Promise<ReconcileResult> {
  const { db, items, hermes } = options;
  const result: ReconcileResult = { upserted: 0, created: 0, milestones: 0 };

  for (const item of items) {
    const kind = item.kind;
    const prefix = kind === "pull_request" ? "pr" : "issue";
    const externalId = `${prefix}:${item.repo}#${item.number}`;
    const previous =
      kind === "pull_request" && hermes ? getExistingWorkState(db, "github", externalId) : null;
    const status = inferGitHubItemStatus(item);

    const input: UpsertWorkItemInput = {
      source: "github",
      externalId,
      kind,
      title: item.title,
      externalUrl: item.htmlUrl,
      updatedAt: new Date(item.updatedAt)
    };
    input.status = status;
    if (item.user?.login) input.owner = item.user.login;
    if (item.body != null) input.body = item.body;

    const wi = upsertWorkItem(db, input);
    result.upserted++;
    if (wi.created) result.created++;

    if (kind === "pull_request" && hermes) {
      await deliverPullRequestTransition(
        hermes,
        item,
        status,
        previous?.status ?? null,
        wi.created
      );
    }

    // Deterministic cross-source links: Jira keys mentioned in title/body.
    syncJiraLinks(db, "github", externalId, `${item.title}\n${item.body ?? ""}`);

    const effects = await syncPlanFromBody(db, wi.id, item.body, item.htmlUrl, hermes);
    result.milestones += effects.filter((e) => e.type === "milestone_created").length;
  }

  return result;
}

/**
 * Upsert open Jira issues from a REST/JQL search into the ledger.
 */
export function reconcileJiraLedger(options: {
  db: OpenedDatabase;
  issues: JiraIssue[];
}): ReconcileResult {
  const { db, issues } = options;
  const result: ReconcileResult = { upserted: 0, created: 0, milestones: 0 };

  for (const issue of issues) {
    const wi = upsertJiraIssueFromApi(db, issue);
    result.upserted++;
    if (wi.created) result.created++;
  }

  return result;
}

export function reconcileWorkflowBlockers(options: {
  db: OpenedDatabase;
  runs: GitHubWorkflowRun[];
}): { resolved: number } {
  const successfulRuns = options.runs
    .filter((run) => run.conclusion === "success" && run.branch)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  let resolved = 0;

  for (const blocker of getActiveBlockers(options.db)) {
    if (blocker.type !== "ci_failure") continue;
    const matchingSuccess = successfulRuns.find((run) => {
      if (!blocker.title.includes(run.repo)) return false;
      if (!blocker.title.includes(`(${run.branch})`)) return false;
      if (
        blocker.title.startsWith(`${run.name} failed on`) ||
        blocker.title.includes(` ${run.name} `)
      )
        return true;
      // Old blocker titles did not always include enough structure; a same-branch
      // success after the failure is a safer source of truth than keeping a stale red item forever.
      return new Date(run.updatedAt) > new Date(blocker.occurredAt);
    });
    if (!matchingSuccess) continue;
    if (new Date(matchingSuccess.updatedAt) < new Date(blocker.occurredAt)) continue;
    resolveBlocker(options.db, blocker.id, new Date(matchingSuccess.updatedAt));
    resolved++;
  }

  return { resolved };
}

export function reconcileAgentEvidence(options: {
  db: OpenedDatabase;
  items: GitHubItem[];
  runs: GitHubWorkflowRun[];
}): { verified: number; observed: number } {
  const signals = getRecentAgentEvidenceSignals(options.db, { limit: 200 });
  let verified = 0;
  let observed = 0;
  const workflowEvidenceWindowMs = 7 * 24 * 60 * 60 * 1000;

  for (const signal of signals) {
    if (["system_observed", "verified", "manual_override"].includes(signal.confidence)) continue;

    if (signal.prUrl && ["pr_opened", "task_completed_claimed"].includes(signal.eventType)) {
      const item = options.items.find((candidate) => candidate.htmlUrl === signal.prUrl);
      if (!item) continue;
      const itemStatus = inferGitHubItemStatus(item);
      const evidence = [
        {
          type: "github_item",
          url: item.htmlUrl,
          status: itemStatus,
          observedAt: new Date().toISOString()
        }
      ];
      if (
        signal.eventType === "task_completed_claimed" &&
        item.kind === "pull_request" &&
        itemStatus === "merged"
      ) {
        updateAgentEventConfidence(options.db, signal.id, "verified", evidence);
        verified++;
      } else if (signal.eventType === "pr_opened" && item.kind === "pull_request") {
        updateAgentEventConfidence(options.db, signal.id, "system_observed", evidence);
        observed++;
      }
      continue;
    }

    if (["tests_passed", "blocker_resolved_claimed"].includes(signal.eventType)) {
      if (!signal.repo || !signal.branch) continue;
      const run = options.runs.find((candidate) => {
        if (candidate.conclusion !== "success") return false;
        if (candidate.repo !== signal.repo) return false;
        if (candidate.branch !== signal.branch) return false;
        const runUpdatedAt = new Date(candidate.updatedAt).getTime();
        const signalOccurredAt = new Date(signal.occurredAt).getTime();
        if (Number.isNaN(runUpdatedAt) || Number.isNaN(signalOccurredAt)) return false;
        return Math.abs(runUpdatedAt - signalOccurredAt) <= workflowEvidenceWindowMs;
      });
      if (!run) continue;
      updateAgentEventConfidence(options.db, signal.id, "verified", [
        {
          type: "github_workflow_run",
          repo: run.repo,
          branch: run.branch,
          name: run.name,
          url: run.htmlUrl,
          conclusion: run.conclusion,
          observedAt: run.updatedAt
        }
      ]);
      verified++;
    }
  }

  return { verified, observed };
}

/**
 * LLM fallback linking: persist semantic GitHub↔Jira matches from a work
 * catalog as proposed links only. These are correlation hints, not final truth;
 * deterministic/manual reconciliation must accept a link before drift detection
 * or status transitions may treat it as authoritative.
 * Returns the number of proposed links written.
 */
export function persistCatalogLinks(db: OpenedDatabase, catalog: WorkCatalogResult): number {
  let written = 0;
  for (const entry of catalog.entries) {
    if (!entry.matchedJira?.length) continue;
    const prefix = entry.kind === "pr" ? "pr" : "issue";
    const fromExternalId = `${prefix}:${entry.repo}#${entry.number}`;
    for (const m of entry.matchedJira) {
      const result = upsertLink(db, {
        fromSource: "github",
        fromExternalId,
        toSource: "jira",
        toExternalId: `issue:${m.key}`,
        relation: "proposes",
        origin: "llm_proposed",
        confidence: m.confidence
      });
      if (result.changes > 0) written++;
    }
  }
  return written;
}

export interface StatusDigestOptions {
  /** Items with no activity for this many days are "needs attention". */
  staleDays?: number;
  /** Max recent milestones to list. */
  milestoneLimit?: number;
  /** Override the digest timestamp (testing). */
  timestamp?: Date;
}

/**
 * Build the README-style status digest from the ledger:
 * milestones reached, blocked work, and stalled items.
 */
export function buildStatusDigest(
  db: OpenedDatabase,
  options: StatusDigestOptions = {}
): HermesMessage {
  const staleDays = options.staleDays ?? 2;
  const milestoneLimit = options.milestoneLimit ?? 10;
  const timestamp = options.timestamp ?? new Date();

  const milestones = getRecentMilestones(db, milestoneLimit);
  const blockers = getActiveBlockersWithItems(db);
  const stale = getStaleWorkItems(db, staleDays).filter(
    (item: { kind: string }) => item.kind !== "plan"
  );
  const active = getActiveWorkItems(db, { limit: 1000 });
  const plans = getPlanWorkItems(db, 20);
  const recentMerged = getRecentMergedPullRequests(db, 10);
  const agentSignals = getRecentAgentEvidenceSignals(db, { limit: 50 })
    .filter(
      (signal) => signal.confidence === "agent_claimed" || signal.confidence === "agent_observed"
    )
    .slice(0, 8);

  const repos = new Set(active.map((wi) => repoFromExternalId(wi.externalId)));

  const lines: string[] = [];
  lines.push(`*Status update — ${timestamp.toISOString().slice(0, 10)}*`);
  lines.push("");
  lines.push(`_Active work: ${active.length} open across ${repos.size} repo(s)_`);
  lines.push("");

  lines.push("*Plan-driven work:*");
  if (plans.length === 0) {
    lines.push("- none");
  } else {
    for (const plan of plans) {
      for (const line of formatPlanDigestLines(plan)) {
        lines.push(line);
      }
    }
  }
  lines.push("");

  lines.push("*Recently completed PRs:*");
  if (recentMerged.length === 0) {
    lines.push("- none");
  } else {
    for (const pr of recentMerged) {
      lines.push(`- <${pr.externalUrl}|${pr.title}> — ${pr.status}`);
    }
  }
  lines.push("");

  lines.push("*Milestones reached:*");
  if (milestones.length === 0) {
    lines.push("- none");
  } else {
    for (const m of milestones) {
      lines.push(`- ✅ ${m.stepText} — <${m.workItemUrl}|${m.workItemTitle}>`);
    }
  }
  lines.push("");

  lines.push("*Agent-reported evidence awaiting verification:*");
  if (agentSignals.length === 0) {
    lines.push("- none");
  } else {
    for (const signal of agentSignals) {
      lines.push(formatAgentEvidenceLine(signal));
    }
  }
  lines.push("");

  lines.push("*Blocked:*");
  if (blockers.length === 0) {
    lines.push("- none");
  } else {
    for (const b of blockers) {
      const ref = b.workItemUrl ? `<${b.workItemUrl}|${b.workItemTitle}>` : "(unlinked)";
      lines.push(`- ${b.title} — ${ref}`);
    }
  }
  lines.push("");

  lines.push("*Needs attention:*");
  if (stale.length === 0) {
    lines.push("- none");
  } else {
    for (const s of stale) {
      const days = Math.floor((timestamp.getTime() - new Date(s.updatedAt).getTime()) / 86_400_000);
      lines.push(
        `- <${s.externalUrl}|${s.title}> — no activity for ${days}d, still "${s.status ?? "open"}"`
      );
    }
  }

  return {
    category: "daily_digest",
    title: `Status update — ${formatDigestHour(timestamp)}`,
    body: lines.join("\n"),
    dedupKey: `daily_digest:${timestamp.toISOString().slice(0, 13)}`
  };
}

/** Build and deliver the ledger status digest via Hermes. */
export async function deliverStatusDigest(
  hermes: HermesClient,
  db: OpenedDatabase,
  options: StatusDigestOptions = {}
): Promise<boolean> {
  return hermes.send(buildStatusDigest(db, options));
}

interface DigestWorkItem {
  title: string;
  status: string | null;
  body: string | null;
  externalUrl: string;
  updatedAt: string;
}

function getPlanWorkItems(db: OpenedDatabase, limit: number): DigestWorkItem[] {
  return db.sqlite
    .prepare(
      `SELECT title, status, body, external_url AS externalUrl, updated_at AS updatedAt
       FROM work_items
       WHERE kind = 'plan' AND status = 'open'
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(limit) as DigestWorkItem[];
}

function getRecentMergedPullRequests(db: OpenedDatabase, limit: number): DigestWorkItem[] {
  return db.sqlite
    .prepare(
      `SELECT title, status, body, external_url AS externalUrl, updated_at AS updatedAt
       FROM work_items
       WHERE kind = 'pull_request' AND status IN ('merged', 'closed')
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(limit) as DigestWorkItem[];
}

function parseChecklistSummary(body: string): string | null {
  const match = body.match(/^Checklist:\s*(\d+)\/(\d+)/m);
  if (!match) return null;
  return `${match[1]}/${match[2]} checklist items complete`;
}

function formatPlanDigestLines(plan: DigestWorkItem): string[] {
  const body = plan.body ?? "";
  const parsed = parsePlanDocument({
    repo: "",
    path: "",
    title: plan.title,
    body,
    htmlUrl: plan.externalUrl,
    updatedAt: plan.updatedAt
  } satisfies PlanDocument);
  const openRows = parsed.statusRows.filter((row) => !isDonePlanStatus(row.status));
  const checklist = parseChecklistSummary(body);
  const suffix = checklist ? ` — ${checklist}` : "";

  if (openRows.length === 0) {
    const closedLabel = parsed.status === "closed" ? "closed" : "no open status rows";
    return [`- <${plan.externalUrl}|${plan.title}> — ${closedLabel}${suffix}`];
  }

  return [
    `- <${plan.externalUrl}|${plan.title}>${suffix}`,
    ...openRows.slice(0, 5).map((row) => {
      const notes = row.notes ? ` — ${row.notes}` : "";
      return `  • ${row.item}: ${row.status}${notes}`;
    })
  ];
}

function formatAgentEvidenceLine(signal: AgentEventRow): string {
  const target = signal.prUrl ? `<${signal.prUrl}|${signal.task}>` : signal.task;
  const context = [signal.ledgerTopic, signal.repo, signal.branch].filter(Boolean).join(" / ");
  const contextSuffix = context ? ` — ${context}` : "";
  const status = signal.status ? `, status: ${signal.status}` : "";
  return `- ${agentEventLabel(signal.eventType)}: ${target} (${signal.confidence}${status})${contextSuffix}`;
}

function agentEventLabel(eventType: string): string {
  switch (eventType) {
    case "pr_opened":
      return "PR opened";
    case "commit_pushed":
      return "Commit pushed";
    case "tests_passed":
      return "Tests passed";
    case "tests_failed":
      return "Tests failed";
    case "runtime_verified":
      return "Runtime observed healthy";
    case "blocker_resolved_claimed":
      return "Blocker resolution claimed";
    case "plan_status_stale_suspected":
      return "Plan status may be stale";
    case "task_completed_claimed":
      return "Task completion claimed";
    default:
      return eventType.replaceAll("_", " ");
  }
}

function inferGitHubItemStatus(item: GitHubItem): string {
  if (item.kind === "pull_request") {
    if (item.state === "closed") return item.mergedAt ? "merged" : "closed";
    if (item.draft) return "draft";
    return "open";
  }
  return item.state === "closed" ? "closed" : "open";
}

/** Parse "owner/repo" from a work item externalId like "pr:owner/repo#123". */
function repoFromExternalId(externalId: string): string {
  const parts = externalId.split(":");
  const id = parts.length >= 2 ? (parts[1] ?? "") : externalId;
  const hashIdx = id.lastIndexOf("#");
  return hashIdx >= 0 ? id.substring(0, hashIdx) : id;
}

function getExistingWorkState(
  db: OpenedDatabase,
  source: string,
  externalId: string
): { status: string | null; body: string | null } | null {
  const row = db.sqlite
    .prepare("SELECT status, body FROM work_items WHERE source = ? AND external_id = ?")
    .get(source, externalId) as { status: string | null; body: string | null } | undefined;
  return row ?? null;
}

async function deliverPullRequestTransition(
  hermes: HermesClient,
  item: GitHubPr,
  status: string,
  previousStatus: string | null,
  created: boolean
): Promise<void> {
  if (created && status === "open") {
    await hermes.send({
      category: "pr_opened",
      title: `PR opened: ${item.repo}#${item.number} ${item.title}`,
      body: `New pull request opened by ${item.user?.login ?? "unknown"}: ${item.title}`,
      sourceUrl: item.htmlUrl,
      dedupKey: `pr_opened:${item.repo}#${item.number}`
    });
    return;
  }

  if (status === "merged" && previousStatus !== "merged") {
    await hermes.send({
      category: "pr_merged",
      title: `PR merged: ${item.repo}#${item.number} ${item.title}`,
      body: `Pull request merged: ${item.title}`,
      sourceUrl: item.htmlUrl,
      dedupKey: `pr_merged:${item.repo}#${item.number}`
    });
  }
}

function formatDigestHour(timestamp: Date): string {
  return `${timestamp.toISOString().slice(0, 13).replace("T", " ")}:00 UTC`;
}
