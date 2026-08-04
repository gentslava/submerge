# 0006 — Local domain-rule store with optional host-side export

**Status:** accepted (2026-08-04)

**Amends:** [ADR-0005](0005-mihomo-native-domain-intelligence.md), specifically its
source-of-truth and publication boundary

## Context

ADR-0005 originally treated `gentslava/mihomo-rules/custom.txt` and GitHub Raw as the
durable source and activation path. That was deployment context, not a valid product
boundary for a general self-hosted VPN console.

Making Submerge push to an external repository would require repository-specific URLs,
network convergence, and SSH/token credentials inside the application container. It
would also make local routing depend on an unrelated hosted service. Different
self-hosted installations may want no external copy, a private forge, GitHub, or a
completely different backup mechanism.

Mihomo supports a `file` rule-provider whose path is inside its HomeDir. Submerge already
writes that persistent HomeDir through its existing config boundary, so local activation
does not need an HTTP provider.

## Decision

Submerge owns a dedicated persistent local repository on branch `main`. Its worktree is
private to Submerge and contains `custom.txt`; it is not mounted into Mihomo. The
publisher atomically materializes the attested committed blob to a separate code-owned
`domain-rules/custom.txt` inside Mihomo's HomeDir. Mihomo sees that one file as a
read-only source, never the repository or `.git` metadata.

- `DOMAIN_RULES_MODE=report|apply` is a deployment-only switch and defaults to `report`.
  Changing it to `apply` triggers a separate provisioning transition before candidate
  apply can become available.
- Provisioning initializes or validates the private repository, creates a byte-preserving
  baseline commit, materializes that exact blob, declares the stable local provider, and
  verifies a serialized Mihomo config reload. Candidate apply remains unavailable until
  every provisioning proof succeeds.
- It deterministically updates only its managed block, validates the resulting file, and
  creates a local commit with fixed non-secret author metadata.
- Generated Mihomo configuration references the materialized file through a stable
  `type: file`, `behavior: domain`, `format: text` provider and a `RULE-SET` route to the
  configured VPN channel.
- Every activation atomically materializes the committed blob, force-reloads the full
  generated config through the existing serialized coordinator, and verifies the blob,
  provider, and resulting route. It does not wait for GitHub Raw or another mirror.
- Submerge never accepts a remote URL, deploy key, token, SSH agent, hook, or arbitrary
  publisher command. It never fetches or pushes.
- Any remote backup/mirror is an optional host responsibility. A host-side script may
  export an attested immutable commit through a separate host-owned mirror/snapshot and
  push to an explicit host-configured destination using credentials outside every
  Submerge mount. It must never write the app repository or persist a remote, credential,
  hook, helper, socket, alternate, or promisor configuration there.

Before every file/Git mutation, Submerge persists an apply-operation journal containing
the operation ID, expected parent, intended content digest and ownership delta, plus any
automatic budget reservation. The operation ID is embedded in non-secret commit metadata.
Startup/retry reconciliation attests parent, path, blob, and operation ID under the global
apply lock, then finalizes ownership/budget exactly once or fails closed on unknown history.

Report remains the default. Local initialization, commits, configuration changes, and
activation remain behind explicit apply readiness and the existing review/automatic
consent gates.

## Alternatives considered

### Push from Submerge to a pinned GitHub repository

- (+) Preserves the existing public list workflow.
- (-) Couples a general self-hosted product to one account, forge, and raw URL.
- (-) Requires sensitive credentials and SSH/network policy in the app container.
- (-) Makes local activation wait for an external publication path.

Rejected. External replication is useful for one deployment but is not product logic.

### Let a host script both edit and publish the active list

- (+) Keeps Git completely outside the container.
- (-) Splits rule ownership and transactional audit between two writers.
- (-) Makes activation timing and rollback ambiguous.

Rejected. Submerge must own the local rule transaction it presents in the UI. The host
script may copy commits outward but may not mutate the worktree.

### Store rules only in SQLite or inline Mihomo configuration

- (+) Removes Git from the runtime.
- (-) Loses a simple inspectable history and a portable `custom.txt` artifact.
- (-) Makes optional external synchronization harder.

Rejected. A local repository is small, familiar, and useful without imposing a remote.

## Consequences

- (+) Local rule application works offline and has no Git-host dependency.
- (+) No SSH key, token, cookie, or repository credential enters Submerge.
- (+) Every installation chooses independently whether and where to mirror its rules.
- (+) Mihomo reads only an attested materialization from its own safe HomeDir and cannot
  read or modify `.git`.
- (+) The local commit SHA remains a durable audit and rollback reference.
- (-) The runtime image needs the Git CLI for local init/commit operations.
- (-) Operators who want an external copy must configure and monitor a separate
  host-side sync job.
- (-) The private repository and active materialization require two persistent paths and
  a crash-reconciled copy/reload step.
