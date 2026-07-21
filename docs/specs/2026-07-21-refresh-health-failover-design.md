# Subscription refresh, multi-target health, and failover — design

- **Date:** 2026-07-21
- **Status:** Auto-refresh phase implemented; multi-target health and failover deferred
- **Related:** [v2 stack](2026-06-29-submerge-v2-stack-design.md), [channel routing](2026-07-01-channel-routing-design.md), [background prober](2026-07-03-background-prober-design.md), [optimal policy](2026-07-07-optimal-policy-design.md)
- **Incident:** intermittent `ERR_CONNECTION_CLOSED` for Habr while the Default channel used the OpenGate Belgium node

## 1. Objective

Make subscription refresh and the controller-owned `optimal` policy reliable and
explainable without replacing the existing architecture.

The finished behavior must:

1. Refresh subscription sources automatically using the provider interval, with a safe
   fallback interval, persistent scheduling state, backoff, and the same code path for
   manual and automatic refresh.
2. Never replace a working source snapshot with a timed-out, HTTP-error, or invalid
   response.
3. Write the generated mihomo config atomically, explicitly track whether the running
   engine applied it, and retry a pending reload.
4. Keep `optimal` as a Submerge-owned policy over a mihomo `select` group, but evaluate
   the active node against multiple independent end-to-end targets.
5. Fail over only after a confirmed destination failure and a simultaneous proof that an
   alternative node can reach the same target. A single miss or a target outage shared by
   every node must not cause flapping.
6. Expose source refresh state, config apply state, per-target health, and switch reasons
   without exposing credentials or token-bearing URLs.

This is for the single-admin self-hosted product and its existing scale: dozens of
sources and up to hundreds of nodes.

Implementation order is intentionally split. Subscription auto-refresh (§4.2–§4.6,
limited to scheduling state and the shared manual/scheduled execution path) ships first.
Multi-target health, failover, its Pen mockups, conditional HTTP, and richer config-apply
observability remain deferred follow-up work.

## 2. Proven incident cause

The July 21 incident was not a stale Belgium proxy definition and was not caused by the
outer home mihomo, Chrome, QUIC, DNS, or a Submerge refresh.

The observed failure boundary was:

```text
client → outer mihomo → Submerge SOCKS → inner mihomo → Belgium exit
                                                  ✓ TCP connected
                                                  ✓ TLS ClientHello sent
                                                  ✗ zero response bytes, then TCP FIN
```

During a same-second named-proxy comparison that did not change `AUTO`:

| Target | Belgium | Sweden |
|---|---:|---:|
| `habr.com` | success | success |
| `assets.habr.com` | closed after ~1.30 s | success |
| `effect.habr.com` | closed after ~1.29 s | success |
| `sentry.srv.habr.com` | closed after ~1.29 s | success |

The result repeated 26 seconds later. Approximately 35 seconds after the first sample,
all targets recovered through Belgium with no source refresh, config reload, selector
change, or container restart. The same failure had also been reproduced with curl and by
connecting directly to the inner mihomo SOCKS port, which excludes browser fingerprinting
and the outer TUN path.

The proven root cause is therefore destination-specific reachability failure after the
Belgium egress. The most likely concrete mechanism is temporary source-IP/path filtering
of the shared VPN egress by Habr's protected infrastructure (the main service is behind
Qrator), not country-level allow/deny behavior. Only Habr/Qrator or OpenGate egress logs
could distinguish the final remote ACL from a provider-side Habr-specific route filter;
Submerge cannot observe beyond the remote FIN.

The manual OpenGate refresh appeared to heal the incident because the remote filtering
window expired at the same time. WAL reconstruction showed that the Belgium proxy's safe
transport fields and credential hash did not change. Later failures recovered with no
refresh or reload at all.

## 3. Current architecture and gaps

### 3.1 Current source path

```text
SourcesScreen refresh button
  → tRPC sources.refresh
  → sources/service.refreshSource
  → sources/ingest.ingestSource
  → fetch/decode + parse + validate proxies
  → UPDATE sources.proxies/meta in SQLite
  → nodes/service.applyConfig
  → collect enabled source snapshots
  → buildMultiConfig
  → write config.yaml.tmp + rename config.yaml
  → PUT mihomo /configs (reload)
```

There are no generated provider files and no subscription worker today. SQLite
`sources.proxies` is the stored snapshot; one generated `config.yaml` is the engine input.
The parsed `profile-update-interval` is stored as `meta.updateHours` and displayed as
“auto N h”, but no scheduler consumes it.

Manual refresh currently updates SQLite before config generation. A fetch/parse failure
leaves the old row untouched, but config write and reload outcomes are represented by one
ambiguous `applied` boolean. A reload failure can leave DB + file ahead of the running
engine, with no persistent pending state or retry unless mihomo later reconnects.

### 3.2 Current `optimal` path

```text
PolicyEditor
  → channels.setPolicy
  → channels.policy JSON in SQLite
  → config generation writes AUTO/ch-* as type: select
  → liveHub pulse (5 s)
  → ControllerRegistry.runOnce
  → ChannelController.tickOptimal
  → read per-node delay for policy.testUrl
  → EWMA latency/success decision
  → PUT mihomo /proxies/{group} to select a node
```

`AUTO: select` is intentional for `optimal`: Submerge owns the EWMA and failover decision.
Changing it to native `url-test` would discard those semantics and duplicate the existing
`speed` policy.

The background prober keeps every node measured on the Default policy's single `testUrl`.
In production that URL was `https://www.gstatic.com/generate_204`, which continued to pass
through Belgium while Habr failed. `tickOptimal` therefore received a successful sample
and had no evidence on which to switch.

`ch-ch2` is an independent routed channel with its own group and `https://t.me` probe. Its
failure history does not control the Default channel's `AUTO` group. Mihomo's aggregate
leaf `alive` flag can reflect the latest probe by another URL, so it must not override the
policy-specific per-URL history.

## 4. Design decisions

### 4.1 Keep `AUTO` as `select`

Choose option B: retain controller-owned selection.

- `speed` remains mihomo-owned `url-test`.
- `optimal`, `sticky`, and `manual` remain controller-owned `select` groups.
- This change improves `optimal`; it does not silently change the semantics of the other
  policies.
- The existing EWMA ranking, relative switch margin, slow-node escape, and decision log
  remain in place. Multi-target health becomes an additional failover gate.

### 4.2 One refresh pipeline for manual and automatic triggers

Introduce a `SourceRefreshCoordinator`. Both the tRPC mutation and scheduler call:

```ts
refresh(sourceId, { trigger: "manual" | "scheduled" }): Promise<RefreshResult>
```

The coordinator provides:

- single-flight per source: a manual click joins an in-progress scheduled refresh rather
  than launching a duplicate fetch;
- one serialized config apply section across all sources and other config mutations;
- fetch/parse outside the apply lock;
- atomic DB/config commit behavior described in §4.5;
- structured, sanitized outcomes shared by API, UI, scheduler, and logs.

Refreshable kinds are `sub` and `happ`. Single-node and inline config kinds remain manual
data and are not scheduled.

### 4.3 Persistent refresh schedule

Add a `SourceRefreshScheduler` started after migrations and source backfills.

- Pulse: every 60 seconds.
- Fetch concurrency: 1 initially. This is intentionally conservative for provider limits
  and a single-admin deployment; config application is serialized regardless.
- Effective interval: `max(meta.updateHours, 1 hour)` when supplied, otherwise 24 hours.
- `nextAttemptAt` is stored, so jobs survive an application restart.
- On boot, overdue sources are processed in `(nextAttemptAt, id)` order instead of all at
  once.
- Successful changed, unchanged, and HTTP 304 results schedule the next normal interval.
- Failures use persisted exponential backoff:

```text
delay = min(6 hours, 5 minutes × 3^(consecutiveFailures - 1))
```

- A manual refresh ignores backoff, but still updates the persisted result and next due
  time.
- Disabled sources are still refreshed. `enabled` controls routing, not whether a saved
  subscription stays current.

### 4.4 Conditional HTTP and safe validation

For HTTP subscriptions, persist private `ETag` and `Last-Modified` values and send
`If-None-Match` / `If-Modified-Since` on later refreshes.

Outcomes:

| Response | Behavior |
|---|---|
| `200`, valid non-empty proxy set | calculate hash; commit changed or unchanged result |
| `304` | keep active proxies/meta; record successful not-modified attempt; no reload |
| timeout/network error | keep old snapshot; record error and backoff |
| `4xx` / `5xx` | keep old snapshot; record status/error and backoff |
| invalid/empty body | keep old snapshot; record validation error and backoff |

Metadata headers from a valid `200` may update even when the proxy hash is unchanged.
Missing metadata does not erase previously known values on `304`.

`happ` continues to use the official decoder. Conditional headers are used only for an
HTTP sub-URL fetch where the decoder flow exposes them; an inline decoder body is a normal
full refresh.

### 4.5 Versioning and config application

Compute two SHA-256 hashes:

- `activeProxyHash`: canonical JSON of the normalized proxy array, including all fields
  that affect mihomo. Secrets participate in the digest but only the digest is stored or
  shown.
- `desiredConfigHash`: exact generated `config.yaml` bytes.

Canonicalization sorts object keys recursively but preserves proxy array order. A provider
reorder is therefore an intentional config change.

Split the current `applyConfig` responsibilities internally into generation/write and
reload, while keeping one public coordinator:

1. Fetch and fully validate a candidate in memory.
2. Enter the serialized apply section.
3. For a changed source, open a SQLite transaction, update the source snapshot, generate
   config from that transaction, write `config.yaml.tmp`, atomically rename it, update
   desired state, and commit. A generation/write error rolls back the source row; the old
   config remains active.
4. After commit, reload mihomo.
5. On success, persist `appliedConfigHash`, reload time, and source apply status.
6. On reload failure, keep DB + atomic file as the desired state, persist `pending`, and
   retry with backoff from the background pulse and on mihomo reconnect.

No filesystem + SQLite + remote process operation can be one physical transaction. The
contract is explicit convergence:

- crash before SQLite commit: boot regenerates from the old committed DB;
- crash after commit but before reload: `desiredConfigHash != appliedConfigHash`, so boot
  and the retry loop apply the desired version;
- the UI never labels `pending` as applied.

Unchanged proxy content updates attempt/metadata state but skips config write and reload.
Engine recovery remains a separate explicit force-apply path (`onReconnect` and
diagnostics), not a side effect mislabeled as a source change.

After a successful reload, reconcile every controller-owned group. If mihomo reports a
selected name that is no longer a group member, select the first currently reachable
candidate immediately, then let the controller refine the choice on its next tick. Record
`selected node removed by source refresh` as the reason.

### 4.6 Source and config state

Extend `sources` with persisted refresh fields:

```ts
interface SourceRefreshState {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextAttemptAt: number | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  activeProxyHash: string | null;
  activeVersionAt: number | null;
  lastContentChanged: boolean | null;
  applyStatus: "never" | "unchanged" | "applied" | "pending" | "failed";
  lastReloadAt: number | null;
}
```

Private storage fields `etag` and `lastModified` are not part of the shared API schema.
`lastError` is a bounded sanitized category/message and never contains a subscription URL,
response body, UUID, key, or token.

Add a singleton `config_apply_state` table:

```text
desired_hash, applied_hash,
last_write_at, last_reload_at,
next_retry_at, consecutive_failures, last_error
```

On migration, existing source hashes are backfilled from stored proxy snapshots without
network access. Existing `updatedAt` remains for compatibility; `activeVersionAt` becomes
the unambiguous active snapshot age.

### 4.7 Multi-target health for `optimal`

Extend `optimalPolicy` without invalidating legacy policy JSON:

```ts
{
  kind: "optimal";
  testUrl: string;                 // existing ranking/chart URL
  intervalSec: number;
  healthUrls: string[];            // 1..4 additional URLs
  failureThreshold: number;        // default 2, allowed 2..5
}
```

Legacy rows default to two additional independent targets already used by diagnostics:

```text
https://www.cloudflare.com/cdn-cgi/trace
https://telegram.org/favicon.ico
```

Together with the existing gstatic `testUrl`, this gives three independent targets. The
list is editable per channel; an administrator may add critical destinations such as Habr
without making Habr a global hard-coded dependency. URLs are normalized, de-duplicated,
restricted to HTTP(S), and capped at five total effective targets.

The mihomo named-proxy delay endpoint performs DNS resolution and an end-to-end
TCP/TLS/HTTP request through the specified node. Any completed HTTP response counts as
network reachability; an application-level `404` is not a transport failure. Timeout is 5
seconds.

Probe cost is bounded:

- The existing rolling prober continues to rank all nodes only on `testUrl`.
- Each `optimal` interval probes all effective targets only through the active node.
- Alternative nodes are multi-target probed only after the active node has a confirmed
  target failure.
- Incident validation checks at most the three best currently reachable alternatives,
  with a shared concurrency cap.

Per active node and target, track:

```ts
interface TargetHealth {
  urlHost: string;
  status: "unknown" | "healthy" | "failed";
  latencyMs: number | null;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}
```

The API exposes only `urlHost`, not path/query/credentials.

State rules:

- `unknown`: no complete round yet.
- `healthy`: no target has reached `failureThreshold`.
- `degraded`: at least one target is confirmed failed, but a majority still succeeds.
- `down`: a majority of targets is confirmed failed.
- A target recovers after two consecutive successes.
- One failure never changes the channel state and never switches.

### 4.8 Health-driven failover

The existing latency/EWMA decisions still run when health is `healthy`.

When active health becomes `degraded` or `down`:

1. Sort alternatives by the existing effective-latency score.
2. Probe up to the best three against the complete effective target set in the same
   incident window.
3. An alternative is eligible only if it passes the complete effective target set in
   that incident window. A switch must not trade one destination-specific failure for
   another.
4. Select the eligible alternative with the lowest effective latency.
5. Record the failed hosts, counters, from/to nodes, and candidate result.

If every checked alternative fails the same target, record `shared target outage among
evaluated candidates` and keep the current selector. This prevents a Habr-, Telegram-,
Google-, or Cloudflare-wide outage from rotating through the fleet.

After a health failover, suppress proactive and slow-node switch-back for
`max(60 seconds, 2 × intervalSec)`. A confirmed failure of the new active node may still
fail over during the cooldown. Normal EWMA selection resumes after cooldown and two
successful health rounds.

The old one-sample `optimal` liveness escape is replaced by this thresholded path. New
connections use the newly selected outbound. Existing TCP/UDP connections are not forcibly
closed in this minimal fix.

### 4.9 Observability and UI

#### Sources

`sources.list` returns `refreshState`; `sources.refresh` returns:

```ts
{
  outcome: "changed" | "unchanged" | "not-modified";
  source: Source;
  applyStatus: SourceRefreshState["applyStatus"];
}
```

Each source row shows, using the existing Indigo Console row anatomy:

- last successful refresh and next scheduled attempt;
- `updated`, `unchanged`, `pending apply`, or `error` status;
- last HTTP status/error category;
- active version age and a 12-character hash prefix;
- last reload time when that source changed the generated config.

The manual refresh toast distinguishes “content updated”, “no changes”, and “saved, engine
apply pending”; it must not always claim “source updated”.

#### Channels

Add `channels.health` returning runtime snapshots from the registry. The expanded channel
card shows:

- selected and previous node;
- selection time and reason;
- `healthy` / `degraded` / `down` / `unknown`;
- per-target host, latest latency/result, last success, and last failure;
- the metrics captured in the latest switch decision.

`recentDecisions` keeps the existing ring and adds structured optional health evidence.
The latest from/to/reason/timestamp is persisted with the channel so a server restart does
not erase the last explanation. Runtime probe counters restart as `unknown` and rebuild on
the next rounds; stale pre-restart counters must not trigger a switch.

Before UI implementation, add the source status states and expanded Optimal health block
to `pencil/web-ui.pen`. The 1440×1024 dark frame and all required responsive widths remain
visual gates.

#### Logs

Structured server logs include:

- refresh trigger, source id/kind, duration, HTTP status, changed flag, hash prefix, and
  apply status;
- config write/reload success, pending state, retry, and recovery;
- channel health transition, failed hosts, candidate validation, and switch reason.

Only changed refreshes, failures/pending apply, health transitions, and switches enter the
browser-visible operational log. Routine unchanged scheduled attempts remain structured
debug/info output to avoid UI noise.

Never log source values, complete URLs, response bodies, proxy objects, UUIDs, passwords,
keys, SNI paths containing tokens, or mihomo secrets.

## 5. Tech stack and project structure

No new runtime dependency is required.

- Node 24, strict TypeScript, Zod 4, tRPC 11, Drizzle + SQLite, Vitest.
- Existing `fetch`, `AbortSignal.timeout`, `node:crypto`, and the mihomo client are enough.
- React 19 + TanStack Query and the existing component/token system for UI.

Expected touch points:

```text
packages/shared/src/
  schemas.ts, defaults.ts       shared refresh/health contracts and constants

packages/server/src/db/
  schema.ts + migration         source refresh and config apply state
packages/server/src/modules/sources/
  ingest.ts                     conditional HTTP result
  refresh.ts                    coordinator and scheduler
  service.ts, router.ts         shared manual/scheduled path and API
packages/server/src/modules/nodes/
  service.ts                    serialized atomic config apply and pending retry
packages/server/src/modules/channels/
  controller.ts, registry.ts    multi-target state and failover
  service.ts, router.ts         policy defaults and health API
packages/server/src/live/
  singleton.ts                  scheduler/pulse integration
packages/server/src/modules/logs/
  events.ts                     curated operational events

packages/web/src/features/sources/
  SourceRow.tsx, SourcesScreen.tsx
packages/web/src/features/channels/
  PolicyEditor.tsx, ChannelCard.tsx
pencil/web-ui.pen               approved states before UI code
```

## 6. Code style

Keep thin routers, validated external responses, explicit result unions, and no service
container/DI layer. For example:

```ts
export type RefreshResult =
  | { outcome: "changed"; source: Source; applyStatus: "applied" | "pending" }
  | { outcome: "unchanged" | "not-modified"; source: Source; applyStatus: "unchanged" };

export async function refreshSource(
  db: Db,
  id: number,
  trigger: "manual" | "scheduled",
): Promise<RefreshResult> {
  const candidate = await fetchAndValidateCandidate(db, id);
  return refreshCoordinator.commit(db, id, candidate, trigger);
}
```

Use camelCase in TypeScript, kebab-case filenames, snake_case DB columns, Zod at API and
mihomo/provider boundaries, Biome formatting, and English comments/documents. UI copy
remains Russian.

## 7. Testing strategy

All behavior changes are test-first.

### 7.1 Source refresh and scheduler

Unit/integration tests with fake time and mocked fetch/reload:

1. Changed scheduled `200`: proxies/meta/hash/version committed, config atomically
   replaced, reload succeeds, next due time stored.
2. Same normalized content: metadata/attempt state updated, `unchanged`, no config write or
   reload, no false “updated” toast.
3. `304`: old snapshot preserved, validators retained, successful attempt recorded, no
   reload.
4. Timeout, `500`, and invalid/empty body: old snapshot/hash/config preserved, error and
   backoff persisted.
5. Config write failure: source transaction rolls back and old file remains.
6. Reload failure: DB/file desired state persists as `pending`; retry later updates applied
   hash/time without refetching the source.
7. Manual and scheduled triggers execute the same coordinator; duplicate concurrent
   refreshes are single-flight.
8. Restart: overdue work resumes from `nextAttemptAt`; pending config apply retries.
9. Selected proxy removed: selector is reconciled to a valid member and reason recorded.
10. Hash/log snapshots prove no credential material is exposed.

### 7.2 Health and selection

Controller tests with deterministic probe matrices:

1. All targets pass: existing EWMA behavior is unchanged.
2. One miss followed by success: no state transition and no switch.
3. One target fails twice on active, alternative passes it in the same round: active becomes
   degraded and switches to the eligible alternative.
4. Majority fails twice: active becomes down and switches.
5. Active and all alternatives fail the same target: shared target outage, no selector
   churn.
6. A lower-latency alternative that fails the affected target is ineligible.
7. Recovery requires two successes; cooldown prevents immediate switch-back.
8. Removed/added nodes reset only their own health state.
9. Registry isolates health state per channel and returns sanitized target hosts.
10. New connection after selection uses the new outbound chain; existing connections are
    not forcibly closed.

### 7.3 UI/browser evidence

- Source populated/unchanged/pending/error and loading states.
- Optimal health healthy/degraded/down/unknown and expanded/collapsed states.
- URL add/remove/validation and maximum-target behavior.
- Decision reason and previous/selected node.
- Mockup comparison at 1440×1024 dark.
- Responsive checks at 320/390/425/768/1024/1440 and every changed container boundary.
- Popup/outside-press/Escape/focus-return coverage if a details popup is introduced.
- Zero browser retries.

## 8. Commands

```bash
pnpm -F @submerge/server db:generate
pnpm -F @submerge/server test -- src/modules/sources
pnpm -F @submerge/server test -- src/modules/channels
pnpm -F @submerge/web test -- src/features/sources src/features/channels
pnpm verify:static
```

Focused browser commands will be recorded in the implementation plan after the Pencil
frame and exact test file are chosen.

## 9. Boundaries

### Always

- Preserve the last validated source snapshot on every fetch/parse/write failure.
- Serialize config generation/write/reload operations.
- Parse every mihomo/provider response at the client boundary.
- Persist scheduler/apply state before reporting success.
- Sanitize URLs and errors before API/log/UI exposure.
- Run repository static verification plus focused browser evidence and both review gates.

### Ask first

- Change the proposed target defaults or thresholds after this spec is approved.
- Add a dependency, introduce a separate worker/process, or change the deploy topology.
- Force-close users' live TCP/UDP connections during failover.
- Commit, push, or deploy; pushing `master` is a production deploy.

### Never

- Replace a working source with an empty/invalid response.
- Treat config file persistence as proof that mihomo applied it.
- Treat one successful URL as proof of universal reachability.
- Switch through every node when the target itself is down for all candidates.
- Log or display subscription URLs, proxy credentials, private keys, or full config hashes
  derived from secret-bearing content unless explicitly required.

## 10. Success criteria

The change is complete only when all of the following are demonstrated:

1. Production-visible source state answers when the last automatic attempt/success/error
   occurred, what HTTP outcome occurred, whether content changed, and whether mihomo
   applied the desired config.
2. An automatic changed refresh atomically activates the new source and reloads mihomo;
   unchanged/304 results do not destructively reload it.
3. A failed refresh cannot damage the old active source; a failed reload is visibly pending
   and retries without another source fetch.
4. The scheduler resumes correctly after restart.
5. `optimal` remains a controller-managed selector and preserves existing healthy-path
   EWMA decisions.
6. With two consecutive Habr failures through Belgium and same-window success through
   Sweden, `optimal` selects Sweden and logs the exact failed hosts and evidence.
7. With the same target failing through every checked node, no failover loop occurs.
8. A single failed sample causes no switch.
9. UI/API/logs contain no secret-bearing source values or proxy fields.
10. Static, unit, integration, browser, incremental-review, and final-review gates are
    green; after an explicitly authorized deploy, production confirms the behavior.

## 11. Production verification

After review, commit, explicit push authorization, image rollout, and health confirmation:

1. Confirm each refreshable source has `nextAttemptAt` and a safe active hash prefix.
2. Manually refresh OpenGate once and confirm the result distinguishes changed vs.
   unchanged and reports the engine apply state.
3. Add `https://habr.com/` and `https://assets.habr.com/` to the Default channel's health
   targets for this deployment.
4. Confirm healthy same-window probes through the selected node without creating a probe
   storm.
5. On a natural recurrence, verify two failures on Belgium, a successful same-window
   alternative probe, selector change, and new Habr connections using the new node.
6. Confirm a subsequent recovery does not switch back during cooldown.
7. Inspect structured logs and UI for timestamps/reasons and verify no secrets appear.

Do not manufacture traffic volume intended to trigger remote anti-DDoS filtering.

## 12. Remaining risks

- Multi-target probes can only detect configured destinations. Arbitrary sites can still
  fail without appearing in the health set.
- The mihomo delay endpoint proves end-to-end DNS/TCP/TLS/HTTP reachability but reports a
  generic failure; it cannot attribute the final remote ACL to Habr/Qrator vs. the VPN
  provider.
- Shared VPN egress reputation may change faster than the configured interval. Lower
  intervals improve detection at the cost of more probe traffic.
- Existing established connections may continue on their old outbound until they close.
- A crash between the filesystem rename and SQLite commit is not physically atomic, but
  the boot reconciliation contract restores the committed DB version.
- Provider metadata can suggest an excessively long interval. This design honors it (with
  a one-hour minimum); a user-configurable maximum/override is deliberately deferred.

## 13. Approval choices

Implementation proceeds only after approval of these concrete defaults:

- keep `AUTO` as `select` under the Submerge controller;
- fallback refresh interval 24 hours, minimum provider interval 1 hour;
- scheduler concurrency 1 and persisted 5m/15m/45m/… backoff capped at 6 hours;
- gstatic ranking target plus Cloudflare and Telegram health targets by default;
- failure threshold 2, recovery threshold 2, 5-second probe timeout;
- validate at most the best three alternatives and use a cooldown of
  `max(60 seconds, 2 × interval)`;
- do not forcibly terminate established connections.
