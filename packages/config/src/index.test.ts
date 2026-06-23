import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

describe("loadConfig", () => {
  it("provides local development defaults", () => {
    const config = loadConfig({});

    expect(config.databaseUrl).toBe("./data/meta-agent.sqlite");
    expect(config.api.port).toBe(4317);
    expect(config.hermes.endpoint).toBeUndefined();
    expect(config.github.planDocsPath).toBe("docs");
    expect(config.github.planRepositories).toBeUndefined();
  });

  it("parses optional generic repository and scan settings", () => {
    const config = loadConfig({
      META_AGENT_GITHUB_REPOSITORIES: "example-org/api, example-org/web",
      META_AGENT_GITHUB_ASSIGNED_TO: "alice,bob",
      META_AGENT_GITHUB_PLAN_REPOSITORIES: "example-org/docs",
      META_AGENT_GITHUB_PLAN_DOCS_PATH: "planning",
      META_AGENT_SCAN_INTERVAL_MS: "300000"
    });

    expect(config.github.repositories).toEqual(["example-org/api", "example-org/web"]);
    expect(config.github.assignedTo).toEqual(["alice", "bob"]);
    expect(config.github.planRepositories).toEqual(["example-org/docs"]);
    expect(config.github.planDocsPath).toBe("planning");
    expect(config.scanIntervalMs).toBe(300000);
  });
});
