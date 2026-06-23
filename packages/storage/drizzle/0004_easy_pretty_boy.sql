CREATE TABLE `agent_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer,
	`agent` text NOT NULL,
	`external_session_id` text,
	`event_type` text NOT NULL,
	`task` text NOT NULL,
	`status` text,
	`confidence` text DEFAULT 'agent_claimed' NOT NULL,
	`ledger_topic` text,
	`repo` text,
	`branch` text,
	`pr_url` text,
	`commit_sha` text,
	`jira_key` text,
	`plan_repo` text,
	`plan_path` text,
	`plan_items_json` text,
	`evidence_json` text,
	`payload_json` text NOT NULL,
	`idempotency_key` text,
	`occurred_at` text NOT NULL,
	`ingested_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_events_idempotency_key_idx` ON `agent_events` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_session_id` text NOT NULL,
	`agent` text NOT NULL,
	`platform` text,
	`thread_id` text,
	`initial_task` text,
	`status` text DEFAULT 'active' NOT NULL,
	`summary` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_external_session_id_idx` ON `agent_sessions` (`external_session_id`);