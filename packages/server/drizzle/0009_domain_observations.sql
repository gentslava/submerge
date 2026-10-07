CREATE TABLE `domain_daily_stats` (
	`day` text NOT NULL,
	`fqdn` text NOT NULL,
	`connection_count` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`day`, `fqdn`),
	CONSTRAINT "domain_daily_stats_count_check" CHECK("domain_daily_stats"."connection_count" >= 1),
	CONSTRAINT "domain_daily_stats_first_seen_check" CHECK("domain_daily_stats"."first_seen_at" >= 0),
	CONSTRAINT "domain_daily_stats_last_seen_check" CHECK("domain_daily_stats"."last_seen_at" >= "domain_daily_stats"."first_seen_at")
);
--> statement-breakpoint
CREATE TABLE `domain_observations` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`fqdn` text NOT NULL,
	`observed_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`transport` text NOT NULL,
	`source` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "domain_observations_timestamp_check" CHECK("domain_observations"."observed_at" >= 0),
	CONSTRAINT "domain_observations_last_seen_check" CHECK("domain_observations"."last_seen_at" >= "domain_observations"."observed_at"),
	CONSTRAINT "domain_observations_transport_check" CHECK("domain_observations"."transport" in ('tcp', 'udp')),
	CONSTRAINT "domain_observations_source_check" CHECK("domain_observations"."source" in ('mihomo-log', 'connection-snapshot')),
	CONSTRAINT "domain_observations_count_check" CHECK("domain_observations"."count" >= 1)
);
--> statement-breakpoint
CREATE INDEX `domain_observations_reconcile_idx` ON `domain_observations` (`fqdn`,`transport`,`observed_at`,`source`);--> statement-breakpoint
CREATE INDEX `domain_observations_retention_idx` ON `domain_observations` (`last_seen_at`);