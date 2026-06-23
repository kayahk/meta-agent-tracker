import { loadConfig } from "@meta-agent/config";
import { openDatabase } from "@meta-agent/storage";
import {
  HttpConfluenceClient,
  NoopConfluenceClient,
  type ConfluenceClient
} from "@meta-agent/confluence-adapter";
import { HttpJiraClient, NoopJiraClient, type JiraClient } from "@meta-agent/jira-adapter";
import { LlmClient, NoopLlmClient } from "@meta-agent/llm-client";
import { HttpHermesClient, NoopHermesClient, type HermesClient } from "@meta-agent/hermes";
import {
  GitHubApiClient,
  scanWorkCatalog,
  deliverDigest,
  reconcileLedger,
  reconcileJiraLedger,
  deliverStatusDigest,
  persistCatalogLinks,
  detectGitHubJiraDrift,
  detectJiraWithoutGithub,
  deliverDrift,
  reconcileConfluenceLedger,
  detectConfluenceRequirementDrift,
  reconcilePlanDocuments,
  reconcileWorkflowBlockers,
  reconcileAgentEvidence
} from "@meta-agent/work-catalog";
import { readFileSync } from "node:fs";

export function startWorker() {
  const config = loadConfig();
  const database = openDatabase(config.databaseUrl);

  // Jira client (real if configured, noop otherwise)
  let jira: JiraClient = new NoopJiraClient();
  if (config.jira.url && config.jira.pat) {
    jira = new HttpJiraClient({ url: config.jira.url, pat: config.jira.pat });
  }

  // Confluence client (real if configured, noop otherwise)
  let confluence: ConfluenceClient = new NoopConfluenceClient();
  if (config.confluence.url && config.confluence.pat) {
    confluence = new HttpConfluenceClient({
      url: config.confluence.url,
      pat: config.confluence.pat
    });
  }

  // LLM client (real if configured, noop otherwise)
  let llm: LlmClient = new NoopLlmClient();
  if (config.llm.apiUrl && config.llm.apiKey && config.llm.model) {
    llm = new LlmClient({
      apiUrl: config.llm.apiUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model
    });
  }

  // Hermes client
  const hermes: HermesClient = config.hermes.endpoint
    ? new HttpHermesClient(config.hermes.endpoint, 5000, config.hermes.webhookSecret)
    : new NoopHermesClient();

  // GitHub API client
  const github = new GitHubApiClient({
    appId: config.github.appId ?? "",
    privateKeyPath: config.github.privateKeyPath ?? "",
    installationIds: config.github.installationIds,
    installationId: config.github.installationId
  });

  const configuredRepos = config.github.repositories ?? [];
  const assignees = config.github.assignedTo;

  // Schedule: run catalog scan every hour by default.
  const SCAN_INTERVAL_MS = config.scanIntervalMs ?? 60 * 60 * 1000; // 1 hour
  const workerId = Math.random().toString(36).slice(2, 8);

  async function runScan() {
    try {
      console.log(`[${workerId}] Reconciling ledger from GitHub...`);
      const repos =
        configuredRepos.length > 0 ? configuredRepos : await github.listInstalledRepos();
      const planRepos = config.github.planRepositories ?? repos;

      // 0. Optional plan-document reconciliation. Configure
      //    META_AGENT_GITHUB_PLAN_REPOSITORIES to narrow this to selected repos.
      if (planRepos.length > 0) {
        const planDocuments = await github.scanPlanDocuments(planRepos, {
          docsPath: config.github.planDocsPath
        });
        const planRecon = await reconcilePlanDocuments({
          db: database,
          documents: planDocuments,
          hermes
        });
        console.log(
          `[${workerId}] Reconciled ${planRecon.upserted} plan document(s) ` +
            `(${planRecon.created} new, ${planRecon.milestones} milestone(s)).`
        );
      }

      // 1. Reconcile: re-derive open work from the REST API into the ledger,
      //    backfilling anything that webhooks may have missed.
      const openItems = await github.scanOpenPrs(repos, assignees);
      const recentClosed = await github.scanRecentClosedPrs(repos, {
        since: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
        limitPerRepo: 50
      });
      const recon = await reconcileLedger({
        db: database,
        items: [...openItems, ...recentClosed],
        hermes
      });
      console.log(
        `[${workerId}] Reconciled ${recon.upserted} item(s) ` +
          `(${recon.created} new, ${recon.milestones} milestone(s)).`
      );

      const recentWorkflowRuns = await github.scanRecentWorkflowRuns(repos, {
        since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        limitPerRepo: 100
      });
      const workflowRecon = reconcileWorkflowBlockers({ db: database, runs: recentWorkflowRuns });
      if (workflowRecon.resolved > 0) {
        console.log(
          `[${workerId}] Resolved ${workflowRecon.resolved} stale workflow blocker(s) from current GitHub runs.`
        );
      }

      if (config.confluence.url && config.confluence.pat) {
        const confluenceChanges = await confluence.fetchRecentChanges(
          new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          config.confluence.spaces ?? []
        );
        const confluencePages = confluenceChanges.map((change) => change.page);
        const confluenceRecon = reconcileConfluenceLedger({ db: database, pages: confluencePages });
        const confluenceDrift = detectConfluenceRequirementDrift(database, confluencePages);
        const confluenceAlerts = await deliverDrift(hermes, database, confluenceDrift);
        console.log(
          `[${workerId}] Confluence reconciled ${confluenceRecon.upserted} page(s) ` +
            `(${confluenceRecon.created} new); drift ${confluenceDrift.length} finding(s), ` +
            `${confluenceAlerts} new alert(s).`
        );
      } else if (config.confluence.url || config.confluence.pat) {
        console.warn(
          `[${workerId}] Confluence reconciliation skipped: both META_AGENT_CONFLUENCE_URL and META_AGENT_CONFLUENCE_PAT are required.`
        );
      }

      const agentEvidenceRecon = reconcileAgentEvidence({
        db: database,
        items: [...openItems, ...recentClosed],
        runs: recentWorkflowRuns
      });
      if (agentEvidenceRecon.verified > 0 || agentEvidenceRecon.observed > 0) {
        console.log(
          `[${workerId}] Reconciled agent evidence ` +
            `(${agentEvidenceRecon.verified} verified, ${agentEvidenceRecon.observed} system-observed).`
        );
      }

      // 2. Emit the status digest, built from the (now reconciled) ledger.
      const digestDelivered = await deliverStatusDigest(hermes, database);
      console.log(
        `[${workerId}] Status digest ${digestDelivered ? "delivered" : "suppressed or failed"}.`
      );

      // 3. Jira correlation + drift detection (when Jira is configured).
      if (config.jira.url) {
        // Current Jira statuses for linked issues (non-done issues only;
        // absence implies done, which is treated as "no drift").
        const jiraIssues = await jira.searchIssues(
          "status != Done AND status != Closed order by updated DESC",
          200
        );
        const jiraRecon = reconcileJiraLedger({ db: database, issues: jiraIssues });
        console.log(
          `[${workerId}] Jira reconciled ${jiraRecon.upserted} issue(s) ` +
            `(${jiraRecon.created} new).`
        );

        const statusByExternalId = new Map<string, string>();
        for (const ji of jiraIssues) {
          const name = ji.fields?.status?.name;
          if (name) statusByExternalId.set(`issue:${ji.key}`, name);
        }

        // Optional advisory catalog + model-proposed links (when LLM configured).
        // Proposed links are stored for human/agent inspection, but drift detection
        // intentionally ignores them until deterministic or manual acceptance.
        if (config.llm.apiUrl) {
          const catalog = await scanWorkCatalog({
            db: database,
            github,
            jira,
            llm,
            repos,
            assignees
          });
          const linkCount = persistCatalogLinks(database, catalog);
          await deliverDigest(hermes, catalog);
          console.log(
            `[${workerId}] Work-catalog: ${catalog.matchedCount} matched, ` +
              `${catalog.unmatchedCount} unmatched, ${linkCount} proposed LLM link(s).`
          );
        }

        // Only authoritative links are used for drift detection; model-proposed
        // correlations remain advisory evidence.
        const drift = [
          ...detectGitHubJiraDrift(database, statusByExternalId),
          ...detectJiraWithoutGithub(database, statusByExternalId)
        ];
        const alerts = await deliverDrift(hermes, database, drift);
        console.log(`[${workerId}] Drift: ${drift.length} finding(s), ${alerts} new alert(s).`);
      }
    } catch (err) {
      console.error(`[${workerId}] Scan failed:`, err);
    }
  }

  // Run immediately on startup, then periodically. The interval is intentionally
  // NOT unref'd: the worker is a long-running service and must stay alive to
  // deliver scheduled digests.
  void runScan();
  const intervalId = setInterval(() => void runScan(), SCAN_INTERVAL_MS);

  return {
    databasePath: database.path,
    startedAt: new Date(),
    workerId,
    scanIntervalMs: SCAN_INTERVAL_MS,
    stop: () => clearInterval(intervalId)
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = startWorker();
  console.log(
    `meta-agent worker started — ${worker.workerId}, scanning every ${worker.scanIntervalMs / 1000}s`
  );
}
