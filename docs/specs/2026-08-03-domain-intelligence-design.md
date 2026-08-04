# Mihomo-native domain intelligence and guarded custom rules — design

- **Date:** 2026-08-03
- **Status:** Approved for report/review, CLI, and guarded apply implementation;
  production enablement remains a separate operation
- **Related:** [ADR-0005](../adr/0005-mihomo-native-domain-intelligence.md),
  [routing Phase 4](2026-07-07-routing-phase4-design.md),
  [background prober](2026-07-03-background-prober-design.md)

## 0. Assumptions to approve

1. Submerge learns only from destination FQDNs its managed Mihomo actually attempts to
   route. Anything before that boundary is outside the product.
2. Mihomo info events are the primary observation source; `/connections` snapshots are
   reconciliation/fallback.
3. IP-only destinations are ignored because an exact domain rule cannot be inferred
   safely.
4. Observation enqueue is event-driven but A/B validation is always asynchronous and
   temporally spaced.
5. Version 1 is a Submerge TypeScript module using the existing SQLite and lifecycle; no
   separate Python/systemd worker is introduced.
6. Report mode remains the default. Guarded apply is implemented in the same feature but
   cannot run until its deployment credentials, managed provider, and rollback path are
   separately configured and verified.
7. Rule scope is an explicit candidate decision: exact observed address or the whole
   registrable site when that expansion cannot capture unrelated tenants.
8. The approved Indigo Console Pencil frames define how candidates, scope, reports, and
   automation settings are presented.

## 1. Objective

Add an optional Submerge feature that builds a daily map of destination FQDNs observed at
the Mihomo routing boundary, finds domains whose transport repeatedly fails through
DIRECT but succeeds through a configured VPN channel, and proposes scoped additions to
`custom.txt`.

Success means:

1. No upstream DNS implementation, API, credential, or configuration appears in the
   module.
2. A connection-routing event is never delayed by normalization, persistence, probing,
   reporting, Git, or provider activation.
3. Observations contain only normalized FQDN, timestamp, count, transport, and internal
   deduplication data.
4. A recommendation requires at least three spaced DIRECT transport failures in 24 hours
   and a stable PROXY result in the same window.
5. Existing rule coverage, excluded telemetry/infrastructure names, ambiguous results,
   and unstable PROXY results block recommendation. Protected shared/CDN boundaries lock
   otherwise eligible candidates to exact scope.
6. Every proposal exposes one of two scopes: exact FQDN (`api.service.example`) or whole
   site (`+.service.example`). Shared-hosting/CDN boundaries can lock a candidate to exact.
7. Report mode cannot mutate Git, Mihomo providers, configuration, or active list files.
8. Apply is deterministic, capped, idempotent, and auditable. Review mode requires an
   explicit rule action; automatic mode requires an explicit audited enablement and a
   persisted UTC daily budget.
9. Any feature failure is fail-open for user traffic.

## 2. Product boundary

```text
client/application/network
          |
          | connection with hostname/SNI/HTTP CONNECT/fake-IP mapping when available
          v
Submerge-managed Mihomo
          |
          +-- routing event ---> DomainObservation enqueue
          |
          +-- DIRECT or selected VPN channel ---> destination
```

Submerge does not attempt to reconstruct how the hostname was resolved or which local
resolver produced an address. It records only the hostname Mihomo itself had available
when making the route decision.

A hostname may reach Mihomo through SOCKS domain mode, HTTP CONNECT, TUN sniffing, or a
known fake-IP mapping. Those are Mihomo concerns. The domain-intelligence module receives
one normalized observation or nothing.

## 3. Architecture

### 3.1 Components

```text
Mihomo log stream --------------------+
                                      v
/connections reconciliation -> observation adapter -> SQLite queue/stats
                                                        |
                                                        v
                                           background validation scheduler
                                             | DIRECT     | PROXY
                                             +-------------+
                                                        |
                                                        v
                                                decision + reports
                                                        |
                                             optional guarded publisher
                                                        |
                                      Git custom.txt -> provider refresh
```

Responsibilities:

- `observer.ts`: strict connection-event parsing, snapshot reconciliation, normalization,
  dedupe, and non-blocking enqueue.
- `service.ts`: settings, queue, daily aggregates, candidate state, decisions, and audit.
- `scheduler.ts`: due-work selection, single-flight execution, backoff, and shutdown.
- `resolver.ts`: real public IP resolution used only for DIRECT validation.
- `probe.ts`: bounded DIRECT/PROXY HTTPS transport probes.
- `coverage.ts`: active custom/notblocked/third-party rule coverage.
- `decision.ts`: pure thresholds and reason codes.
- `report.ts`: protected JSON/Markdown artifacts or API read model.
- `publisher.ts`: optional deterministic Git transaction and provider activation.
- `router.ts`: authenticated administrative status/actions; no raw observation feed.

### 3.2 No synchronous probing

The observation call performs at most:

1. strict FQDN normalization;
2. an in-memory dedupe check;
3. a small SQLite insert/upsert;
4. a wake-up signal for the scheduler.

It does not await the scheduler. Queue/database errors are caught and reported once per
failure streak; they do not propagate into the Mihomo log pump or traffic handling.

### 3.3 Observation sources

Primary source: the already-open Mihomo info stream. The parser accepts only versioned,
tested connection-routing patterns. It extracts the destination hostname and transport,
but does not persist the complete log message or source address.

Fallback/reconciliation: periodic validated `/connections` snapshots. Each connection's
`metadata.host`, network, start time, and opaque connection ID form an observation. The ID
is used for dedupe but is not exposed in reports.

If the log parser stops recognizing events while snapshots still show domain-bearing
connections, observer health becomes `degraded`. Reports show the gap and apply is
blocked. The implementation does not change Mihomo's configured log level.

## 4. Technology, commands, and structure

### 4.1 Stack

- Existing Node 24 / strict TypeScript server.
- Existing `better-sqlite3` + Drizzle database and migrations.
- Existing Mihomo client with Zod-parsed responses.
- Node TLS/HTTP primitives or the existing `undici` dependency for probes.
- System Git invoked through a narrow typed adapter only when apply is enabled.
- No Python, second database, systemd worker, broker, queue service, or new web server.

### 4.2 Commands

```bash
pnpm -F @submerge/server test -- domain-intelligence
pnpm typecheck
pnpm verify:static
```

Administrative actions are exposed through protected tRPC procedures and corresponding
internal CLI entry points for safe diagnostics:

```bash
pnpm -F @submerge/server domain-intelligence --collect-snapshot --dry-run
pnpm -F @submerge/server domain-intelligence --validate --dry-run
pnpm -F @submerge/server domain-intelligence --report --dry-run
pnpm -F @submerge/server domain-intelligence --report --dry-run --output-dir /protected/report-dir
pnpm -F @submerge/server domain-intelligence --apply
```

`--collect` is an alias for `--collect-snapshot`. Collect and validate are diagnostics and
therefore require `--dry-run`; report is the default action and remains read-only with or
without the flag. A full report is never printed to stdout. Without `--output-dir`, stdout
contains only a domain-free JSON summary. The output directory must already exist, must not
be a symlink, and must be owner-only (`0700`); JSON and Markdown artifacts are replaced
atomically with owner-only permissions (`0600`). Settings, counts, filter policy, and every
candidate page are read inside one SQLite read transaction so a concurrent collector cannot
mix revisions in one report. Because the CLI is a separate process, it
marks live in-memory observer health as unavailable instead of inventing a disabled or healthy
state. CLI validation passes that unavailable state into the decision engine fail-closed, so a
separate-process dry-run cannot produce a confirmed decision. The protected tRPC overview remains
the source for live observer health.

`--dry-run` makes no durable application or system-state mutation. It may read Mihomo,
SQLite, Git, and the raw source and may perform explicitly requested bounded probes, but it
does not write observations, candidates, leases, validation evidence, decisions, settings,
apply audit, budgets, ownership, Git, providers, config, or channels. An explicitly requested
report file or stdout payload is its only allowed output side effect.

### 4.3 Planned files

```text
packages/shared/src/domain-intelligence.ts
packages/server/src/modules/domain-intelligence/
  model.ts
  observer.ts
  service.ts
  scheduler.ts
  resolver.ts
  probe.ts
  coverage.ts
  decision.ts
  report.ts
  publisher.ts
  router.ts
  *.test.ts
packages/server/src/db/schema.ts
packages/server/src/clients/mihomo.ts
packages/server/src/config/env.ts
packages/server/src/index.ts
packages/server/drizzle/<migration>.sql
docs/adr/0005-mihomo-native-domain-intelligence.md
docs/specs/2026-08-03-domain-intelligence-design.md
docs/plans/2026-08-03-domain-intelligence.md
```

Deployment/runbook changes, if needed for an optional Git key or repository mount, live
in `vps`. No resolver-specific deployment file belongs in Submerge.

## 5. Code style and boundaries

Pure decision logic receives already normalized facts:

```ts
export interface CandidateEvidence {
  fqdn: string;
  direct: readonly ValidationAttempt[];
  proxy: readonly ValidationAttempt[];
  coverage: CoverageResult;
}

export function decideCandidate(evidence: CandidateEvidence, policy: DecisionPolicy): Decision {
  // Pure, deterministic reason-code evaluation; no I/O.
}
```

### Always

- Parse every Mihomo, DNS resolver, network, Git, and GitHub response at its boundary.
- Use UTC timestamps and persisted reason enums.
- Use bounded queues, timeouts, concurrency, retries, and circuit breakers.
- Keep observer and scheduler errors out of the log-stream/traffic control flow.
- Recheck coverage immediately before recommendation and apply.
- Write configuration/report/Git files atomically.

### Ask first

- Enable the feature or apply mode in production.
- Add Git credentials or a repository mount to the Submerge deployment.
- Add the stable managed `custom` provider/routing rule to production.
- Change container networking or publish a new port.
- Commit or push any repository.

### Never

- Depend on or configure an upstream DNS product.
- Change DNS configuration, VPN egress, VLESS, node-selection policy, or Mihomo log level.
- Persist raw client IP, complete log messages, URLs, queries, response bodies, cookies,
  or credentials.
- Infer a domain from an IP-only event.
- Automatically expand a candidate beyond its registrable site or through a protected
  public/private, shared-hosting, CDN, or multi-tenant suffix.
- Hide the selected rule scope or infer that site scope is safe from the Public Suffix
  List alone.
- Manually edit a materialized/active provider file.
- Treat HTTP `401`, `403`, `404`, or `429` as a routing failure.

## 6. Configuration

Admin preferences are stored through the existing Submerge settings path and exposed to
the admin only. Deployment capability is derived server-side and is never writable through
the API. Defaults are disabled/report-only:

```ts
interface DomainIntelligencePreferences {
  enabled: boolean;
  retentionDays: 14;
  minimumConnectionCount: number;
  directAttemptsRequired: number;
  minimumAttemptSpacingMinutes: number;
  validationWindowHours: 24;
  minimumProxySuccesses: number;
  maximumProxyTransportFailures: 0;
  maximumCandidatesPerRun: number;
  maximumAutomaticRulesPerDay: number;
  maxConcurrency: number;
  requestTimeoutMs: number;
  defaultRuleScope: "exact" | "site" | null;
  automationMode: "off" | "review" | "automatic";
  externalResolvers: string[];
  excludedTlds: string[];
  neverAddDomains: string[];
  neverAddSuffixes: string[];
  nonWidenableSuffixes: string[];
  telemetryPatterns: string[];
  customTargetChannelId: string;
}

type DomainIntelligenceDeploymentCapability =
  | { mode: "report"; apply: { available: false; reason: ApplyUnavailableReason } }
  | {
      mode: "apply";
      apply: {
        available: true;
        repository: "gentslava/mihomo-rules";
        branch: "main";
        path: "custom.txt";
        providerUrl: "https://raw.githubusercontent.com/gentslava/mihomo-rules/main/custom.txt";
      };
    };
```

Default exclusions include `ru`, `su`, `xn--p1ai`, private/local/reverse zones, telemetry,
advertising/tracking names, and infrastructure hostnames that are not meaningful routing
targets. Shared hosting/SaaS/CDN suffixes such as `googleapis.com`, `cloudflare.com`,
`vercel.app`, `githubusercontent.com`, `github.io`, `amazonaws.com`, `cloudfront.net`,
`fastly.net`, and `akamaized.net` are non-widenable by default. A tenant FQDN under one of
them may still be eligible for exact scope unless a separate exclusion covers it.

`defaultRuleScope` controls the initial choice for eligible candidates; it is not a hard
rule and does not override per-candidate review or `nonWidenableSuffixes`. The selected
value and its coverage are always visible before confirmation and apply.
`null` is the fail-closed first-install state and is valid only while the mechanism is
disabled. Enabling report/review collection requires an explicit `exact` or `site` choice;
the implementation never invents a factory scope.

The feature exposes preferences through a dedicated strict protected API, not the generic
raw-string settings mutation. `mode`, apply readiness, repository, branch, path, provider
URL, checkout path, and credentials are not accepted in that input. Report capability
accepts only `automationMode: off | review`; the separate protected automatic-consent
action can select `automatic` only after server-derived deployment readiness succeeds.
The resolver list is limited to the two reviewed credential-free JSON DoH endpoints.
The repository is pinned to `gentslava/mihomo-rules`, branch `main`, path `custom.txt`, and
the exact corresponding GitHub Raw URL; a mismatched checkout remote, branch, file, or
active provider fails closed. Git credentials are never stored in or returned through the
settings API. Boundary tests reject every client-supplied capability/repository/provider
field and every deployment mismatch.

Automatic consent is stored separately from mutable preferences. Its revision is a
code-owned safety version plus a SHA-256 fingerprint of the canonical automatic-safety
preferences (thresholds, scope default and guards, target channel, concurrency, timeouts,
and daily budget). Every locked automatic preflight requires an exact fingerprint match.
Changing any fingerprinted preference or the code-owned safety version invalidates consent,
falls back to `review`, and requires a fresh protected confirmation action and audit row.
Missing or stale consent never schedules, reserves budget, or publishes.

One process-wide coordinator serializes boot and settings-triggered config reconciliation.
It stops the domain runtime before every transition, always force-reloads Mihomo so a
byte-identical file cannot masquerade as an active config, and starts collection only when
the latest settings revision is still `ready` and enabled after that reload succeeds. A
newer mutation or shutdown fences every older completion. Failed reconciliation leaves the
persisted intent visible but keeps the runtime stopped. Every consumer, including listener
generation and review policy, derives from the same full settings parse; legacy partial or
corrupt rows are `invalid` and cannot mint a listener credential.

Activation proof is explicit in every config-apply result. Writing bytes, including a
byte-identical file, is not proof that the running Mihomo instance accepted them. After any
failed or unverified reload the coordinator clears its proof; the next otherwise unchanged
apply must force and verify a real reload before validation may restart.

If boot reconciliation runs before Mihomo is reachable, the first healthy controller poll
retries only that failed reconciliation; later engine reconnects and the manual reload action
use the same serialized coordinator. Every config apply caused by source, channel, pool, or
node-exclusion changes passes through that coordinator as well, so gaining or losing the selected
route starts or stops validation immediately. A successful config reload is not enough to start
the runtime when the selected channel has no usable exit: the generated validation listener must
also be present and target a non-empty proxy group.

While the runtime is active, the deferred observation sink promotes a normalized FQDN only
after `minimumConnectionCount` observations in the trailing validation window. Promotion
derives the candidate from the current full filter policy and wakes the bounded validation
scheduler. Each run reads current settings, the exact active channel projection, and bounded
provider caches; executes one pinned DIRECT/forced-PROXY pair; then rechecks coverage before
combining the pair with persisted window evidence. The two probes share a cancellation scope and
both settle before the run releases its lease. Missing, empty, opaque, oversized, unsafe, or more
than two daily refresh intervals old provider materialization makes coverage incomplete and
therefore blocks confirmation.

The two filter policies are independent:

- **Never add** uses `excludedTlds`, `neverAddDomains`, `neverAddSuffixes`, and
  `telemetryPatterns`. Matching destinations are rejected before validation and never become
  active candidates. A previously eligible candidate is retained as an inert `excluded` audit
  row and can re-enter only after the relevant filter is changed.
- **Do not widen** uses `nonWidenableSuffixes`. Matching destinations are still observed,
  validated, and eligible as exact candidates, but automatic site scope is disabled.

Public suffixes such as `com`, `ru`, and `co.uk` are always non-widenable and are not
stored in the configurable list. The admin UI exposes separate editors for the two
policies so changing a scope guard cannot silently turn into a total candidate exclusion.
An exact-only shared-hosting candidate is not classified as an exclusion.

The protected-suffix lock applies to automatic proposals. A deliberate manual rule may be
broader after the administrator reviews its observed coverage in the rule editor. Manual
rules are labelled as such and are never changed or removed by automation.

Publication credentials are supplied outside Git through deployment secrets and are
loaded only when apply is explicitly enabled. Report mode does not require them.

## 7. Observation storage and retention

The existing SQLite database receives these tables:

| Table | Purpose |
|---|---|
| `domain_observations` | deduplicated FQDN/time/transport/source/count |
| `domain_daily_stats` | daily connection counts and last/first seen |
| `domain_candidates` | observed FQDN, site group, due time, cooldown, scope, lifecycle, and reversible admin review state |
| `domain_validation_runs` | bounded scheduler/circuit-breaker summary |
| `domain_validation_attempts` | DIRECT/PROXY transport results and safe timings |
| `domain_decisions` | decision, deterministic confidence, reasons, selected scope and proposed rule |
| `domain_apply_operations` | commit SHA, previous/new revision, activation result |
| `domain_automatic_budgets` | atomic UTC-date reservations and consumed automatic-rule count |
| `domain_rule_ownership` | automatic/manual ownership and last successful mutation audit |

An observation key is a SHA-256 digest of normalized FQDN, transport, and a short start-time
bucket; source type is deliberately excluded. An opaque connection ID, when available, is
mapped to the same canonical fingerprint in memory but is not exposed. A snapshot matching
a recent primary log fingerprint reconciles `lastSeen` without incrementing the count.
Ambiguous matches are coalesced rather than double-counted, accepting conservative
undercounting so two sources cannot manufacture a threshold crossing.

Operational observations, stats, attempts, candidates, and non-apply decisions older than
14 days are deleted by the scheduler. Minimal apply audit is retained indefinitely by
default because the rule and commit are already public in the Git source of truth and are
needed for rollback explanations.

Candidate expiry is based on its last qualifying observation, not on validation or queue
maintenance timestamps. Rechecks may update lifecycle state and evidence, but cannot keep an
unobserved hostname alive indefinitely. Retention first removes the stale candidate's
operational children when no active lease or running validation exists, then removes the
candidate itself.

Apply-audit rows are self-contained snapshots of the published facts and revisions. They
must not have cascading foreign keys to operational candidate, validation, attempt, or
decision rows; operational retention therefore cannot erase publication history.

Decision confidence is deliberately conservative and reproducible from the decision
status: `high` only for a confirmed candidate that passed every hard gate, `low` for a
valid but incomplete pending evidence set, and `none` for a blocked or invalid result.
It is stored with the decision so reports do not invent a probabilistic score or reinterpret
historical evidence after policy changes.

Candidate lifecycle timestamps are monotonic. Queue reconciliation and lease claims cannot
predate the candidate's latest mutation; validation start cannot predate its lease claim; and
completion or failure cannot predate the latest candidate mutation. Lease fencing combines an
opaque lease ID with a monotonically increasing generation, so an expired worker cannot publish
evidence even if a later lease reuses the same ID.

## 8. Normalization, filtering, and rule coverage

Normalization:

1. trim, lowercase, and remove one trailing dot;
2. canonicalize IDNA/punycode;
3. enforce label/FQDN syntax and length;
4. reject IP literals, single-label/internal names, localhost, reverse zones, `.local`,
   `.home.arpa`, and invalid punycode;
5. preserve the observed FQDN and derive its registrable site with a maintained Public
   Suffix List including the private section;
6. compute which rule scopes are eligible without crossing protected multi-tenant
   boundaries.

Filtering happens before probes. It rejects excluded TLDs, configured never-add domains
and suffixes, telemetry/ads/tracking, insufficient observation counts, and existing
coverage. Shared/CDN classification by itself only locks the candidate to exact scope; a
hostname is excluded completely only when an independent never-add policy also matches.
Resolved-address eligibility is checked later by the asynchronous validator, never while
handling an observation.

Coverage checks the actual active Submerge routing/provider model and materialized
provider metadata. The currently required semantics include:

```text
example.com
+.example.com
DOMAIN,example.com
DOMAIN-SUFFIX,example.com
```

If an active provider format cannot be checked reliably, coverage is incomplete and the
candidate cannot be recommended or applied. Materialization accepts at most 64 distinct active
providers and 16 MiB in aggregate per snapshot, rejects symlinked cache roots/parents and files
that change while being read, and treats a cache older than 48 hours as stale for the current
daily provider refresh contract.

Every candidate keeps both its observation and its selected rule scope:

```text
observed: api.service.example
exact:    api.service.example
site:     +.service.example
```

Exact scope uses a bare hostname in the current `domain` behavior provider; `+.` is
reserved for site/suffix scope. The equivalent classical forms are `DOMAIN` and
`DOMAIN-SUFFIX`.

The initial selection follows `defaultRuleScope`. An administrator may switch an eligible
candidate during review. Site scope is disabled when the derived boundary is a public or
private suffix, a configured shared-hosting/CDN boundary, or otherwise risks covering
unrelated tenants. Scope eligibility is rechecked before apply.

Candidates and observations are grouped by registrable site in the read model. Applying a
site rule covers and suppresses all matching sibling observations. Applying an exact rule
does not silently cover siblings, but the UI continues to present them in one site group
rather than repeatedly presenting unrelated rows.

## 9. A/B validation

### 9.1 DIRECT

DIRECT validation:

1. resolves real public A/AAAA addresses through configured external resolvers used only
   by the validator;
2. rejects private, loopback, link-local, reserved, multicast, and documentation IPs;
3. samples usable addresses/resolvers across temporally separate attempts;
4. connects to the selected IP while preserving the original hostname for SNI and Host;
5. bypasses the Mihomo proxy without changing system/global DNS;
6. keeps TLS verification enabled;
7. bounds connect time, total time, redirects, and downloaded bytes.

DNS failure qualifies only when the configured resolver quorum fails with consistent
destination-negative answers. If any resolver in an unmet quorum fails at the transport or
protocol boundary, or if resolvers disagree between a public answer and a negative answer,
the result is an infrastructure failure and cannot count as evidence against the domain. An
IPv6 failure is ignored if the Submerge host has no verified IPv6 egress.

### 9.2 PROXY

The generated Mihomo config contains a dedicated authenticated HTTP listener named
`submerge-domain-validation`. Its `proxy` field points directly to the generated proxy
group for `customTargetChannelId`; Mihomo therefore bypasses normal route rules for this
inbound and cannot accidentally send the comparison through DIRECT or another channel.
Mihomo documents this listener-level forced outbound in its
[listener common fields](https://wiki.metacubex.one/en/config/inbound/listeners/).

In the shipped Compose topology the listener binds to the Mihomo container-network
interface and an internal port but is not published to the host. Submerge reaches it by
the `mihomo` service name on the private Compose network. The listener uses a fixed,
non-secret username and a dedicated randomly generated password. The password is stored
through the protected settings path; the pair is written to the listener's `users` field
and supplied as a proxy authorization header. Credentials are never placed in a URL, API
response, report, or log. They are independent of `MIHOMO_SECRET`.

For host-server development only, `dev:infra` may publish the same listener port to host
loopback and supplies a validated loopback endpoint. Production Compose never publishes
it. The endpoint and port are produced by topology/config validation rather than
hardcoded in the domain-intelligence module.

The prober refuses to run unless the active config contains the expected listener, target
group, authentication, and topology-appropriate reachable endpoint. Integration tests
cover Compose service-DNS reachability, host-development loopback reachability,
authentication rejection, listener/inbound identity, and the actual proxy chain from
Mihomo connection metadata. Changing a live selector is never used as a probing mechanism,
so user traffic and channel selection cannot be disturbed.

The route-proof request is owned by the PROXY hop lifecycle. Timeout or cancellation aborts
it, but the hop and enclosing executor do not report cleanup complete until the proof promise
actually settles. An uncooperative route-proof transport is therefore visible to the scheduler's
hard cleanup barrier rather than escaping as detached work.

PROXY DNS resolution uses configured resolver endpoints through this forced listener. The
selected public address is then pinned for the connection while the original hostname is
preserved for SNI and Host.

### 9.3 Redirect and SSRF policy

DIRECT and PROXY share one redirect policy. Every hop:

1. must remain HTTPS and contain no user-info credentials;
2. is normalized and filtered as a fresh hostname;
3. is resolved through the direction's resolver path;
4. is rejected if any returned address is private, loopback, link-local, reserved,
   multicast, documentation-only, or otherwise non-global;
5. connects only to a pinned validated public address while preserving hostname SNI/Host;
6. forwards no authorization header, cookie, or other state from the previous origin.

The redirect count and downloaded bytes are bounded. This pin-and-validate sequence is
repeated for every hop, preventing redirects and DNS rebinding from turning the worker
into an internal-network probe.

### 9.4 Stored result

Each attempt stores direction, timestamp, public resolved IP when applicable, HTTP status,
timeout/TLS/DNS/network category, connect/TLS/total duration, redirect count, transport
success, and sanitized final origin. Query strings, fragments, response bodies, auth
headers, cookies, and raw error output are never stored.

Any valid HTTP response proves transport reachability. `401`, `403`, `404`, and `429` are
application responses, not routing failures.

## 10. Decision thresholds and load control

A domain is confirmed only if all of the following hold within the trailing 24 hours. Persisted
non-null evidence windows must be between one and 24 hours and are validated on both write and
read, so arbitrarily old attempts cannot be reinterpreted as current proof:

- at least three DIRECT attempts failed with `connect_timeout`, `tls_timeout`,
  `tls_handshake_reset`, `connection_reset_before_http`, or resolver-quorum
  `dns_failure`;
- those attempts are separated by at least 120 minutes;
- resolver/address diversity exists when alternatives are available;
- at least two PROXY attempts returned valid HTTP responses;
- PROXY has no qualifying DNS/connect/TLS transport failure in the same window
  (`maximumProxyTransportFailures == 0`);
- the observation threshold and every filter pass;
- rule coverage is complete and the domain remains uncovered;
- the selected scope remains eligible and the generated rule still matches it.

Confirmation establishes that the observed FQDN has a DIRECT-versus-PROXY routing
problem. The selected scope is an explicit policy choice; it is not a claim that every
possible sibling hostname was independently probed.
For a qualifying DIRECT transport failure, the persisted sanitized final origin must be
covered by the proposed exact or site rule. A failure reached only after redirecting outside
that scope cannot confirm the candidate because applying the proposed rule would not route
the failing hop. Redirects within a selected site scope remain eligible.
Review state is a separate administrator decision: rejecting a candidate does not rewrite
its retained evidence status, so a rejected row may remain `confirmed`. It is nevertheless
never apply-eligible until explicitly restored and re-evaluated under the current policy.

One scheduler tick performs at most one A/B pair per due domain. Controls:

- persistent queue and debounce;
- per-domain two-hour cooldown with up to five minutes of persisted positive jitter;
  failed work doubles the base delay up to a total of 24 hours;
- maximum 20 candidates per run;
- concurrency 2;
- the same candidate cap is atomically reconstructed and reserved from persisted run starts
  across all wake-ups, scheduler instances, and restarts in a rolling minute, so repeated
  enqueue events or crash loops cannot bypass the global validation-start rate limit;
- a persisted global circuit breaker after three infrastructure failures within 15
  minutes; it remains open for 15 minutes after the threshold-crossing failure and is
  reconstructed from bounded validation-run history after restart;
- no immediate retry loop;
- a persisted maximum of three automatic rules per UTC day.

An event can enqueue immediately, but confirmation necessarily takes several spaced
attempts. There is no instant automatic rule after one failed connection.

## 11. Reports and admin UI

### 11.1 Reports

Report mode is the default. It produces a machine-readable result and a short admin read
model containing:

- report period and configuration revision;
- observer health and counts;
- excluded counts grouped by reason;
- candidates, site groups, selected scopes, generated rules, and scope restrictions;
- safe A/B results;
- confidence, decision, and reason codes;
- coverage and apply readiness.

Observed domain names may appear in the protected admin report because that is the
feature's purpose. They are not printed to stdout or general operational logs.

Report mode cannot mutate Git, providers, config, channels, or materialized rule files.
Its protected review actions are limited to eligible scope selection, reversible user
rejection, and recheck queueing in SQLite. User rejection remains separate from system
exclusion reasons; restoring a rejected candidate re-evaluates the current filter and
scope policy before making it eligible for validation again.
Overview lifecycle counts retain the persisted candidate status, while separate bucket
counts describe what the candidate and exclusion views contain. Review mutations return
stable, bounded reason codes for unavailable actions instead of requiring the UI to parse
error messages.

### 11.2 Admin UI contract

The approved Indigo Console source frames are in `pencil/web-ui.pen`:

- `O2cgg` and `CLhu9`: report and automatic desktop modes, dark;
- `Pqdfz` and `r5xWI`: corresponding light modes;
- `nGYul`: empty, degraded, confirmation, publication, and long-name states;
- `yNIlC`: 390 px candidate, list, mode, and scope flows;
- `IgxF5`: scope editor, both filter editors, and manual-rule flow;
- `w6qeY`: the Автоправила settings section in the main Settings screen.

These frames show a configured system with `site` selected as an example. They do not
define the first-install value of `defaultRuleScope`.

Required behavior:

- Candidate rows show the observed FQDN, generated rule, and an `exact` or `site` scope
  label before expansion. Protected shared/CDN candidates remain visible and exact-only.
- **Never add** and **Do not widen** have separate settings rows and editors. The former
  prevents validation/candidacy; the latter changes only eligible scope.
- Exclusion actions follow the reason: a user-rejected item can be restored, unstable
  PROXY evidence can be checked again, existing coverage opens the covering rule, and a
  telemetry/advertising match opens the relevant filter. An exact-only suffix is not an
  exclusion.
- `Exceptions` is a separate state of the candidate panel, not an accordion appended below
  it. Opening it replaces the candidate body, moves focus to the visible back control, and
  `Back to candidates` restores both the previous view and focus to the visible desktop or
  mobile trigger. Exception rows show the FQDN, a reason chip, and the reason-specific action;
  they never repeat the candidate's proposed rule or scope control.
- Expanded desktop candidates use compact DIRECT, PROXY, coverage, and scope rows rather than
  nested evidence cards. On compact layouts candidates become standalone rounded cards with
  rule-first identity, observed FQDN, two primary actions, and no third inline expand icon;
  their copy area remains the details trigger. An exact-only card explains the restriction in
  its summary and does not append a separate shield strip.
- Removing a rule or narrowing `site` to `exact` states only that matching destinations
  will lose coverage from this rule. It must not promise that they will route DIRECT,
  because another active rule/provider may cover them.
- A generated rule is never truncated in reports, API data, or the UI. On narrow screens
  it wraps to another line. Only the observed-domain label may use middle ellipsis, while
  its complete value remains available to assistive technology and copy actions.
- Mobile candidate actions provide at least a 44 px hit target even when the visible
  control remains 36 px high.
- Source labels (`Auto`/`Manual`), scope labels, generated rules, and counts stay
  consistent across report, automatic, light, mobile, and detail states.

## 12. Guarded apply

`mode` is the deployment capability gate and defaults to `report`.
`automationMode` is the admin workflow shown in the UI:

- `off`: no observation or mutation;
- `review`: observe and propose; each add/edit/delete requires an explicit action;
- `automatic`: confirmed candidates may be added by the scheduler after one explicit,
  audited transition into this mode.

Every mutation requires these shared preconditions:

```text
preferences.enabled == true
deploymentCapability.mode == "apply"
deploymentCapability.apply.available == true
dryRun == false
```

In review mode the current admin/CLI add, edit, or delete action is the authorization. In
automatic mode the persisted consent record for the current safety-policy revision is the
authorization; no click is required for each later batch. Changing from review to
automatic is therefore the explicit action described by the confirmation dialog. Report
mode can never mutate even if the UI workflow setting is stale.

Every candidate-derived apply, whether explicitly confirmed in review mode or selected by
automatic mode, has an additional non-negotiable veto:

```text
candidate.status == "confirmed"
candidate.reviewState == "active"
```

The publisher must re-read both fields under the global apply lock immediately before its
SQLite reservation and Git mutation. Pending, blocked, excluded, or rejected candidate
actions stop without consuming budget or changing Git, providers, config, or channels. This
check is required both when selecting a batch and in the final locked preflight; filtering
only by `status == "confirmed"` is forbidden. Only a distinct free-form manual-rule editor
action may bypass candidate evidence, and it remains subject to syntax, scope, coverage
preview, capability, Git, activation, and audit safeguards.

### 12.1 Automatic daily budget

`maximumAutomaticRulesPerDay` is a UTC-day ceiling, not a per-run limit. Before publication
the global apply lock and one SQLite transaction reserve the remaining slots in
`domain_automatic_budgets`. An idempotency key ties a retry to its original reservation.
Reservations are released only if the operation stops before push; once a commit containing
the rules is pushed, the slots are consumed even when later raw-source convergence or
activation fails. Restarts and concurrent scheduler/manual triggers cannot reset or exceed
the persisted budget. Explicit manual mutations do not consume the automatic daily budget.

### 12.2 Rule ownership

The marked Submerge-managed block contains both automatic rules and rules created through
the Submerge manual editor. Ownership is persisted in SQLite with the operation and commit
audit:

- an untouched automatic rule remains `Auto` and may be removed only by an explicit admin
  action or a separately approved future cleanup policy;
- editing an automatic rule manually changes ownership to `Manual` atomically with the Git
  mutation, so automation never rewrites the override;
- a rule created through the manual editor starts as `Manual` and bypasses candidate
  evidence thresholds, but still passes syntax, coverage-preview, Git, activation, and
  audit safeguards;
- pre-existing lines outside the managed block are preserved byte-for-byte and are
  read-only in the UI until an explicit future adoption design is approved.

Manual add/edit/delete and automatic add share the same publisher, lock, idempotency, raw
convergence, activation, and audit pipeline. Public suffix scope is the absolute widening
ceiling; the editor never offers rules such as `+.com` or `+.co.uk`.

### 12.3 Publication pipeline

Pipeline:

1. acquire a global apply lock;
2. verify observer health, current topology, target channel, and complete coverage;
3. require a clean managed checkout and fast-forward to current `main`;
4. branch by action kind under the same lock: for every candidate-derived request in
   review or automatic mode, re-read and require both `status == confirmed` and
   `reviewState == active`, then re-evaluate evidence and scope; for a distinct free-form
   manual-rule request, validate its explicit authorization, syntax, scope, and coverage
   preview without pretending it is candidate evidence;
5. reserve the UTC daily budget for automatic additions, or validate explicit manual
   authorization for add/edit/delete;
6. deterministically mutate only the marked managed block in `custom.txt`;
7. sort that managed block and preserve unrelated file bytes/order;
8. validate syntax/duplicates and run `git diff --check`;
9. create one commit and push without force;
10. record the commit SHA and wait until raw `main/custom.txt` reflects the mutation;
11. refresh the stable managed `custom` provider through the existing Mihomo client;
12. verify resulting coverage and routing to the configured VPN channel;
13. persist ownership, budget, complete/partial audit, and the final report.

A dirty checkout, non-fast-forward state, rejected push, raw-source timeout, incomplete
coverage, unstable proxy, or failed activation stops the pipeline. It never hand-edits a
provider cache. A pushed-but-not-activated commit is recorded and may be safely retried.

Rollback uses a normal Git revert, raw-source convergence, and the same provider refresh.
No force push or automatic deletion of concurrent human changes is allowed.

## 13. Scheduler and lifecycle

The scheduler follows the existing Submerge patterns:

- starts only after migrations and the boot config apply prerequisite;
- one in-process timer with persisted due state;
- immediate enqueue wake-up plus a low-frequency reconciliation pulse; a wake received
  during an active pass is coalesced into one trailing pass;
- single-flight per operation and global validation/apply serialization;
- all errors contained and reported once per failure streak;
- `AbortSignal` propagated through resolver/probe/publisher operations;
- graceful shutdown aborts current bounded work and waits for its transport cleanup;
- an executor that does not finish cleanup within the hard bounded drain moves the runtime
  into a failed-closed state, and no config mutation may cross that suspension barrier;
- cleanup failure is a terminal latch for network validation in the scheduler instance: it
  cancels the current validation generation and forbids periodic, wake, and manual probe starts
  until process restart, even if the underlying transport promise later settles;
- the latched scheduler keeps a separate maintenance-only pulse for crash recovery and
  14-day SQLite retention; that pulse cannot lease a candidate or invoke the network executor;
- overdue work after restart is processed in capped order, never as an unbounded burst.

Operational retention remains active when validation collection is disabled: the validation
scheduler stays alive as a maintenance-only pulse while its network executor gate is closed. The
enable gate is rechecked before every due item is atomically leased and started, so disabling a
pass prevents every later item in its snapshot from reaching the injected DIRECT/PROXY
executor. Lifecycle shutdown owns both timer-driven and explicit `runOnce` work and aborts
either before resolving. Before retention, expired crash runs are fenced, cancelled at their
persisted lease-loss time, and released; old FQDN/run rows therefore cannot survive forever
behind a stale `running` status while collection is disabled.
The same maintenance-only path remains active after a terminal cleanup latch, so fail-closed
network behavior cannot turn a long-running process into unbounded browsing-history storage.

Suggested cadence:

- routing observations: event-driven;
- `/connections` reconciliation: existing live pulse or at most every 5 seconds;
- due validations: wake-up plus 1-minute scheduler pulse, respecting two-hour cooldown;
- aggregation/report/retention: daily.

## 14. Testing strategy

Unit tests cover:

1. strict parsing of supported Mihomo connection log patterns;
2. rejection of unrelated/schema-drifted log messages;
3. snapshot/log cross-source deduplication;
4. lowercase/trailing-dot/IDNA/punycode normalization;
5. IP/private/local/reverse and `ru`/`su`/`xn--p1ai` exclusion;
6. independent never-add and non-widenable policies, including an exact-only shared/CDN
   candidate that remains eligible;
7. exact/suffix/classical coverage semantics and exact-rule serialization without `+.`;
8. registrable-site derivation, exact/site scope selection, per-candidate override, and
   protected-boundary locking;
9. retention and apply-audit preservation;
10. exact DIRECT failure enums, timing, resolver/address diversity, and DNS quorum;
11. resolver disagreement and redirect failures outside the proposed rule scope remain
    non-qualifying;
12. stable/unstable PROXY decisions with a zero-failure stability threshold;
13. HTTP `401`/`403`/`404`/`429` semantics;
14. redirect/final-origin sanitization;
15. route-proof cleanup ownership and terminal scheduler latching after hard-drain failure;
16. deterministic/idempotent managed-block updates;
17. report/apply capability, review/automatic consent, and dry-run interlocks;
16. partial publication/activation retry;
17. log/credential/domain redaction outside protected reports;
18. scheduler single-flight, circuit breaker, shutdown, and restart recovery;
19. per-hop redirect validation, private-target rejection, and pinned-address DNS-rebinding
    protection;
20. atomic UTC daily-budget reservation/consumption across retries and restarts;
21. automatic-to-manual ownership transitions and automation immutability afterward.
22. review and automatic candidate apply both veto pending, blocked, excluded, or rejected
    rows under the locked preflight, while a distinct valid free-form manual rule succeeds.

Component/browser tests cover:

1. exact/site selection, protected-suffix locking, and a deliberate manual-rule flow;
2. separate Never add/Do not widen settings and filter editors;
3. reason-specific exclusion actions and the absence of a restore action for system
   blockers;
4. rule removal and scope narrowing without a false DIRECT-routing promise;
5. long generated rules, middle-ellipsized observations, copy/accessibility text, and no
   horizontal overflow;
6. minimum 44 px mobile action targets with the 36 px visual control;
7. consistent source/scope/rule data across dark, light, report, automatic, mobile, and
   detail states;
8. populated, empty, accumulating, degraded, publication-in-progress, activation-error,
   and success states at the repository-required responsive widths.

Integration tests use mocked Mihomo log, `/connections`, DNS, DIRECT/PROXY HTTP, Git, raw
source, and provider-refresh boundaries with reserved `example.com` fixtures. They verify
that PROXY probes enter the dedicated authenticated listener through the active topology
and exit through the configured target group, that manual add/edit/delete uses the same
safe publication pipeline, and that pushed-but-not-activated retries preserve ownership
and daily-budget accounting. No test uses real browsing history or the production traffic
path.

Every behavior slice follows TDD, `pnpm verify:static`, an independent incremental code
review, and the repository's final review before any push.

## 15. Deployment and migration

Version 1 can ship with the feature disabled and no new runtime credential. Report mode
requires only the existing Mihomo access already held by Submerge.

Apply additionally requires:

- a clean persistent checkout or other explicitly approved Git workspace;
- a Git credential restricted to `gentslava/mihomo-rules`;
- a stable managed `custom` provider routed to the configured VPN channel;
- backup of changed deployment/config files;
- verified disable, retry, revert, and provider-refresh runbooks.

Installing/enabling apply is a separate production action. It does not change DNS,
networking, VPN nodes, VLESS, or log level.

## 16. Risks and anti-pollution controls

| Risk | Likelihood | Impact | Control |
|---|---|---|---|
| Mihomo log-format drift | Medium | missed observations | snapshot reconciliation, health degradation, apply blocked |
| Short connection missed by snapshots | Medium | incomplete map | info event is primary; snapshots are fallback |
| Host unavailable, only IP known | Medium | cannot propose rule | ignore rather than infer |
| Shared/CDN hostname | High | unrelated tenants routed through VPN | automatic exact-only lock, PSL private section, explicit manual coverage preview |
| Temporary destination failure | Medium | false positive | three attempts, two-hour spacing, resolver/IP diversity |
| Application denial response | High | false routing diagnosis | any valid HTTP response is transport success |
| PROXY/node outage | Medium | false comparison | unstable PROXY blocks decision and trips breaker |
| Unsupported provider coverage | Medium | duplicate/conflicting rule | incomplete coverage blocks recommendation/apply |
| Git race | Low | lost human change | clean checkout, fast-forward only, no force push |
| Apply runaway | Low | list pollution | disabled/report default, consent gate, atomic three-rule UTC daily budget |
| Module bug | Low | Submerge instability | bounded async tasks, error containment, feature flag, tests |

Mass pollution is prevented by independent gates: actual connection observations, visible
and confirmed scope, protected multi-tenant boundaries, hard telemetry exclusions,
complete active-list coverage, three spaced DIRECT failures, stable PROXY evidence, fresh
pre-commit scope and coverage revalidation, a three-rule cap, report-only default, and
multiple apply interlocks. Any uncertainty blocks apply.

## 17. First-install and deployment decisions

There is no hidden factory value for `defaultRuleScope`. The first-install UI requires the
administrator to choose `exact` or `site` before observation can be enabled; the approved
mockups show `site` only as a configured example.

Shipping the publisher code does not authorize a production mutation. Apply stays
fail-closed until a repository-scoped credential, clean persistent checkout, managed
provider, target channel, backup, and rollback verification are supplied by a separate
deployment change.
