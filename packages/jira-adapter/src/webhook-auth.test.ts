import { describe, expect, it } from "vitest";
import { verifyJiraWebhookSecret } from "./index.js";

describe("verifyJiraWebhookSecret", () => {
  it("accepts a matching secret", () => {
    expect(verifyJiraWebhookSecret("my-secret", "my-secret")).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(verifyJiraWebhookSecret("wrong", "my-secret")).toBe(false);
  });

  it("rejects missing values", () => {
    expect(verifyJiraWebhookSecret(undefined, "my-secret")).toBe(false);
    expect(verifyJiraWebhookSecret("value", "")).toBe(false);
  });
});
