import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoopHermesClient, HttpHermesClient, type HermesMessage } from "./index.js";

describe("NoopHermesClient", () => {
  it("always returns false", async () => {
    const client = new NoopHermesClient();
    const result = await client.send({
      category: "milestone_reached",
      title: "Test",
      body: "Test body"
    });
    expect(result).toBe(false);
  });
});

describe("HttpHermesClient", () => {
  let port: number;
  let server: ReturnType<typeof createServer>;
  let messages: any[];

  beforeEach(() => {
    messages = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const signature = req.headers["x-hub-signature-256"];
        messages.push({ body, signature });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    // Use port 0 to let the OS pick an available port
    server.listen(0);
  });

  afterEach(() => {
    server.close();
  });

  it("sends a message and returns true on success", async () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const client = new HttpHermesClient(`http://localhost:${port}/webhook`);

    const result = await client.send({
      category: "milestone_reached",
      title: "Step completed",
      body: "Step one finished",
      sourceUrl: "https://example.com/pr/1"
    });

    expect(result).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].body.category).toBe("milestone_reached");
    expect(messages[0].body.title).toBe("Step completed");
    expect(messages[0].body.sourceUrl).toBe("https://example.com/pr/1");
  });

  it("deduplicates messages with the same category:title", async () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const client = new HttpHermesClient(`http://localhost:${port}/webhook`);

    const msg: HermesMessage = {
      category: "blocker_detected",
      title: "CI Failed",
      body: "Tests failed"
    };

    await client.send(msg);
    await client.send(msg);

    expect(messages).toHaveLength(1);
  });

  it("uses an explicit dedupKey when provided", async () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const client = new HttpHermesClient(`http://localhost:${port}/webhook`);

    await client.send({
      category: "daily_digest",
      title: "Status update — 2026-06-17 14:00 UTC",
      body: "first hour",
      dedupKey: "daily_digest:2026-06-17T14"
    });
    await client.send({
      category: "daily_digest",
      title: "Status update — 2026-06-17 15:00 UTC",
      body: "second hour",
      dedupKey: "daily_digest:2026-06-17T15"
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].body.dedupKey).toBe("daily_digest:2026-06-17T14");
    expect(messages[1].body.dedupKey).toBe("daily_digest:2026-06-17T15");
  });

  it("returns false when the server returns non-2xx", async () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    // Override server to return 500
    server.close();
    server = createServer((_req, res) => {
      res.writeHead(500);
      res.end("error");
    });
    server.listen(port);

    const client = new HttpHermesClient(`http://localhost:${port}/webhook`);
    const result = await client.send({
      category: "milestone_reached",
      title: "Test",
      body: "Body"
    });

    expect(result).toBe(false);
  });

  it("returns false on timeout", async () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    // Override with a slow server
    server.close();
    server = createServer((_req, res) => {
      // Never respond — but we need to consume the request
      _req.resume();
    });
    server.listen(port);

    const client = new HttpHermesClient(`http://localhost:${port}/webhook`, 50);
    const result = await client.send({
      category: "milestone_reached",
      title: "Test",
      body: "Body"
    });

    expect(result).toBe(false);
  });

  it("signs the request with HMAC-SHA256 when a secret is provided", async () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const client = new HttpHermesClient(`http://localhost:${port}/webhook`, 5000, "super-secret");

    await client.send({
      category: "milestone_reached",
      title: "Test",
      body: "Body"
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("does not sign when no secret is configured", async () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const client = new HttpHermesClient(`http://localhost:${port}/webhook`);

    await client.send({
      category: "milestone_reached",
      title: "Test",
      body: "Body"
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].signature).toBeUndefined();
  });

  it("returns false when endpoint is unreachable", async () => {
    const client = new HttpHermesClient(`http://localhost:59999/nonexistent`, 100);
    const result = await client.send({
      category: "milestone_reached",
      title: "Test",
      body: "Body"
    });
    expect(result).toBe(false);
  });
});
