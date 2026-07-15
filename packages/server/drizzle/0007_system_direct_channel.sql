CREATE TABLE `__new_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`target` text DEFAULT 'proxy' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`policy` text,
	`matcher` text NOT NULL,
	`direct_presets` text,
	`last_reason` text,
	`last_reason_at` integer,
	CONSTRAINT "channels_target_check" CHECK(`target` in ('proxy', 'direct')),
	CONSTRAINT "channels_target_policy_check" CHECK((`target` = 'proxy' and `policy` is not null) or (`target` = 'direct' and `policy` is null)),
	CONSTRAINT "channels_target_default_check" CHECK(`target` = 'proxy' or `is_default` = false),
	CONSTRAINT "channels_target_presets_check" CHECK((`target` = 'proxy' and `direct_presets` is null) or (`target` = 'direct' and `direct_presets` is not null))
);
--> statement-breakpoint
INSERT INTO `__new_channels` (`id`, `name`, `target`, `priority`, `enabled`, `is_default`, `policy`, `matcher`, `direct_presets`, `last_reason`, `last_reason_at`)
SELECT `id`, `name`, 'proxy', `priority`, `enabled`, `is_default`, `policy`, `matcher`, NULL, `last_reason`, `last_reason_at`
FROM `channels`;
--> statement-breakpoint
CREATE TABLE `__new_channel_pool` (
	`channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `__new_channels` (`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_channel_pool` (`channel_id`, `kind`, `ref`)
SELECT `channel_id`, `kind`, `ref`
FROM `channel_pool`;
--> statement-breakpoint
DROP TABLE `channel_pool`;
--> statement-breakpoint
DROP TABLE `channels`;
--> statement-breakpoint
ALTER TABLE `__new_channels` RENAME TO `channels`;
--> statement-breakpoint
ALTER TABLE `__new_channel_pool` RENAME TO `channel_pool`;
--> statement-breakpoint
CREATE INDEX `channel_pool_channel_id_idx` ON `channel_pool` (`channel_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_pool_channel_id_kind_ref_unique` ON `channel_pool` (`channel_id`, `kind`, `ref`);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_direct_target_unique` ON `channels` (`target`) WHERE `target` = 'direct';
