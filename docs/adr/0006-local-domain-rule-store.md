# 0006 — Plain local domain-rule file with external synchronization

**Status:** accepted (amended 2026-08-05)

**Amends:** [ADR-0005](0005-mihomo-native-domain-intelligence.md), specifically its
source-of-truth and publication boundary

## Context

ADR-0005 originally treated `gentslava/mihomo-rules/custom.txt` and GitHub Raw as the
durable source and activation path. The first ADR-0006 revision removed the remote but
kept a private Git repository inside Submerge for local history and rollback.

That local repository is still the wrong product boundary. It makes the application
responsible for Git installation, repository provisioning, history validation, locks,
commits, recovery, and Git-specific audit data even when an installation never wants a
remote copy. It also makes a later bidirectional synchronizer compete with Submerge for
ownership of the same repository.

The product needs a safe, inspectable local `custom.txt`; it does not need Git semantics.
Repository configuration, credentials, remote convergence, merge policy, pull, and push
belong to a separate deployment service.

## Decision

Submerge owns only a plain persistent local rule file and its activation transaction.
The canonical file is `domain-rules/custom.txt` in a dedicated shared rule volume. Mihomo
mounts that volume read-only and declares the same file as the stable
`submerge-custom` file provider.

- `DOMAIN_RULES_MODE=report|apply` remains a deployment-only switch and defaults to
  `report`.
- Apply provisioning validates the dedicated directory and file, preserves an optional
  seed byte-for-byte, declares the stable provider, force-reloads Mihomo, and verifies
  the resulting route before apply becomes available.
- Submerge deterministically changes only its marked managed block, validates the full
  file, and publishes it with an atomic replace while holding the local rule-store lock.
- SQLite records a SHA-256-derived expected source revision, the intended and resulting
  full SHA-256 digests, operation ID,
  ownership delta, budget reservation, and activation result. These digests replace Git
  parent/commit identifiers as the crash-reconciliation authority.
- Startup and retry reconcile an unfinished operation against the expected or resulting
  file digest. An unknown third state fails closed as
  `local-store-reconciliation-required`.
- Mihomo reads the canonical file directly. There is no second materialized copy and no
  `.git` directory in a Mihomo mount.
- Submerge does not install or execute Git and has no repository, branch, remote, commit,
  credential, hook, SSH-agent, fetch, pull, merge, or push code.

An optional synchronization service is a separate deployment component. It may read the
dedicated rule volume plus own a private repository volume. It owns all Git configuration,
credentials, polling, commits, fetches, conflict handling, and pushes. It runs with the same
numeric uid as Submerge and receives neither the Mihomo config nor SQLite volume. Submerge
continues to work offline when this service is absent or unhealthy.

The initial safe publication direction is local-to-remote only. The service may observe a
stable canonical file and replicate it into Git. It may fetch and stage remote updates in
its private repository, but may not replace the canonical file: Submerge rejects any
unjournaled digest change even across a restart because it would bypass SQLite ownership
and operation audit. A later authenticated Submerge import/reconciliation interface may
serialize file validation, SQLite reconciliation, activation, and route proof. The
synchronizer never controls Mihomo.

Before every file mutation, Submerge persists an apply-operation journal containing the
operation ID, expected source digest, intended digest, ownership delta, and any automatic
budget reservation. The journal is finalized exactly once after the resulting digest is
attested, then the provider is force-reloaded and verified.

Report remains the default. Local initialization, file changes, configuration changes,
and activation remain behind explicit apply readiness and the existing review/automatic
consent gates.

Switching an initialized deployment to report mode disables mutations without removing
the attested provider from generated configuration. A missing, unsafe, or digest-mismatched
store blocks reconciliation; it does not silently reroute previously confirmed rules.

## Alternatives considered

### Keep a private Git repository inside Submerge

- (+) Provides local history and familiar commit identifiers.
- (-) Retains Git runtime and recovery complexity in every installation.
- (-) Couples the application transaction to Git internals.
- (-) Creates ambiguous ownership when a bidirectional synchronizer is added.

Rejected. SQLite already provides the operation audit needed by the product, while the
plain file is the portable artifact.

### Push from Submerge to a pinned external repository

- (+) Preserves one existing public-list workflow.
- (-) Couples a general self-hosted product to a forge and account.
- (-) Requires credentials and network policy in the application container.
- (-) Makes local routing depend on external convergence.

Rejected. External replication is deployment logic.

### Let the synchronization service activate Mihomo directly

- (+) Keeps the application unaware of externally pulled changes.
- (-) Splits provider/config ownership between two services.
- (-) Bypasses Submerge's serialized configuration coordinator and route proof.

Rejected. The current synchronizer only reads the canonical file and writes its private
Git working tree. A future authenticated import API may ask Submerge to change the
canonical file, but the synchronizer never replaces it directly. In every case Submerge
remains the sole owner of Mihomo configuration and activation verification.

### Store rules only in SQLite or inline Mihomo configuration

- (+) Removes the shared file.
- (-) Removes the portable `custom.txt` artifact required for optional synchronization.
- (-) Makes operator inspection and recovery harder.

Rejected. The plain file is a useful stable integration boundary without requiring Git.

## Consequences

- (+) Local rule application works offline and has no Git dependency.
- (+) The runtime image is smaller and contains no repository tooling.
- (+) No Git credentials or forge configuration can enter Submerge.
- (+) A separate synchronizer can evolve independently and receive only read access to the
  rule volume plus its private repository and credentials.
- (+) SQLite audit and content digests are sufficient for deterministic retry and recovery.
- (-) Git history and remote conflict resolution are unavailable unless the separate
  synchronization service is deployed.
- (-) Remote-to-local application is deferred until a coordinated import API exists;
  current remote updates can only be fetched and staged outside the canonical volume.
- (-) Automatic rollback remains unavailable until audited prior file snapshots are added;
  operator recovery uses an explicit backup in the meantime.
