CREATE TABLE `blockers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`work_item_id` integer NOT NULL,
	`source_change_id` integer,
	`type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`occurred_at` text NOT NULL,
	`resolved_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_change_id`) REFERENCES `source_changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `emitted_feed_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`source_url` text,
	`dedup_key` text NOT NULL,
	`emitted_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `emitted_feed_messages_dedup_key_idx` ON `emitted_feed_messages` (`dedup_key`);--> statement-breakpoint
CREATE TABLE `milestone_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`work_item_id` integer NOT NULL,
	`step_id` integer NOT NULL,
	`previous_state` text NOT NULL,
	`new_state` text NOT NULL,
	`occurred_at` text NOT NULL,
	`emitted` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`step_id`) REFERENCES `plan_steps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `plan_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`work_item_id` integer NOT NULL,
	`source` text NOT NULL,
	`parsed_at` text NOT NULL,
	`raw_body` text NOT NULL,
	`step_count` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `plan_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` integer NOT NULL,
	`step_order` integer NOT NULL,
	`text` text NOT NULL,
	`completed` integer NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `plan_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `work_items` ADD `body` text;