import { normalizeConfluencePage, type ConfluencePage } from "@meta-agent/confluence-adapter";
import {
  getLinksFrom,
  getLinksTo,
  getWorkItem,
  upsertLink,
  upsertWorkItem,
  type OpenedDatabase,
  type UpsertWorkItemInput
} from "@meta-agent/storage";
import type { DriftFinding } from "./drift.js";
import type { ReconcileResult } from "./reconcile.js";

const ACTIVE_GITHUB_STATUSES = new Set(["open", "draft"]);

export function reconcileConfluenceLedger(options: {
  db: OpenedDatabase;
  pages: ConfluencePage[];
}): ReconcileResult {
  const result: ReconcileResult = { upserted: 0, created: 0, milestones: 0 };

  for (const page of options.pages) {
    const item = normalizeConfluencePage(page);
    const input: UpsertWorkItemInput = {
      source: "confluence",
      externalId: item.externalId,
      kind: item.kind,
      title: item.title,
      externalUrl: item.url,
      updatedAt: item.updatedAt
    };
    if (item.status) input.status = item.status;
    if (item.owner) input.owner = item.owner;
    if (item.body) input.body = item.body;
    const wi = upsertWorkItem(options.db, input);
    result.upserted++;
    if (wi.created) result.created++;

    for (const link of item.links) {
      upsertLink(options.db, {
        fromSource: "confluence",
        fromExternalId: item.externalId,
        toSource: link.source,
        toExternalId: link.externalId,
        relation: link.relationship,
        origin: "deterministic",
        confidence: 1
      });
    }
  }

  return result;
}

export function detectConfluenceRequirementDrift(
  db: OpenedDatabase,
  changedPages: ConfluencePage[]
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const seen = new Set<string>();

  for (const page of changedPages) {
    const pageItem = normalizeConfluencePage(page);
    const affectedItems = affectedActiveGitHubWork(db, pageItem.externalId);

    for (const affected of affectedItems) {
      const dedupKey = `confluence_doc_changed:${pageItem.externalId}:${affected.externalId}:${page.version ?? page.updatedAt.toISOString()}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      findings.push({
        type: "confluence_doc_changed_active_work",
        workItemTitle: affected.title,
        workItemUrl: affected.externalUrl,
        workItemStatus: affected.status ?? "open",
        jiraKey: "",
        jiraStatus: "",
        dedupKey,
        title: `Requirement drift: ${page.title} changed while ${affected.title} is active`,
        body:
          `Confluence ${pageItem.kind} "${page.title}" changed while linked GitHub work ` +
          `"${affected.title}" is still ${affected.status ?? "open"}.\n` +
          `${page.url}\n${affected.externalUrl}`
      });
    }
  }

  return findings;
}

function affectedActiveGitHubWork(
  db: OpenedDatabase,
  confluenceExternalId: string
): NonNullable<ReturnType<typeof getWorkItem>>[] {
  const affected = new Map<string, NonNullable<ReturnType<typeof getWorkItem>>>();

  for (const link of getLinksFrom(db, confluenceExternalId)) {
    if (link.origin !== "deterministic" && link.origin !== "manual") continue;

    if (link.toSource === "github") {
      const item = getWorkItem(db, "github", link.toExternalId);
      if (isActiveGitHubWork(item)) affected.set(item.externalId, item);
      continue;
    }

    if (link.toSource === "jira") {
      for (const githubLink of getLinksTo(db, link.toExternalId)) {
        if (githubLink.origin !== "deterministic" && githubLink.origin !== "manual") continue;
        if (githubLink.fromSource !== "github") continue;
        const item = getWorkItem(db, "github", githubLink.fromExternalId);
        if (isActiveGitHubWork(item)) affected.set(item.externalId, item);
      }
    }
  }

  return [...affected.values()];
}

function isActiveGitHubWork(
  item: ReturnType<typeof getWorkItem>
): item is NonNullable<ReturnType<typeof getWorkItem>> {
  if (!item) return false;
  if (item.source !== "github") return false;
  if (item.kind !== "pull_request" && item.kind !== "issue") return false;
  return ACTIVE_GITHUB_STATUSES.has(item.status ?? "open");
}
