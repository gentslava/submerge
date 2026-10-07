CREATE TABLE `domain_candidates` (
	`fqdn` text PRIMARY KEY NOT NULL,
	`registrable_site` text,
	`selected_scope` text,
	`proposed_rule` text,
	`exclusion_reason` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`next_validation_at` integer NOT NULL,
	`last_validation_at` integer,
	`failure_streak` integer DEFAULT 0 NOT NULL,
	`lease_id` text,
	`lease_until` integer,
	`lease_generation` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "domain_candidates_status_check" CHECK("domain_candidates"."status" in ('queued', 'pending', 'confirmed', 'blocked', 'excluded')),
	CONSTRAINT "domain_candidates_fqdn_length_check" CHECK(length("domain_candidates"."fqdn") between 3 and 253),
	CONSTRAINT "domain_candidates_site_length_check" CHECK("domain_candidates"."registrable_site" is null or length("domain_candidates"."registrable_site") between 3 and 253),
	CONSTRAINT "domain_candidates_rule_length_check" CHECK("domain_candidates"."proposed_rule" is null or length("domain_candidates"."proposed_rule") between 3 and 255),
	CONSTRAINT "domain_candidates_first_seen_check" CHECK("domain_candidates"."first_seen_at" between 0 and 8640000000000000),
	CONSTRAINT "domain_candidates_last_seen_check" CHECK("domain_candidates"."last_seen_at" between "domain_candidates"."first_seen_at" and 8640000000000000),
	CONSTRAINT "domain_candidates_next_validation_check" CHECK("domain_candidates"."next_validation_at" between 0 and 8640000000000000),
	CONSTRAINT "domain_candidates_last_validation_check" CHECK("domain_candidates"."last_validation_at" is null or "domain_candidates"."last_validation_at" between 0 and 8640000000000000),
	CONSTRAINT "domain_candidates_failure_streak_check" CHECK("domain_candidates"."failure_streak" between 0 and 1000000),
	CONSTRAINT "domain_candidates_scope_check" CHECK("domain_candidates"."selected_scope" is null or "domain_candidates"."selected_scope" in ('exact', 'site')),
	CONSTRAINT "domain_candidates_eligibility_check" CHECK(("domain_candidates"."status" = 'excluded' and "domain_candidates"."exclusion_reason" in ('excluded-tld', 'never-add-domain', 'never-add-suffix', 'telemetry-pattern', 'invalid-policy') and "domain_candidates"."selected_scope" is null and "domain_candidates"."proposed_rule" is null and "domain_candidates"."lease_id" is null and "domain_candidates"."lease_until" is null) or ("domain_candidates"."status" != 'excluded' and "domain_candidates"."exclusion_reason" is null and "domain_candidates"."selected_scope" is not null and "domain_candidates"."proposed_rule" is not null)),
	CONSTRAINT "domain_candidates_lease_pair_check" CHECK(("domain_candidates"."lease_id" is null and "domain_candidates"."lease_until" is null) or ("domain_candidates"."lease_id" is not null and length("domain_candidates"."lease_id") between 1 and 128 and "domain_candidates"."lease_until" between 0 and 8640000000000000 and "domain_candidates"."lease_generation" between 1 and 1000000000)),
	CONSTRAINT "domain_candidates_lease_generation_check" CHECK("domain_candidates"."lease_generation" between 0 and 1000000000),
	CONSTRAINT "domain_candidates_updated_check" CHECK("domain_candidates"."updated_at" between 0 and 8640000000000000)
);
--> statement-breakpoint
CREATE INDEX `domain_candidates_due_idx` ON `domain_candidates` (`next_validation_at`,`lease_until`);--> statement-breakpoint
CREATE INDEX `domain_candidates_retention_idx` ON `domain_candidates` (`updated_at`);--> statement-breakpoint
CREATE TABLE `domain_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`fqdn` text NOT NULL,
	`evaluated_at` integer NOT NULL,
	`status` text NOT NULL,
	`confidence` text NOT NULL,
	`reasons` text NOT NULL,
	`window_start` integer,
	`evidence` text NOT NULL,
	`selected_scope` text,
	`proposed_rule` text,
	FOREIGN KEY (`fqdn`) REFERENCES `domain_candidates`(`fqdn`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "domain_decisions_status_check" CHECK("domain_decisions"."status" in ('confirmed', 'pending', 'blocked')),
	CONSTRAINT "domain_decisions_id_length_check" CHECK(length("domain_decisions"."id") between 1 and 128),
	CONSTRAINT "domain_decisions_fqdn_length_check" CHECK(length("domain_decisions"."fqdn") between 3 and 253),
	CONSTRAINT "domain_decisions_evaluated_check" CHECK("domain_decisions"."evaluated_at" between 0 and 8640000000000000),
	CONSTRAINT "domain_decisions_confidence_check" CHECK(("domain_decisions"."status" = 'confirmed' and "domain_decisions"."confidence" = 'high') or ("domain_decisions"."status" = 'pending' and "domain_decisions"."confidence" = 'low') or ("domain_decisions"."status" = 'blocked' and "domain_decisions"."confidence" = 'none')),
	CONSTRAINT "domain_decisions_window_check" CHECK("domain_decisions"."window_start" is null or "domain_decisions"."window_start" between 0 and "domain_decisions"."evaluated_at"),
	CONSTRAINT "domain_decisions_scope_pair_check" CHECK(("domain_decisions"."selected_scope" is null and "domain_decisions"."proposed_rule" is null) or ("domain_decisions"."selected_scope" is not null and "domain_decisions"."proposed_rule" is not null)),
	CONSTRAINT "domain_decisions_scope_check" CHECK("domain_decisions"."selected_scope" is null or "domain_decisions"."selected_scope" in ('exact', 'site')),
	CONSTRAINT "domain_decisions_rule_length_check" CHECK("domain_decisions"."proposed_rule" is null or length("domain_decisions"."proposed_rule") between 3 and 255),
	CONSTRAINT "domain_decisions_reasons_length_check" CHECK(length("domain_decisions"."reasons") between 2 and 1024),
	CONSTRAINT "domain_decisions_evidence_length_check" CHECK(length("domain_decisions"."evidence") between 2 and 2048)
);
--> statement-breakpoint
CREATE INDEX `domain_decisions_fqdn_evaluated_idx` ON `domain_decisions` (`fqdn`,`evaluated_at`);--> statement-breakpoint
CREATE INDEX `domain_decisions_retention_idx` ON `domain_decisions` (`evaluated_at`);--> statement-breakpoint
CREATE TABLE `domain_validation_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`direction` text NOT NULL,
	`attempted_at` integer NOT NULL,
	`category` text NOT NULL,
	`transport_success` integer NOT NULL,
	`http_status` integer,
	`resolved_address` text,
	`available_address_count` integer NOT NULL,
	`connect_duration_ms` integer,
	`tls_duration_ms` integer,
	`total_duration_ms` integer NOT NULL,
	`redirect_count` integer NOT NULL,
	`final_origin` text,
	FOREIGN KEY (`run_id`) REFERENCES `domain_validation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "domain_validation_attempts_id_length_check" CHECK(length("domain_validation_attempts"."id") between 1 and 128),
	CONSTRAINT "domain_validation_attempts_run_id_length_check" CHECK(length("domain_validation_attempts"."run_id") between 1 and 128),
	CONSTRAINT "domain_validation_attempts_direction_check" CHECK("domain_validation_attempts"."direction" in ('direct', 'proxy')),
	CONSTRAINT "domain_validation_attempts_category_check" CHECK("domain_validation_attempts"."category" in ('http_response', 'dns_failure', 'unsafe_address', 'ipv6_unavailable', 'unsafe_redirect', 'redirect_limit', 'connect_timeout', 'tls_timeout', 'tls_handshake_reset', 'connection_reset_before_http', 'tls_error', 'network_error', 'total_timeout', 'proxy_auth_failure', 'route_proof_failure', 'infrastructure_error')),
	CONSTRAINT "domain_validation_attempts_timestamp_check" CHECK("domain_validation_attempts"."attempted_at" between 0 and 8640000000000000),
	CONSTRAINT "domain_validation_attempts_transport_success_check" CHECK("domain_validation_attempts"."transport_success" in (0, 1)),
	CONSTRAINT "domain_validation_attempts_http_status_check" CHECK("domain_validation_attempts"."http_status" is null or ("domain_validation_attempts"."http_status" >= 100 and "domain_validation_attempts"."http_status" <= 599)),
	CONSTRAINT "domain_validation_attempts_address_count_check" CHECK("domain_validation_attempts"."available_address_count" between 0 and 1024 and ("domain_validation_attempts"."resolved_address" is not null or "domain_validation_attempts"."available_address_count" = 0)),
	CONSTRAINT "domain_validation_attempts_address_length_check" CHECK("domain_validation_attempts"."resolved_address" is null or length("domain_validation_attempts"."resolved_address") between 2 and 45),
	CONSTRAINT "domain_validation_attempts_connect_duration_check" CHECK("domain_validation_attempts"."connect_duration_ms" is null or "domain_validation_attempts"."connect_duration_ms" between 0 and 60000),
	CONSTRAINT "domain_validation_attempts_tls_duration_check" CHECK("domain_validation_attempts"."tls_duration_ms" is null or "domain_validation_attempts"."tls_duration_ms" between 0 and 60000),
	CONSTRAINT "domain_validation_attempts_total_duration_check" CHECK("domain_validation_attempts"."total_duration_ms" between 0 and 60000),
	CONSTRAINT "domain_validation_attempts_redirect_count_check" CHECK("domain_validation_attempts"."redirect_count" between 0 and 5),
	CONSTRAINT "domain_validation_attempts_final_origin_length_check" CHECK("domain_validation_attempts"."final_origin" is null or length("domain_validation_attempts"."final_origin") between 9 and 2048),
	CONSTRAINT "domain_validation_attempts_result_shape_check" CHECK(("domain_validation_attempts"."category" = 'http_response' and "domain_validation_attempts"."transport_success" = 1 and "domain_validation_attempts"."http_status" is not null) or ("domain_validation_attempts"."category" != 'http_response' and "domain_validation_attempts"."transport_success" = 0))
);
--> statement-breakpoint
CREATE INDEX `domain_validation_attempts_run_idx` ON `domain_validation_attempts` (`run_id`);--> statement-breakpoint
CREATE INDEX `domain_validation_attempts_retention_idx` ON `domain_validation_attempts` (`attempted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `domain_validation_attempts_run_id_direction_unique` ON `domain_validation_attempts` (`run_id`,`direction`);--> statement-breakpoint
CREATE TABLE `domain_validation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`lease_id` text NOT NULL,
	`lease_generation` integer NOT NULL,
	`fqdn` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`error_category` text,
	FOREIGN KEY (`fqdn`) REFERENCES `domain_candidates`(`fqdn`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "domain_validation_runs_status_check" CHECK("domain_validation_runs"."status" in ('running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "domain_validation_runs_id_length_check" CHECK(length("domain_validation_runs"."id") between 1 and 128),
	CONSTRAINT "domain_validation_runs_lease_id_length_check" CHECK(length("domain_validation_runs"."lease_id") between 1 and 128),
	CONSTRAINT "domain_validation_runs_lease_generation_check" CHECK("domain_validation_runs"."lease_generation" between 1 and 1000000000),
	CONSTRAINT "domain_validation_runs_fqdn_length_check" CHECK(length("domain_validation_runs"."fqdn") between 3 and 253),
	CONSTRAINT "domain_validation_runs_started_check" CHECK("domain_validation_runs"."started_at" between 0 and 8640000000000000),
	CONSTRAINT "domain_validation_runs_finished_check" CHECK(("domain_validation_runs"."status" = 'running' and "domain_validation_runs"."finished_at" is null) or ("domain_validation_runs"."status" != 'running' and "domain_validation_runs"."finished_at" is not null and "domain_validation_runs"."finished_at" between "domain_validation_runs"."started_at" and 8640000000000000)),
	CONSTRAINT "domain_validation_runs_error_check" CHECK(("domain_validation_runs"."status" in ('running', 'completed') and "domain_validation_runs"."error_category" is null) or ("domain_validation_runs"."status" in ('failed', 'cancelled') and "domain_validation_runs"."error_category" in ('shutdown', 'lease-lost', 'coverage-failure', 'direct-probe-failure', 'proxy-probe-failure', 'decision-failure', 'policy-changed', 'infrastructure-failure')))
);
--> statement-breakpoint
CREATE INDEX `domain_validation_runs_fqdn_started_idx` ON `domain_validation_runs` (`fqdn`,`started_at`);--> statement-breakpoint
CREATE INDEX `domain_validation_runs_retention_idx` ON `domain_validation_runs` (`finished_at`,`started_at`);