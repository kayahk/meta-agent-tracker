import { describe, expect, it } from "vitest";
import { createGitHubWebhookSignature, verifyGitHubWebhookSignature } from "./index.js";

describe("GitHub webhook signatures", () => {
  it("verifies a valid signature", () => {
    const payload = JSON.stringify({ action: "opened" });
    const signature = createGitHubWebhookSignature(payload, "secret");

    expect(verifyGitHubWebhookSignature(payload, signature, "secret")).toBe(true);
  });

  it("rejects modified payloads", () => {
    const signature = createGitHubWebhookSignature("{}", "secret");

    expect(verifyGitHubWebhookSignature('{"changed":true}', signature, "secret")).toBe(false);
  });
});
