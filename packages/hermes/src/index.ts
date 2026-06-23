/**
 * Hermes message types and transport clients.
 *
 * HermesMessage: the feed message format
 * HermesClient: interface for delivery
 * NoopHermesClient: discards messages (for testing/dry-run)
 * HttpHermesClient: POSTs to a Hermes gateway endpoint
 */

import { createHmac } from "node:crypto";

export interface HermesMessage {
  category:
    | "milestone_reached"
    | "blocker_detected"
    | "blocker_resolved"
    | "pr_opened"
    | "pr_merged"
    | "plan_updated"
    | "review_needed"
    | "stale_work"
    | "requirement_drift"
    | "daily_digest";
  title: string;
  body: string;
  sourceUrl?: string;
  /** Optional explicit key for client-side suppression and downstream visibility. */
  dedupKey?: string;
}

export interface HermesClient {
  /** Send a feed message. Returns true if delivered, false if suppressed/noop. */
  send(message: HermesMessage): Promise<boolean>;
}

// ── Noop ────────────────────────────────────────────────────────

export class NoopHermesClient implements HermesClient {
  async send(_message: HermesMessage): Promise<boolean> {
    return false;
  }
}

// ── HTTP ────────────────────────────────────────────────────────

/**
 * POSTs feed messages to a Hermes-compatible endpoint.
 * Handles retries, timeouts, HMAC-SHA256 signing, and deduplication.
 */
export class HttpHermesClient implements HermesClient {
  private endpoint: URL;
  private timeoutMs: number;
  private secret: string | undefined;
  private seenKeys: Set<string> = new Set();

  constructor(endpoint: string, timeoutMs = 5000, secret?: string) {
    this.endpoint = new URL(endpoint);
    this.timeoutMs = timeoutMs;
    this.secret = secret;
  }

  async send(message: HermesMessage): Promise<boolean> {
    const dedupKey = message.dedupKey ?? `${message.category}:${message.title}`;
    if (this.seenKeys.has(dedupKey)) return false;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const body = JSON.stringify({
        category: message.category,
        title: message.title,
        body: message.body,
        sourceUrl: message.sourceUrl,
        dedupKey
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };

      // Sign with HMAC-SHA256 if a webhook secret is configured
      if (this.secret) {
        headers["X-Hub-Signature-256"] =
          "sha256=" + createHmac("sha256", this.secret).update(body).digest("hex");
      }

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal
      });

      clearTimeout(timer);

      if (response.ok) {
        this.seenKeys.add(dedupKey);
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }
}
