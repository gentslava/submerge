# Subscription auto-refresh — implementation plan

## Overview

Make the existing `profile-update-interval` metadata operational. Submerge owns the
schedule because mihomo receives flattened proxy snapshots rather than subscription
provider URLs. This phase deliberately excludes multi-target health, Pen changes,
conditional HTTP, and the broader config-apply state machine.

## Architecture decisions

- Persist attempt, success, next-attempt, failure-count, and sanitized error state on the
  source row so restart does not reset the schedule or failure backoff.
- Use the provider interval with a one-hour floor; use 24 hours when the provider does not
  supply one.
- Run one refresh at a time. Manual refresh joins the same per-source in-flight operation
  and ignores the saved backoff.
- Schedule only enabled remote `sub` and `happ` sources. Enabling a saved source first
  refreshes it immediately while it is still excluded from routing; activation proceeds
  only after that refresh succeeds. Inline/single-node sources are never scheduled.
- Keep the existing validated ingest and byte-identical config guard as the execution
  path; this phase does not add a second fetch/apply implementation.

## Task 1: Persist and calculate the schedule

**Acceptance criteria:**

- [ ] A migration adds nullable attempt/success/next-attempt/error fields and a failure
      counter without damaging existing source rows.
- [ ] Provider intervals below one hour are clamped; missing intervals use 24 hours.
- [ ] Failed attempts use persisted 5 min × 3^n backoff capped at 6 hours.

**Verification:**

- [ ] Focused scheduling and migration tests fail first, then pass.
- [ ] Existing source-service tests remain green.

## Task 2: Share manual and scheduled refresh execution

**Acceptance criteria:**

- [ ] Manual and scheduled triggers use one coordinator and concurrent requests for the
      same source share one operation.
- [ ] Enabling a disabled refreshable source performs an immediate refresh before it is
      added back to routing; a failed refresh leaves it disabled.
- [ ] Success persists the next provider-based attempt and clears failure state.
- [ ] Fetch, decode, and validation failures preserve the active source snapshot, store
      only a sanitized category, and schedule backoff. Atomic DB/config apply failures
      remain part of the explicitly deferred config-apply state machine.

**Verification:**

- [ ] Coordinator tests cover success, failure, and single-flight behavior.
- [ ] No stored/logged error contains a subscription URL or credential.

## Task 3: Run and stop the worker with the server

**Acceptance criteria:**

- [ ] Boot initializes missing schedules from the last successful snapshot time and
      processes overdue sources in `(nextAttemptAt, id)` order.
- [ ] Disabled sources are excluded even when they already have a persisted due/backoff
      timestamp.
- [ ] A 60-second pulse runs without overlap and processes sources sequentially.
- [ ] Graceful shutdown stops the scheduler.

**Verification:**

- [ ] Fake-clock scheduler tests cover boot initialization, due ordering, and stop/start.
- [ ] `pnpm verify:static` is green.
- [ ] Incremental and final code-review findings are resolved.

## Deferred follow-up

- Conditional `ETag` / `Last-Modified` requests and unchanged-result UI.
- Explicit desired/applied config hashes and reload retry state.
- Configurable multi-target channel health, failover, and Pen mockups.
