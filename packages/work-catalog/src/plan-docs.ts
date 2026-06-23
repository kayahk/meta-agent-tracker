import { syncPlanFromBody } from "@meta-agent/github-adapter";
import { upsertLink, upsertWorkItem, type OpenedDatabase } from "@meta-agent/storage";
import type { HermesClient } from "@meta-agent/hermes";
import type { ReconcileResult } from "./reconcile.js";

export interface PlanDocument {
  repo: string;
  path: string;
  title: string;
  body: string;
  htmlUrl: string;
  updatedAt: string;
}

export interface PlanStatusRow {
  item: string;
  status: string;
  notes: string;
}

export interface ParsedPlanDocument {
  title: string;
  statusRows: PlanStatusRow[];
  checklist: { total: number; completed: number };
  prNumbers: number[];
  summary: string;
  status: "open" | "closed";
}

export const DONE_STATUS =
  /^(done|complete|completed|closed|merged|implemented|shipped|verified|runtime verified|superseded)$/i;
const STATUS_HEADER = /\bstatus\b/i;

export function parsePlanDocument(document: PlanDocument): ParsedPlanDocument {
  const title = extractTitle(document.body) ?? document.title;
  const statusRows = extractStatusRows(document.body);
  const checklist = extractChecklist(document.body);
  const prNumbers = extractPrNumbers(document.body);
  const status = inferPlanStatus(statusRows, checklist);
  const summary = buildPlanSummary(statusRows, checklist, prNumbers);

  return { title, statusRows, checklist, prNumbers, summary, status };
}

export function isDonePlanStatus(status: string): boolean {
  return DONE_STATUS.test(status.trim());
}

export async function reconcilePlanDocuments(options: {
  db: OpenedDatabase;
  documents: PlanDocument[];
  hermes?: HermesClient | undefined;
}): Promise<ReconcileResult> {
  const { db, documents, hermes } = options;
  const result: ReconcileResult = { upserted: 0, created: 0, milestones: 0 };

  for (const document of documents) {
    const parsed = parsePlanDocument(document);
    const externalId = planExternalId(document);
    const previous = hermes ? getExistingPlanState(db, externalId) : null;
    const body = renderPlanLedgerBody(document, parsed);
    const wi = upsertWorkItem(db, {
      source: "github",
      externalId,
      kind: "plan",
      title: parsed.title,
      status: parsed.status,
      owner: "unassigned",
      body,
      externalUrl: document.htmlUrl,
      updatedAt: new Date(document.updatedAt)
    });

    result.upserted++;
    if (wi.created) result.created++;

    if (!wi.created && hermes && previous?.body !== body) {
      await hermes.send({
        category: "plan_updated",
        title: `Plan updated: ${parsed.title}`,
        body: `${parsed.title} changed. ${parsed.summary}`,
        sourceUrl: document.htmlUrl,
        dedupKey: `plan_updated:${externalId}:${document.updatedAt}`
      });
    }

    for (const prNumber of parsed.prNumbers) {
      upsertLink(db, {
        fromSource: "github",
        fromExternalId: externalId,
        toSource: "github",
        toExternalId: `pr:${document.repo}#${prNumber}`,
        relation: "references",
        origin: "deterministic",
        confidence: 1
      });
    }

    const effects = await syncPlanFromBody(db, wi.id, document.body, document.htmlUrl, hermes);
    result.milestones += effects.filter((effect) => effect.type === "milestone_created").length;
  }

  return result;
}

export function planExternalId(document: Pick<PlanDocument, "repo" | "path">): string {
  return `plan:${document.repo}:${document.path}`;
}

function getExistingPlanState(
  db: OpenedDatabase,
  externalId: string
): { body: string | null } | null {
  const row = db.sqlite
    .prepare("SELECT body FROM work_items WHERE source = 'github' AND external_id = ?")
    .get(externalId) as { body: string | null } | undefined;
  return row ?? null;
}

function extractTitle(body: string): string | undefined {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

function extractStatusRows(body: string): PlanStatusRow[] {
  const rows: PlanStatusRow[] = [];
  const lines = body.split(/\r?\n/);
  let header: string[] | null = null;
  let statusIndex = -1;
  let itemIndex = 0;
  let notesIndex = -1;

  for (const line of lines) {
    if (!line.trim().startsWith("|")) {
      header = null;
      continue;
    }

    const cells = parseTableCells(line);
    if (cells.length < 2) continue;

    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;

    if (!header && cells.some((cell) => STATUS_HEADER.test(cell))) {
      header = cells.map((cell) => cell.toLowerCase());
      statusIndex = header.findIndex((cell) => STATUS_HEADER.test(cell));
      itemIndex = Math.max(
        0,
        header.findIndex((cell) => /^(area|task|phase|item|work|component|#)$/i.test(cell))
      );
      notesIndex = header.findIndex((cell) => /notes?|details?|outcome/i.test(cell));
      continue;
    }

    if (!header || statusIndex < 0) continue;
    const status = cells[statusIndex]?.trim() ?? "";
    const item = cells[itemIndex]?.trim() ?? "";
    const notes =
      notesIndex >= 0
        ? (cells[notesIndex]?.trim() ?? "")
        : cells.filter((_, idx) => idx !== itemIndex && idx !== statusIndex).join(" — ");

    if (!item || !status || /^status$/i.test(status)) continue;
    rows.push({
      item: stripMarkdown(item),
      status: stripMarkdown(status),
      notes: stripMarkdown(notes)
    });
  }

  return rows;
}

function parseTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function extractChecklist(body: string): { total: number; completed: number } {
  let total = 0;
  let completed = 0;
  for (const match of body.matchAll(/^\s*[-*]\s+\[([ xX])\]/gm)) {
    total++;
    if ((match[1] ?? "").toLowerCase() === "x") completed++;
  }
  return { total, completed };
}

function extractPrNumbers(body: string): number[] {
  const numbers = new Set<number>();
  for (const match of body.matchAll(/(?:^|[^\w/])#(\d+)\b/g)) {
    numbers.add(Number(match[1]));
  }
  for (const match of body.matchAll(/\/pull\/(\d+)\b/g)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

function inferPlanStatus(
  rows: PlanStatusRow[],
  checklist: { total: number; completed: number }
): "open" | "closed" {
  if (rows.length > 0) {
    return rows.every((row) => isDonePlanStatus(row.status)) ? "closed" : "open";
  }
  if (checklist.total > 0) return checklist.completed === checklist.total ? "closed" : "open";
  return "open";
}

function buildPlanSummary(
  rows: PlanStatusRow[],
  checklist: { total: number; completed: number },
  prNumbers: number[]
): string {
  const lines: string[] = [];
  if (rows.length) {
    for (const row of rows.slice(0, 8)) {
      lines.push(`${row.item} — ${row.status}${row.notes ? ` (${row.notes})` : ""}`);
    }
  }
  if (checklist.total)
    lines.push(`${checklist.completed}/${checklist.total} checklist items complete`);
  if (prNumbers.length)
    lines.push(`Referenced PRs: ${prNumbers.map((num) => `#${num}`).join(", ")}`);
  return lines.join("\n");
}

function renderPlanLedgerBody(document: PlanDocument, parsed: ParsedPlanDocument): string {
  return [
    `Source: ${document.path}`,
    `Status rows: ${parsed.statusRows.length}`,
    `Checklist: ${parsed.checklist.completed}/${parsed.checklist.total}`,
    `Referenced PRs: ${parsed.prNumbers.map((num) => `#${num}`).join(", ") || "none"}`,
    "",
    parsed.summary,
    "",
    document.body
  ].join("\n");
}

function stripMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .trim();
}
