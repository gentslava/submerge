# Domain intelligence — implementation plan

## Overview

Implement the approved report/review, CLI, and guarded apply scope from
[`2026-08-03-domain-intelligence-design.md`](../specs/2026-08-03-domain-intelligence-design.md)
as a disabled-by-default Submerge server module. Mihomo is the only observation boundary.
The work is split into small risk-first and vertical slices so every commit remains
testable and rollback-friendly.

The publisher ships fail-closed and report mode remains the default. No slice adds live
credentials, publishes a port, changes the Mihomo log level, enables apply in a deployment,
or mutates the production rules repository during verification.

## Architecture decisions

- Reuse the existing validated Mihomo log stream and `/connections` client; never open a
  second resolver-product integration.
- Keep raw observations server-internal. Shared contracts expose only protected admin
  read models and validated actions.
- Normalize and fingerprint synchronously, but keep persistence failures and all network
  work outside the traffic/log pump.
- Use Drizzle migrations as the only SQLite schema path and retain 14 days of operational
  evidence.
- Add the dedicated forced-outbound listener only after the report-only observation and
  coverage slices are green. It remains private to the active runtime topology.
- Treat the unresolved first-install scope as unconfigured; no implementation slice
  silently chooses `exact` or `site`.

## Phase 1 — observation foundation

### Task 1: Parse and normalize Mihomo observations

**Files:**

- Create `packages/server/src/modules/domain-intelligence/observer.ts`
- Create `packages/server/src/modules/domain-intelligence/observer.test.ts`

**Acceptance criteria:**

- [x] Supported structured fields and versioned routing-message forms produce a
      normalized FQDN, transport, timestamp, source, and source-independent fingerprint.
- [x] IP literals, internal/single-label names, local/reverse zones, invalid IDNA, and
      unrelated/schema-drifted log lines produce no observation.
- [x] Snapshot observations use the connection start time when valid and repeated
      snapshots produce the same fingerprint without exposing the connection ID.

**Verification:**

- [x] Focused tests are observed failing before implementation and then pass.
- [x] Every `pnpm verify:static` stage and the incremental review gate are green under
      the pinned Node 24 binaries; the pnpm shim itself stalled before script execution
      on its registry-signature lookup.

### Task 2: Persist observations and daily aggregates

**Files:**

- Modify `packages/server/src/db/schema.ts`
- Generate `packages/server/drizzle/0009_*.sql` and migration metadata
- Modify `packages/server/src/db/client.test.ts`
- Create `packages/server/src/modules/domain-intelligence/service.ts`
- Create `packages/server/src/modules/domain-intelligence/service.test.ts`

**Acceptance criteria:**

- [x] The migration adds observation and daily-stat storage without changing existing
      rows; candidate, validation, decision, and audit tables stay with the slices that
      first write them.
- [x] A duplicate fingerprint reconciles `lastSeen` without incrementing count; a new
      fingerprint atomically increments the UTC daily aggregate.
- [x] Only the normalized fields approved by the spec are persisted.

**Verification:**

- [x] Migration upgrade, deduplication, aggregation, rollback, and privacy tests pass.
- [x] Existing database tests, the repository static gate stages, `drizzle-kit check`,
      and the incremental review remain green.

### Task 3: Derive site scope and independent filter outcomes

**Files:**

- Modify `packages/server/package.json` and `pnpm-lock.yaml` for the maintained PSL parser
- Create `packages/server/src/modules/domain-intelligence/model.ts`
- Create `packages/server/src/modules/domain-intelligence/model.test.ts`

**Acceptance criteria:**

- [x] Registrable-site derivation uses the PSL private section and never crosses a public
      or private suffix.
- [x] Never-add and do-not-widen decisions are independent; protected shared/CDN hosts
      remain eligible as exact-only candidates.
- [x] Rule serialization distinguishes exact hostnames from `+.` site rules.

**Verification:**

- [x] Normalization, IDNA, excluded-TLD, shared-hosting, and scope tests pass; the
      repository static gate and independent incremental review are green under the
      pinned Node 24 runtime.

### Task 4: Attach the observer without coupling it to UI logs

**Files:**

- Modify `packages/server/src/modules/logs/hub.ts` and `hub.test.ts`
- Modify `packages/server/src/modules/logs/singleton.ts`
- Create `packages/server/src/modules/domain-intelligence/instance.ts`
- Modify `packages/server/src/index.ts`

**Acceptance criteria:**

- [x] The existing Mihomo stream fans a frame into the observer without a second stream.
- [x] Observation failures are contained and never stop or delay log capture.
- [x] The observer is inactive by default and shuts down cleanly.

**Verification:**

- [x] Log-pump error-containment, bounded-queue, failure-streak, and disabled-default
      integration tests pass; the repository gate and independent review are green.

### Task 5: Reconcile active connection snapshots and report health

**Files:**

- Modify `packages/server/src/clients/mihomo.ts` and `mihomo.test.ts`
- Create `packages/server/src/modules/domain-intelligence/scheduler.ts`
- Create `packages/server/src/modules/domain-intelligence/scheduler.test.ts`
- Modify `packages/server/src/modules/domain-intelligence/instance.ts`

**Acceptance criteria:**

- [x] A bounded pulse reconciles validated `/connections` snapshots without overlap.
- [x] Log/snapshot ambiguity undercounts instead of manufacturing a threshold crossing.
- [x] Parser drift with healthy domain-bearing snapshots marks observer health degraded.

**Verification:**

- [x] Fake-clock tests cover single-flight, restart, shutdown, delayed correlation,
      snapshot recovery, and degraded health; the repository gate and independent review
      are green.

### Checkpoint: observation foundation

- [x] Focused and repository-wide tests, typecheck, lint, and builds are green.
- [x] The feature remains disabled and produces no network probes or config mutations.
- [x] Incremental review findings for Tasks 1–5 are resolved.

## Phase 2 — coverage and A/B evidence

### Task 6: Evaluate active rule coverage

**Files:**

- Create `packages/server/src/modules/domain-intelligence/coverage.ts`
- Create `packages/server/src/modules/domain-intelligence/coverage.test.ts`
- Modify `packages/server/src/modules/nodes/multiConfig.ts` only if a typed provider view
      cannot be obtained without changing generated bytes

**Acceptance criteria:**

- [x] Exact, suffix, classical, custom, notblocked, and active third-party provider
      coverage is evaluated using the active Submerge routing model.
- [x] Unknown or unparseable provider formats return incomplete coverage and block a
      recommendation.

### Task 7: Resolve and validate public DIRECT addresses

**Files:**

- Create `packages/server/src/modules/domain-intelligence/resolver.ts`
- Create `packages/server/src/modules/domain-intelligence/resolver.test.ts`

**Acceptance criteria:**

- [x] External resolver responses are parsed and quorum failures are deterministic.
- [x] Private, loopback, link-local, reserved, multicast, documentation, and otherwise
      non-global addresses are rejected before connect.

### Task 8: Probe DIRECT with per-hop SSRF protection

**Files:**

- Create `packages/server/src/modules/domain-intelligence/probe.ts`
- Create `packages/server/src/modules/domain-intelligence/probe.test.ts`

**Acceptance criteria:**

- [x] HTTPS connects to a pinned validated address while preserving SNI and Host.
- [x] Every redirect is independently normalized, resolved, validated, and pinned.
- [x] Stored results contain only safe transport categories, timing, status, and origin.

### Task 9: Generate the private forced-outbound validation listener

**Files:**

- Modify `packages/server/src/modules/nodes/multiConfig.ts` and `multiConfig.test.ts`
- Modify `packages/server/src/modules/nodes/service.ts` and `service.test.ts`
- Modify `packages/server/src/config/env.ts` and `env.test.ts`

**Acceptance criteria:**

- [x] The authenticated listener targets the selected generated channel group directly.
- [x] Compose uses an un-published private-network endpoint; host development accepts
      only a validated loopback endpoint.
- [x] Credentials never enter generated URLs, API responses, reports, or logs.

### Task 10: Probe PROXY and prove the forced route

**Files:**

- Modify `packages/server/src/modules/domain-intelligence/probe.ts` and `probe.test.ts`
- Modify `packages/server/src/clients/mihomo.ts` and `mihomo.test.ts`

**Acceptance criteria:**

- [x] PROXY probes authenticate to the dedicated listener and use the same safe redirect
      policy as DIRECT.
- [x] Tests verify listener/inbound identity and the configured target group without
      changing a live selector.

### Task 11: Make deterministic candidate decisions

**Files:**

- Create `packages/server/src/modules/domain-intelligence/decision.ts`
- Create `packages/server/src/modules/domain-intelligence/decision.test.ts`

**Acceptance criteria:**

- [x] Three spaced qualifying DIRECT failures plus two stable PROXY HTTP successes are
      required in the trailing 24-hour window.
- [x] Application statuses including 401/403/404/429 count as transport success.
- [x] Coverage uncertainty, unhealthy observation, unstable PROXY, or invalid scope
      blocks confirmation with a persisted reason code.

### Task 12: Schedule bounded validation and retention

**Files:**

- Modify `packages/server/src/modules/domain-intelligence/scheduler.ts` and
  `scheduler.test.ts`
- Modify `packages/server/src/modules/domain-intelligence/service.ts` and `service.test.ts`
- Modify `packages/server/src/db/schema.ts` and generate the candidate/validation/decision
  migration used by this slice

**Acceptance criteria:**

- [x] One A/B pair runs per due domain with cooldown, concurrency, backoff, and circuit
      breaker controls.
- [x] Fourteen-day operational retention preserves future apply audit rows.
- [x] Shutdown aborts bounded work and overdue restart work is capped.

### Checkpoint: evidence pipeline

- [x] No probe runs until the admin explicitly enables report/review collection.
- [x] Integration tests use only reserved `example.com` fixtures and mocked boundaries.
- [x] The generated normal traffic route remains byte-identical while the feature is off.

## Phase 3 — protected report and review UI

### Task 13: Add shared report contracts and protected tRPC procedures

**Files:**

- Create `packages/shared/src/domain-intelligence.ts` and its test
- Modify `packages/shared/src/index.ts`
- Create `packages/server/src/modules/domain-intelligence/router.ts` and its test
- Modify `packages/server/src/trpc/router.ts`

**Acceptance criteria:**

- [x] Protected procedures expose health, aggregates, exclusions, candidates, selected
      scopes, evidence summaries, and safe reason codes without raw observations.
- [x] Review actions support scope selection, rejection, and recheck only; they cannot
      mutate Git, providers, active config, or channels.

### Task 14: Add settings and the report/review screen

**Files:**

- Modify the shared domain-intelligence settings contracts and server procedures
- Modify the domain runtime boot/settings reconciliation and generic settings boundary
- Modify `packages/web/src/features/settings/SettingsScreen.tsx` and its tests
- Create `packages/web/src/features/domain-intelligence/DomainIntelligenceScreen.tsx`
- Create its component/browser tests
- Add the corresponding route/navigation entry

**Acceptance criteria:**

- [x] The dedicated protected settings API is report-only, rejects raw/apply-shaped
      writes, keeps first-install scope unconfigured, and starts collection only after a
      successful Mihomo config apply.
- [x] Enabled runtime composition promotes only threshold-qualified observations and runs
      the bounded DIRECT/forced-PROXY validation path with fail-closed active coverage.
- [x] Config transitions require explicit Mihomo activation proof, wait for A/B transport
      cleanup, classify mixed resolver failures as infrastructure, and expire candidates by
      their last observation rather than validation churn.
- [x] Secret rotation switches the API client before runtime resume, and decision evidence
      cannot attribute an out-of-scope redirect failure to the observed candidate rule.
- [x] Forced-route proof participates in cleanup ownership, and a missed hard drain terminally
      latches the scheduler so no later pulse can accumulate zombie transports.
- [x] The terminal network latch preserves an executor-free maintenance pulse so crash recovery
      and the 14-day privacy retention continue without permitting another probe.
- [ ] The approved Pencil controls and states are functional, token-based, and honest.
- [ ] Never-add and do-not-widen editors remain separate and scope restrictions are
      visible before expansion.
- [ ] The unresolved first-install scope remains an explicit unconfigured state.

### Task 15: Add report CLI and protected artifacts

**Files:**

- Create `packages/server/src/modules/domain-intelligence/report.ts` and its test
- Create `packages/server/src/domain-intelligence-cli.ts`
- Modify `packages/server/package.json`

**Acceptance criteria:**

- [ ] Collect, validate, and report commands share the same service boundaries.
- [ ] Every dry-run leaves all domain/settings/apply SQLite rows and Git, provider, config,
      and channel state unchanged; an explicit report artifact/stdout is the sole output.
- [ ] JSON and Markdown output is atomic, sanitized, and available only at the explicit
      protected destination.

### Task 16: Add guarded Git publication and provider activation

**Files:**

- Create `packages/server/src/modules/domain-intelligence/publisher.ts` and its tests
- Extend the shared settings/actions, protected router, service, and SQLite schema
- Extend the CLI with the real `--apply` action and its fully non-mutating dry-run path
- Extend the domain runtime for automatic batches without coupling it to observation
- Modify the Mihomo client only through its validated provider-refresh boundary

**Acceptance criteria:**

- [ ] The managed block update is deterministic and idempotent, preserves every unrelated
      byte, rejects invalid/duplicate rules, and passes `git diff --check`.
- [ ] A narrow Git adapter accepts only the deployment checkout whose remote is exactly
      `gentslava/mihomo-rules`, branch `main`, and file `custom.txt`; it fast-forwards,
      commits, and pushes without shell interpolation or force.
- [ ] Candidate apply in both review and automatic modes re-reads `confirmed` plus `active`
      under the global apply lock, rechecks health/coverage/scope/topology, and atomically
      enforces the UTC daily budget for automatic additions only.
- [ ] Publication waits for validated raw-source convergence, refreshes only the stable
      custom provider, proves resulting route coverage, and records partial/success audit.
- [ ] Manual add/edit/delete and automatic add use the same pipeline; manual edits transfer
      ownership to `Manual`, while automation cannot rewrite manual rules.
- [ ] Report/default configuration has no mutation capability. Apply and automatic mode
      remain unavailable without explicit deployment readiness and consent revision.
- [ ] The automatic consent fingerprint is code-owned, covers every safety preference,
      invalidates to review on change, and is required again by the locked preflight.
- [ ] `--apply --dry-run` leaves candidate, validation, decision, audit, budget, ownership,
      Git, provider, config, and channel state unchanged.

### Task 17: Complete the apply-aware admin UI

**Files:**

- Extend the approved screen with custom-rule add/edit/delete and publication state
- Add automatic-mode consent, daily budget, ownership, failure, retry, and rollback views
- Keep the Settings screen and separate filter editors synchronized with the same contracts

**Acceptance criteria:**

- [ ] Report, review, and automatic modes are functional and capability-honest; unavailable
      apply remains visible with its exact remediation reason.
- [ ] Candidate confirmation, manual rules, scope changes, delete warnings, publication
      progress, partial activation retry, and ownership changes call protected actions.
- [ ] Never-add and do-not-widen remain separate; first-install scope is an explicit choice.

### Task 18: Complete responsive evidence and runbook

**Files:**

- Add focused Playwright coverage and screenshots
- Update `docs/architecture.md`, the spec status, and plan/spec indexes
- Add the report/review install, disable, uninstall, and rollback runbook

**Acceptance criteria:**

- [ ] Populated, empty, degraded, error, collapsed, long-FQDN, and scope states match the
      approved Pencil frames at the required desktop and responsive widths.
- [ ] The runbook covers install, report-only use, apply prerequisites, enablement,
      dry-run, retry, uninstall, normal Git revert rollback, and provider re-verification.
- [ ] Verification uses mocks/reserved domains only and never enables or executes
      production apply.

### Final checkpoint

- [ ] `pnpm verify:static` is green with zero browser retries.
- [ ] Incremental reviews are green for every slice.
- [ ] The independent final review is green across the complete feature.
- [ ] No push or production enablement occurs without an explicit later request.

## Deferred follow-up

- Automatic cleanup/removal policy for rules that later become unnecessary.
- Adoption of pre-existing rules outside the Submerge-managed block.
- Any production credential, mount, provider, or mode change.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Mihomo log format drifts | Narrow tested patterns, snapshot reconciliation, degraded health |
| Duplicate log/snapshot evidence | Source-independent fingerprint and conservative coalescing |
| Internal-network probing | Per-hop public-address validation and pinned connects |
| Wrong VPN comparison path | Dedicated authenticated forced listener with route-identity tests |
| UI exposes browsing data | Protected aggregate read model; no raw observation endpoint |
| Feature affects normal traffic | Disabled default, async containment, byte-identity config tests |
