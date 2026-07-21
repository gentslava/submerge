ALTER TABLE `sources` ADD `last_refresh_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `last_refresh_success_at` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `next_refresh_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `refresh_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `last_refresh_error` text;