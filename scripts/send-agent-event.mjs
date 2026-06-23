#!/usr/bin/env node
/**
 * Post an agent event to the meta-agent transparency endpoint.
 *
 * Usage:
 *   META_AGENT_API_URL=http://127.0.0.1:4317 \
 *   META_AGENT_AGENT_EVENT_TOKEN=... \
 *   node scripts/send-agent-event.mjs <<'JSON'
 *   {"agent":"hermes","eventType":"task_started","task":"...","occurredAt":"2026-06-18T10:00:00.000Z"}
 *   JSON
 */

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8").trim();

if (!raw) {
  console.error("Expected an agent event JSON payload on stdin.");
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(raw);
} catch (error) {
  console.error(`Invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

if (!payload.occurredAt) {
  payload.occurredAt = new Date().toISOString();
}

const baseUrl = process.env.META_AGENT_API_URL ?? "http://127.0.0.1:4317";
const token = process.env.META_AGENT_AGENT_EVENT_TOKEN;
const endpoint = new URL("/api/agent-events", baseUrl);

const headers = { "Content-Type": "application/json" };
if (token) headers.Authorization = `Bearer ${token}`;

const response = await fetch(endpoint, {
  method: "POST",
  headers,
  body: JSON.stringify(payload)
});

const text = await response.text();
if (!response.ok) {
  console.error(`meta-agent rejected event (${response.status}): ${text}`);
  process.exit(1);
}

console.log(text);
