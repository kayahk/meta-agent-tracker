import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  META_AGENT_DATABASE_URL: z.string().default("./data/meta-agent.sqlite"),
  META_AGENT_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  META_AGENT_API_HOST: z.string().default("127.0.0.1"),
  META_AGENT_API_PORT: z.coerce.number().int().positive().default(4317),
  META_AGENT_HERMES_ENDPOINT: z.string().url().optional().or(z.literal("")),
  META_AGENT_HERMES_WEBHOOK_SECRET: z.string().optional().or(z.literal("")),
  META_AGENT_AGENT_EVENT_TOKEN: z.string().optional().or(z.literal("")),
  META_AGENT_GITHUB_APP_ID: z.string().optional().or(z.literal("")),
  META_AGENT_GITHUB_PRIVATE_KEY_PATH: z.string().optional().or(z.literal("")),
  META_AGENT_GITHUB_WEBHOOK_SECRET: z.string().optional().or(z.literal("")),
  META_AGENT_GITHUB_INSTALLATION_ID: z.string().optional().or(z.literal("")),
  META_AGENT_GITHUB_REPOSITORIES: z.string().optional().or(z.literal("")),
  META_AGENT_GITHUB_ASSIGNED_TO: z.string().optional().or(z.literal("")),
  META_AGENT_GITHUB_PLAN_REPOSITORIES: z.string().optional().or(z.literal("")),
  META_AGENT_GITHUB_PLAN_DOCS_PATH: z.string().optional().or(z.literal("")),
  META_AGENT_SCAN_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  // Jira Cloud (email + API token = Basic Auth)
  META_AGENT_JIRA_URL: z.string().url().optional().or(z.literal("")),
  META_AGENT_JIRA_EMAIL: z.string().optional().or(z.literal("")),
  META_AGENT_JIRA_PAT: z.string().optional().or(z.literal("")),
  META_AGENT_JIRA_WEBHOOK_SECRET: z.string().optional().or(z.literal("")),
  // Confluence on-prem Data Center (bearer PAT, no email)
  META_AGENT_CONFLUENCE_URL: z.string().url().optional().or(z.literal("")),
  META_AGENT_CONFLUENCE_PAT: z.string().optional().or(z.literal("")),
  META_AGENT_CONFLUENCE_SPACES: z.string().optional().or(z.literal("")),
  // LLM (for semantic matching in work catalog)
  META_AGENT_LLM_API_URL: z.string().url().optional().or(z.literal("")),
  META_AGENT_LLM_API_KEY: z.string().optional().or(z.literal("")),
  META_AGENT_LLM_MODEL: z.string().optional().or(z.literal(""))
});

export type AppConfig = ReturnType<typeof loadConfig>;

let dotenvLoaded = false;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env === process.env && !dotenvLoaded) {
    const root = env.META_AGENT_ROOT ?? env.INIT_CWD ?? process.cwd();
    loadDotenv({ path: resolve(root, ".env") });
    dotenvLoaded = true;
  }

  const parsed = schema.parse(env);

  return {
    databaseUrl: parsed.META_AGENT_DATABASE_URL,
    logLevel: parsed.META_AGENT_LOG_LEVEL,
    api: {
      host: parsed.META_AGENT_API_HOST,
      port: parsed.META_AGENT_API_PORT
    },
    hermes: {
      endpoint: parsed.META_AGENT_HERMES_ENDPOINT || undefined,
      webhookSecret: parsed.META_AGENT_HERMES_WEBHOOK_SECRET || undefined
    },
    agentEvents: {
      token: parsed.META_AGENT_AGENT_EVENT_TOKEN || undefined
    },
    github: {
      appId: parsed.META_AGENT_GITHUB_APP_ID || undefined,
      privateKeyPath: parsed.META_AGENT_GITHUB_PRIVATE_KEY_PATH || undefined,
      webhookSecret: parsed.META_AGENT_GITHUB_WEBHOOK_SECRET || undefined,
      installationId: parsed.META_AGENT_GITHUB_INSTALLATION_ID || undefined,
      installationIds: parseCommaSeparated(parsed.META_AGENT_GITHUB_INSTALLATION_ID),
      repositories: parseCommaSeparated(parsed.META_AGENT_GITHUB_REPOSITORIES),
      assignedTo: parseCommaSeparated(parsed.META_AGENT_GITHUB_ASSIGNED_TO),
      planRepositories: parseCommaSeparated(parsed.META_AGENT_GITHUB_PLAN_REPOSITORIES),
      planDocsPath: parsed.META_AGENT_GITHUB_PLAN_DOCS_PATH || "docs"
    },
    scanIntervalMs: parsed.META_AGENT_SCAN_INTERVAL_MS,
    jira: {
      url: parsed.META_AGENT_JIRA_URL || undefined,
      email: parsed.META_AGENT_JIRA_EMAIL || undefined,
      pat: parsed.META_AGENT_JIRA_PAT || undefined,
      webhookSecret: parsed.META_AGENT_JIRA_WEBHOOK_SECRET || undefined
    },
    confluence: {
      url: parsed.META_AGENT_CONFLUENCE_URL || undefined,
      pat: parsed.META_AGENT_CONFLUENCE_PAT || undefined,
      spaces: parseCommaSeparated(parsed.META_AGENT_CONFLUENCE_SPACES)
    },
    llm: {
      apiUrl: parsed.META_AGENT_LLM_API_URL || undefined,
      apiKey: parsed.META_AGENT_LLM_API_KEY || undefined,
      model: parsed.META_AGENT_LLM_MODEL || undefined
    }
  };
}

function parseCommaSeparated(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}
