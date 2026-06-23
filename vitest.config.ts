import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // Prefer package "development" exports (src/) so tests never hit stale dist/.
    conditions: ["development", "import", "module", "default"],
    dedupe: ["drizzle-orm", "better-sqlite3"],
    alias: {
      "@meta-agent/config": `${root}packages/config/src/index.ts`,
      "@meta-agent/core": `${root}packages/core/src/index.ts`,
      "@meta-agent/github": `${root}packages/github/src/index.ts`,
      "@meta-agent/github-adapter": `${root}packages/github-adapter/src/index.ts`,
      "@meta-agent/hermes": `${root}packages/hermes/src/index.ts`,
      "@meta-agent/jira-adapter": `${root}packages/jira-adapter/src/index.ts`,
      "@meta-agent/llm-client": `${root}packages/llm-client/src/index.ts`,
      "@meta-agent/plan-parser": `${root}packages/plan-parser/src/index.ts`,
      "@meta-agent/storage/test-utils": `${root}packages/storage/src/test-utils.ts`,
      "@meta-agent/storage": `${root}packages/storage/src/index.ts`,
      "@meta-agent/work-catalog": `${root}packages/work-catalog/src/index.ts`
    }
  },
  test: {
    globals: true,
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    testTimeout: 10_000
  }
});
