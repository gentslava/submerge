CREATE TABLE `channel_pool` (
	`channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channel_pool_channel_id_idx` ON `channel_pool` (`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_pool_channel_id_kind_ref_unique` ON `channel_pool` (`channel_id`,`kind`,`ref`);