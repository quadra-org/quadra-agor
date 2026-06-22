CREATE TABLE `external_runs` (
	`run_id` text(36) PRIMARY KEY NOT NULL,
	`created_by` text(36),
	`harness` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`capture_mode` text DEFAULT 'events-only' NOT NULL,
	`primary_anchor_type` text,
	`primary_branch_id` text(36),
	`summary_document_id` text(36),
	`data` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`completed_at` integer,
	`archived` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`primary_branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`summary_document_id`) REFERENCES `kb_documents`(`document_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `external_runs_created_by_idx` ON `external_runs` (`created_by`);--> statement-breakpoint
CREATE INDEX `external_runs_status_idx` ON `external_runs` (`status`);--> statement-breakpoint
CREATE INDEX `external_runs_harness_idx` ON `external_runs` (`harness`);--> statement-breakpoint
CREATE INDEX `external_runs_primary_branch_idx` ON `external_runs` (`primary_branch_id`);--> statement-breakpoint
CREATE INDEX `external_runs_created_at_idx` ON `external_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `external_runs_archived_idx` ON `external_runs` (`archived`);--> statement-breakpoint
CREATE TABLE `external_run_events` (
	`event_id` text(36) PRIMARY KEY NOT NULL,
	`run_id` text(36) NOT NULL,
	`event_type` text NOT NULL,
	`body` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `external_runs`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `external_run_events_run_created_idx` ON `external_run_events` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `external_run_events_run_idx` ON `external_run_events` (`run_id`);--> statement-breakpoint
CREATE INDEX `external_run_events_type_idx` ON `external_run_events` (`event_type`);--> statement-breakpoint
CREATE TABLE `external_run_links` (
	`link_id` text(36) PRIMARY KEY NOT NULL,
	`run_id` text(36) NOT NULL,
	`target_kind` text NOT NULL,
	`target_ref` text NOT NULL,
	`relationship` text DEFAULT 'secondary' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `external_runs`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `external_run_links_run_idx` ON `external_run_links` (`run_id`);--> statement-breakpoint
CREATE INDEX `external_run_links_run_relationship_idx` ON `external_run_links` (`run_id`,`relationship`);
