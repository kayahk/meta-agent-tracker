CREATE TABLE `links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_source` text NOT NULL,
	`from_external_id` text NOT NULL,
	`to_source` text NOT NULL,
	`to_external_id` text NOT NULL,
	`relation` text DEFAULT 'references' NOT NULL,
	`origin` text DEFAULT 'deterministic' NOT NULL,
	`confidence` real,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_from_to_idx` ON `links` (`from_external_id`,`to_external_id`);
