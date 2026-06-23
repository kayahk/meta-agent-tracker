PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_blockers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`work_item_id` integer,
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
INSERT INTO `__new_blockers`("id", "work_item_id", "source_change_id", "type", "status", "title", "detail", "occurred_at", "resolved_at", "created_at") SELECT "id", "work_item_id", "source_change_id", "type", "status", "title", "detail", "occurred_at", "resolved_at", "created_at" FROM `blockers`;--> statement-breakpoint
DROP TABLE `blockers`;--> statement-breakpoint
ALTER TABLE `__new_blockers` RENAME TO `blockers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
