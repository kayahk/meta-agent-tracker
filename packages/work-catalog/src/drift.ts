/**
 * GitHub ↔ Jira drift detection.
 *
 * Uses the persisted cross-source links plus the current Jira issue statuses
 * to flag inconsistencies between what GitHub shows and what Jira shows.
 *
 * Foundation checks (deterministic, GitHub-side):
 *  - PR merged on GitHub, but the linked Jira issue is not Done.
 *  - PR still a draft on GitHub, but the linked Jira issue is "In Review".
 */

import {
  getLinksBySource,
  getLinksTo,
  getWorkItem,
  hasEmittedMessage,
  recordEmittedMessage,
  type OpenedDatabase
} from "@meta-agent/storage";
import type { HermesClient } from "@meta-agent/hermes";

export type DriftType =
  | "pr_merged_jira_open"
  | "pr_draft_jira_review"
  | "jira_in_progress_no_github"
  | "confluence_doc_changed_active_work";

export interface DriftFinding {
  type: DriftType;
  workItemTitle: string;
  workItemUrl: string;
  workItemStatus: string;
  jiraKey: string;
  jiraStatus: string;
  /** Stable identity used for alert de-duplication. */
  dedupKey: string;
  title: string;
  body: string;
}

const DONE_STATUSES = new Set(["done", "closed", "resolved", "completed", "cancelled"]);
const AUTHORITATIVE_LINK_ORIGINS = new Set(["deterministic", "manual"]);

function isAuthoritativeLink(link: { origin: string }): boolean {
  return AUTHORITATIVE_LINK_ORIGINS.has(link.origin);
}

function isDone(status: string): boolean {
  return DONE_STATUSES.has(status.trim().toLowerCase());
}

function isReview(status: string): boolean {
  return status.toLowerCase().includes("review");
}

function isImplementationStatus(status: string): boolean {
  const s = status.toLowerCase();
  return (
    s.includes("progress") ||
    s.includes("review") ||
    s.includes("implement") ||
    s.includes("development")
  );
}

/**
 * Detect drift between linked GitHub work items and Jira issue statuses.
 *
 * @param jiraStatusByExternalId map of Jira external id (`issue:KEY`) → status name.
 */
export function detectGitHubJiraDrift(
  db: OpenedDatabase,
  jiraStatusByExternalId: Map<string, string>
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const links = getLinksBySource(db, "github");

  for (const link of links) {
    if (link.toSource !== "jira") continue;
    if (!isAuthoritativeLink(link)) continue;

    const jiraStatus = jiraStatusByExternalId.get(link.toExternalId);
    if (!jiraStatus) continue; // Jira issue not in scope / unknown status

    const wi = getWorkItem(db, "github", link.fromExternalId);
    if (!wi || wi.kind !== "pull_request") continue;

    const status = wi.status ?? "";
    const jiraKey = link.toExternalId.replace(/^issue:/, "");

    if (status === "merged" && !isDone(jiraStatus)) {
      findings.push({
        type: "pr_merged_jira_open",
        workItemTitle: wi.title,
        workItemUrl: wi.externalUrl,
        workItemStatus: status,
        jiraKey,
        jiraStatus,
        dedupKey: `pr_merged_jira_open:${link.fromExternalId}:${jiraKey}:${jiraStatus}`,
        title: `Drift: ${jiraKey} still "${jiraStatus}" but PR merged`,
        body: `GitHub PR "${wi.title}" is merged, but linked Jira ${jiraKey} is still "${jiraStatus}".\n${wi.externalUrl}`
      });
    } else if (status === "draft" && isReview(jiraStatus)) {
      findings.push({
        type: "pr_draft_jira_review",
        workItemTitle: wi.title,
        workItemUrl: wi.externalUrl,
        workItemStatus: status,
        jiraKey,
        jiraStatus,
        dedupKey: `pr_draft_jira_review:${link.fromExternalId}:${jiraKey}:${jiraStatus}`,
        title: `Drift: ${jiraKey} is "${jiraStatus}" but PR is draft`,
        body: `Jira ${jiraKey} is "${jiraStatus}", but linked GitHub PR "${wi.title}" is still a draft.\n${wi.externalUrl}`
      });
    }
  }

  return findings;
}

/**
 * Jira issues in an implementation-like status with no linked GitHub PR/issue.
 */
export function detectJiraWithoutGithub(
  db: OpenedDatabase,
  jiraStatusByExternalId: Map<string, string>
): DriftFinding[] {
  const findings: DriftFinding[] = [];

  for (const [externalId, jiraStatus] of jiraStatusByExternalId) {
    if (!isImplementationStatus(jiraStatus)) continue;
    if (getLinksTo(db, externalId).some(isAuthoritativeLink)) continue;

    const wi = getWorkItem(db, "jira", externalId);
    const jiraKey = externalId.replace(/^issue:/, "");
    const title = wi?.title ?? jiraKey;
    const url = wi?.externalUrl ?? `https://jira.example.com/browse/${jiraKey}`;

    findings.push({
      type: "jira_in_progress_no_github",
      workItemTitle: title,
      workItemUrl: url,
      workItemStatus: jiraStatus,
      jiraKey,
      jiraStatus,
      dedupKey: `jira_no_github:${externalId}:${jiraStatus}`,
      title: `Drift: ${jiraKey} is "${jiraStatus}" but has no linked GitHub work`,
      body: `Jira ${jiraKey} ("${title}") is "${jiraStatus}" with no linked GitHub PR or issue.\n${url}`
    });
  }

  return findings;
}

/**
 * Deliver drift findings via Hermes, suppressing alerts that were already
 * emitted (a drift condition persists until resolved, so it should alert once,
 * not every scan). Returns the number of new alerts delivered.
 */
export async function deliverDrift(
  hermes: HermesClient,
  db: OpenedDatabase,
  findings: DriftFinding[]
): Promise<number> {
  let delivered = 0;

  for (const f of findings) {
    if (hasEmittedMessage(db, f.dedupKey)) continue;

    const ok = await hermes.send({
      category: "requirement_drift",
      title: f.title,
      body: f.body,
      sourceUrl: f.workItemUrl
    });
    if (!ok) continue;

    recordEmittedMessage(db, {
      category: "requirement_drift",
      title: f.title,
      body: f.body,
      dedupKey: f.dedupKey,
      emittedAt: new Date(),
      sourceUrl: f.workItemUrl
    });
    delivered++;
  }

  return delivered;
}
