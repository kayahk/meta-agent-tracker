import { createHmac, timingSafeEqual } from "node:crypto";

const signaturePrefix = "sha256=";

export function createGitHubWebhookSignature(payload: string, secret: string) {
  const digest = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return `${signaturePrefix}${digest}`;
}

export function verifyGitHubWebhookSignature(payload: string, signature: string, secret: string) {
  if (!signature.startsWith(signaturePrefix)) {
    return false;
  }

  const expected = Buffer.from(createGitHubWebhookSignature(payload, secret), "utf8");
  const actual = Buffer.from(signature, "utf8");

  if (expected.byteLength !== actual.byteLength) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
