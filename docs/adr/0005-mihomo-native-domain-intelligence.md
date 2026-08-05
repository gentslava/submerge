# 0005 — Mihomo-native domain intelligence inside Submerge

**Status:** accepted (2026-08-03)

## Context

Submerge manages the Mihomo instance that makes the routing decision for each connection:
send it DIRECT or through a selected VPN channel. The domain-intelligence feature should
learn from that boundary and must not depend on whatever DNS resolver, router, or client
exists before it.

The feature needs to:

- build a daily map of destination FQDNs actually seen by Mihomo;
- identify FQDNs that repeatedly fail through DIRECT but work through a VPN channel;
- recommend a visible, reviewable rule scope for `custom.txt`;
- optionally apply confirmed rules to a plain local `custom.txt`;
- remain completely outside the synchronous connection-routing path.

Submerge already has the relevant infrastructure:

- a validated Mihomo `/logs?level=info&format=structured` stream;
- a validated `/connections` client with destination host metadata;
- SQLite, migrations, background schedulers, structured logging, and clean shutdown;
- the current Mihomo proxy endpoint, rule-provider configuration, and secret;
- config generation and reload ownership.

Mihomo's normal info stream emits a routing record for connection attempts. Long-lived
connections are also visible in `/connections`. Neither source requires a log-level
change or knowledge of an upstream DNS product.

## Options considered

### A. External collector tied to an upstream DNS product

The collector reads another product's query history and sends candidates to Submerge.

- (+) It can see DNS-only lookups.
- (-) It couples Submerge automation to infrastructure outside its responsibility.
- (-) DNS lookups are not proof that traffic was actually attempted.
- (-) It introduces unrelated credentials, pagination, retention, and deployment logic.
- (-) Replacing the upstream resolver changes the feature.

Rejected. Upstream DNS was deployment context, not a product boundary.

### B. Separate generic worker fed by Submerge

Submerge emits observations to a Python/systemd worker, which performs validation and
publication.

- (+) Strong process isolation.
- (+) The worker is independent of upstream DNS.
- (-) Duplicates configuration, storage, scheduling, health, and deployment machinery.
- (-) Requires a new authenticated Submerge-to-worker contract and a second runtime.
- (-) Makes future UI/state integration more complicated for this single-instance scale.

Rejected for the initial implementation. The isolation benefit does not justify the
extra moving parts while all work is bounded asynchronous I/O.

### C. Optional background module inside Submerge

Submerge observes its own Mihomo events, persists a bounded history, and runs validation
and publication asynchronously.

- (+) Correct ownership boundary: learn only from traffic Mihomo is asked to route.
- (+) No upstream DNS dependency or credential.
- (+) Reuses the existing Mihomo client, SQLite, lifecycle, settings, and UI contract.
- (+) Event-driven enqueue is possible without blocking a connection.
- (+) The current proxy/channel/provider topology is always known.
- (-) Bugs share the Submerge process.
- (-) Local rule-file mutation adds bounded filesystem work to the container.

Chosen, with strict concurrency, timeouts, circuit breakers, error containment, and
report-only defaults.

## Decision

Implement domain intelligence as an **optional background Submerge module**.

### Observation boundary

The module consumes only normalized internal observations:

```ts
interface DomainObservation {
  fqdn: string;
  observedAt: number;
  transport: "tcp" | "udp";
  source: "mihomo-log" | "connection-snapshot";
}
```

The primary source is the existing Mihomo info stream. A strict parser recognizes only
known connection-routing records and extracts the destination hostname. Periodic
`/connections` snapshots reconcile long-lived connections and provide a fallback.

Events containing only an IP address, malformed/ambiguous hosts, or private/local names
are ignored. No raw client address, DNS payload, URL, SNI packet, or response body is
stored.

The rest of Submerge does not know or care how the client resolved the name before the
connection reached Mihomo.

### Asynchronous processing

Observation handling performs only validation, deduplication, and a small SQLite write.
It never waits for DNS, HTTPS, a rule-file write, or provider activation.

A background scheduler later performs rate-limited DIRECT/PROXY A/B probes. A daily job
generates reports. Apply remains a separately gated operation and is disabled by default.

### Rule scope

Transport evidence and rule scope are separate decisions. A failed probe confirms a
problem for the observed FQDN; it does not impose one universal rule shape. Each candidate
therefore carries one of two explicit scopes:

- `exact`: only the observed FQDN, represented as a bare hostname in a `domain` behavior
  provider or `DOMAIN,<fqdn>` in a classical provider;
- `site`: the registrable site and its subdomains, represented as
  `+.<registrable-domain>` or `DOMAIN-SUFFIX,<registrable-domain>`.

Submerge derives the site boundary with a maintained Public Suffix List including its
private section, then applies configurable shared-hosting/CDN protections. The Public
Suffix List is a boundary input, not proof that widening is safe. If site scope could
capture unrelated tenants, it is unavailable and the candidate is locked to exact scope.

Filtering and scope protection are separate policies:

- `never-add` rejects a destination before probes, so it never becomes a candidate;
- `non-widenable` keeps the destination eligible for probes and an exact rule, but blocks
  automatic site scope through a shared-hosting, CDN, or multi-tenant suffix.

Public suffixes such as `com` and `co.uk` are intrinsically non-widenable and do not need
configuration entries. The non-widenable lock governs automatic proposals. An
administrator may still create a deliberately broader manual rule in the rule editor
after seeing its coverage; such a rule is manual and is never changed by automation.

The initial scope is selected by product configuration rather than fixed as an
architectural invariant. Report and review surfaces always show the selected scope, the
exact generated rule, and what it covers. An administrator may change an eligible
candidate's scope before confirmation. Apply uses only that confirmed scope and
revalidates its boundary immediately before publication.

Observations are grouped by registrable site for presentation. Sibling observations are
suppressed only when the selected/applied rule actually covers them: site scope suppresses
matching siblings, while an exact rule does not. This avoids repeatedly presenting the
same site as unrelated candidates without silently widening coverage.

### Source of truth and activation

As amended by [ADR-0006](0006-local-domain-rule-store.md), each installation owns a
plain persistent `custom.txt` as its durable local source. Submerge atomically updates
that file, reloads the stable file provider, and verifies the route. Git and external
mirroring are outside Submerge and may be provided by a separate deployment service.

## Event-driven behavior

Event-driven enqueue is allowed and preferred:

```text
Mihomo routing event
  -> parse and normalize FQDN
  -> deduplicate/enqueue in SQLite
  -> return immediately

background scheduler
  -> spaced DIRECT/PROXY probes
  -> decision/report
  -> optional guarded apply
```

The routing event is never held open for a probe, decision, rule-file write, or activation.
One event or one probe can never confirm a domain.

## Security and failure semantics

- The feature flag and apply mode are off by default.
- A failed observer, validator, report, or rule-file writer is fail-open for user traffic.
- Unsupported, empty, unsafe, or stale rule-provider coverage blocks recommendation/apply.
  For externally refreshed providers, a cache older than two refresh intervals is stale;
  provider count and aggregate bytes are bounded per coverage snapshot. The local
  `submerge-custom` provider is age-exempt and is instead attested against its canonical
  file digest and current config-activation proof.
- Apply requires persistent configuration and a confirmed rule scope. Review mode requires
  an explicit rule action; automatic mode requires an explicit, persisted enablement.
- Submerge never accepts or reads publication credentials, remote URLs, or SSH agents.
- The module does not change DNS configuration, Mihomo log level, VPN egress, VLESS, or
  node-selection policy.
- All background tasks are single-flight, bounded, abortable, and stopped during
  graceful shutdown. Runtime suspension is a hard barrier: a validator that does not finish
  transport cleanup prevents the following Mihomo config mutation instead of overlapping it.
  The scheduler latches terminally closed after such a timeout and cannot accumulate later
  validation work; process restart is the explicit network-recovery boundary. A separate
  maintenance-only pulse continues 14-day SQLite retention without leasing candidates or
  invoking probes.
- Config application reports activation proof separately from file mutation. A failed or
  unverified reload clears that proof, and byte-identical output cannot restart validation
  until Mihomo is force-reloaded successfully.
- Resolver transport/protocol failures are infrastructure failures even when another resolver
  returns a negative answer; public/negative disagreement and other mixed quorum failures never
  become evidence against a domain.
- A DIRECT failure after a redirect qualifies only when the proposed rule covers the sanitized
  failing origin. This prevents one blocked shared redirect target from generating many
  ineffective rules for otherwise reachable origins.
- Forced-route proof is owned asynchronous work: cancellation does not release the validator
  lease or config-mutation barrier until the proof transport has actually settled.

## Consequences

- (+) The feature works with any upstream resolver or with none.
- (+) The daily map represents actual Mihomo connection attempts rather than unrelated
  DNS lookups.
- (+) No new Python runtime, systemd units, queue, API token, or SQLite database is needed.
- (+) Submerge can expose status, candidates, and audit through its existing API/UI.
- (+) Current Mihomo topology and active provider coverage are available without a new
  integration contract.
- (+) Exact-host and whole-site routing are both expressible without an unconditional
  widening or no-widening rule.
- (-) Site-scope classification depends on an up-to-date suffix dataset and conservative
  shared-hosting/CDN protections.
- (-) Very short connections depend on Mihomo's info-log record; log-format drift must be
  detected and must disable apply rather than silently lose observations.
- (-) Destinations available only as IP addresses cannot be proposed automatically.
- (-) Optional local file mutation must remain isolated behind the apply feature gate.
