CREATE TABLE `domain_automatic_budgets` (
	`day` text PRIMARY KEY NOT NULL,
	`reserved_slots` integer DEFAULT 0 NOT NULL,
	`consumed_slots` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "domain_automatic_budgets_day_check" CHECK(length("domain_automatic_budgets"."day") = 10),
	CONSTRAINT "domain_automatic_budgets_reserved_check" CHECK("domain_automatic_budgets"."reserved_slots" between 0 and 1000000),
	CONSTRAINT "domain_automatic_budgets_consumed_check" CHECK("domain_automatic_budgets"."consumed_slots" between 0 and 1000000),
	CONSTRAINT "domain_automatic_budgets_updated_check" CHECK("domain_automatic_budgets"."updated_at" between 0 and 8640000000000000)
);
--> statement-breakpoint
CREATE TABLE `domain_automatic_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`enabled_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT "domain_automatic_consents_id_length_check" CHECK(length("domain_automatic_consents"."id") between 1 and 128),
	CONSTRAINT "domain_automatic_consents_revision_check" CHECK(length("domain_automatic_consents"."revision") = 86 and substr("domain_automatic_consents"."revision", 1, 22) = 'domain-auto-v1:sha256:' and substr("domain_automatic_consents"."revision", 23) not glob '*[^0-9a-f]*'),
	CONSTRAINT "domain_automatic_consents_timestamp_check" CHECK("domain_automatic_consents"."enabled_at" between 0 and 8640000000000000 and ("domain_automatic_consents"."revoked_at" is null or "domain_automatic_consents"."revoked_at" between "domain_automatic_consents"."enabled_at" and 8640000000000000))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_automatic_consents_active_unique_idx` ON `domain_automatic_consents` (1) WHERE "domain_automatic_consents"."revoked_at" is null;--> statement-breakpoint
CREATE TABLE `domain_rule_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`action` text NOT NULL,
	`phase` text DEFAULT 'prepared' NOT NULL,
	`rollback_target_commit` text,
	`candidate_fqdn` text,
	`expected_parent_commit` text NOT NULL,
	`intended_content_sha256` text NOT NULL,
	`proposed_rule` text,
	`ownership_delta` text NOT NULL,
	`automatic_consent_id` text,
	`automatic_consent_revision` text,
	`automatic_budget_day` text,
	`automatic_budget_slots` integer DEFAULT 0 NOT NULL,
	`commit_sha` text,
	`committed_content_sha256` text,
	`activation_status` text DEFAULT 'not-started' NOT NULL,
	`activation_attempt_count` integer DEFAULT 0 NOT NULL,
	`last_activation_attempt_at` integer,
	`activation_error_category` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`automatic_consent_id`) REFERENCES `domain_automatic_consents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "domain_rule_operations_id_length_check" CHECK(length("domain_rule_operations"."id") between 1 and 128),
	CONSTRAINT "domain_rule_operations_idempotency_length_check" CHECK(length("domain_rule_operations"."idempotency_key") between 1 and 128),
	CONSTRAINT "domain_rule_operations_action_check" CHECK("domain_rule_operations"."action" in ('automatic-add', 'manual-add', 'manual-edit', 'manual-delete', 'rollback')),
	CONSTRAINT "domain_rule_operations_phase_check" CHECK("domain_rule_operations"."phase" in ('prepared', 'committed', 'activating', 'completed', 'partial', 'aborted', 'reconciliation-required')),
	CONSTRAINT "domain_rule_operations_rollback_target_check" CHECK(("domain_rule_operations"."action" = 'rollback' and "domain_rule_operations"."rollback_target_commit" is not null and length("domain_rule_operations"."rollback_target_commit") = 40) or ("domain_rule_operations"."action" != 'rollback' and "domain_rule_operations"."rollback_target_commit" is null)),
	CONSTRAINT "domain_rule_operations_candidate_length_check" CHECK("domain_rule_operations"."candidate_fqdn" is null or length("domain_rule_operations"."candidate_fqdn") between 3 and 253),
	CONSTRAINT "domain_rule_operations_parent_length_check" CHECK(length("domain_rule_operations"."expected_parent_commit") = 40),
	CONSTRAINT "domain_rule_operations_intended_digest_length_check" CHECK(length("domain_rule_operations"."intended_content_sha256") = 64),
	CONSTRAINT "domain_rule_operations_rule_length_check" CHECK("domain_rule_operations"."proposed_rule" is null or length("domain_rule_operations"."proposed_rule") between 3 and 255),
	CONSTRAINT "domain_rule_operations_ownership_delta_length_check" CHECK(length("domain_rule_operations"."ownership_delta") between 27 and 65536),
	CONSTRAINT "domain_rule_operations_budget_check" CHECK(("domain_rule_operations"."action" = 'automatic-add' and "domain_rule_operations"."automatic_budget_day" is not null and length("domain_rule_operations"."automatic_budget_day") = 10 and "domain_rule_operations"."automatic_budget_slots" = 1) or ("domain_rule_operations"."action" != 'automatic-add' and "domain_rule_operations"."automatic_budget_day" is null and "domain_rule_operations"."automatic_budget_slots" = 0)),
	CONSTRAINT "domain_rule_operations_consent_check" CHECK(("domain_rule_operations"."action" = 'automatic-add' and "domain_rule_operations"."automatic_consent_id" is not null and length("domain_rule_operations"."automatic_consent_id") between 1 and 128 and "domain_rule_operations"."automatic_consent_revision" is not null and length("domain_rule_operations"."automatic_consent_revision") = 86) or ("domain_rule_operations"."action" != 'automatic-add' and "domain_rule_operations"."automatic_consent_id" is null and "domain_rule_operations"."automatic_consent_revision" is null)),
	CONSTRAINT "domain_rule_operations_commit_pair_check" CHECK(("domain_rule_operations"."commit_sha" is null and "domain_rule_operations"."committed_content_sha256" is null) or ("domain_rule_operations"."commit_sha" is not null and "domain_rule_operations"."committed_content_sha256" is not null and length("domain_rule_operations"."commit_sha") = 40 and length("domain_rule_operations"."committed_content_sha256") = 64)),
	CONSTRAINT "domain_rule_operations_phase_commit_check" CHECK(("domain_rule_operations"."phase" in ('prepared', 'aborted') and "domain_rule_operations"."commit_sha" is null) or ("domain_rule_operations"."phase" in ('committed', 'activating', 'completed', 'partial') and "domain_rule_operations"."commit_sha" is not null) or "domain_rule_operations"."phase" = 'reconciliation-required'),
	CONSTRAINT "domain_rule_operations_activation_shape_check" CHECK(("domain_rule_operations"."activation_status" = 'not-started' and "domain_rule_operations"."activation_attempt_count" = 0 and "domain_rule_operations"."last_activation_attempt_at" is null and "domain_rule_operations"."activation_error_category" is null) or ("domain_rule_operations"."activation_status" = 'in-progress' and "domain_rule_operations"."activation_attempt_count" between 1 and 1000000 and "domain_rule_operations"."last_activation_attempt_at" is not null and "domain_rule_operations"."activation_error_category" is null) or ("domain_rule_operations"."activation_status" = 'succeeded' and "domain_rule_operations"."activation_attempt_count" between 1 and 1000000 and "domain_rule_operations"."last_activation_attempt_at" is not null and "domain_rule_operations"."activation_error_category" is null) or ("domain_rule_operations"."activation_status" = 'failed' and "domain_rule_operations"."activation_attempt_count" between 1 and 1000000 and "domain_rule_operations"."last_activation_attempt_at" is not null and "domain_rule_operations"."activation_error_category" is not null and "domain_rule_operations"."activation_error_category" in ('shutdown', 'materialization-failure', 'config-reload-failure', 'provider-proof-failure', 'coverage-proof-failure', 'route-proof-failure', 'infrastructure-failure'))),
	CONSTRAINT "domain_rule_operations_phase_activation_check" CHECK(("domain_rule_operations"."phase" in ('prepared', 'committed', 'aborted') and "domain_rule_operations"."activation_status" = 'not-started') or ("domain_rule_operations"."phase" = 'activating' and "domain_rule_operations"."activation_status" = 'in-progress') or ("domain_rule_operations"."phase" = 'completed' and "domain_rule_operations"."activation_status" = 'succeeded') or ("domain_rule_operations"."phase" = 'partial' and "domain_rule_operations"."activation_status" = 'failed') or ("domain_rule_operations"."phase" = 'reconciliation-required' and "domain_rule_operations"."activation_status" in ('not-started', 'failed'))),
	CONSTRAINT "domain_rule_operations_timestamp_check" CHECK("domain_rule_operations"."created_at" between 0 and 8640000000000000 and "domain_rule_operations"."updated_at" between "domain_rule_operations"."created_at" and 8640000000000000 and ("domain_rule_operations"."last_activation_attempt_at" is null or "domain_rule_operations"."last_activation_attempt_at" between "domain_rule_operations"."created_at" and "domain_rule_operations"."updated_at") and ("domain_rule_operations"."completed_at" is null or "domain_rule_operations"."completed_at" between "domain_rule_operations"."created_at" and "domain_rule_operations"."updated_at")),
	CONSTRAINT "domain_rule_operations_completion_check" CHECK(("domain_rule_operations"."phase" in ('completed', 'aborted', 'reconciliation-required') and "domain_rule_operations"."completed_at" is not null) or ("domain_rule_operations"."phase" not in ('completed', 'aborted', 'reconciliation-required') and "domain_rule_operations"."completed_at" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_rule_operations_idempotency_key_unique` ON `domain_rule_operations` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `domain_rule_operations_recovery_idx` ON `domain_rule_operations` (`phase`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `domain_rule_operations_commit_unique_idx` ON `domain_rule_operations` (`commit_sha`) WHERE "domain_rule_operations"."commit_sha" is not null;--> statement-breakpoint
CREATE TABLE `domain_rule_ownership` (
	`rule` text PRIMARY KEY NOT NULL,
	`ownership` text NOT NULL,
	`operation_id` text NOT NULL,
	`commit_sha` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `domain_rule_operations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "domain_rule_ownership_rule_length_check" CHECK(length("domain_rule_ownership"."rule") between 3 and 255),
	CONSTRAINT "domain_rule_ownership_kind_check" CHECK("domain_rule_ownership"."ownership" in ('automatic', 'manual')),
	CONSTRAINT "domain_rule_ownership_commit_length_check" CHECK(length("domain_rule_ownership"."commit_sha") = 40),
	CONSTRAINT "domain_rule_ownership_timestamp_check" CHECK("domain_rule_ownership"."created_at" between 0 and 8640000000000000 and "domain_rule_ownership"."updated_at" between "domain_rule_ownership"."created_at" and 8640000000000000)
);
--> statement-breakpoint
CREATE INDEX `domain_rule_ownership_operation_idx` ON `domain_rule_ownership` (`operation_id`);