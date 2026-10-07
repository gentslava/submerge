# Domain rules deployment and external synchronization

This runbook covers the local `custom.txt` boundary introduced by ADR-0006. Submerge owns
the canonical file update, SQLite audit, and Mihomo activation transaction. It does not
clone, fetch, commit, merge, pull, push, or hold Git credentials.

## Storage contract

- Submerge path: `/domain-rules/custom.txt`, read-write.
- Mihomo path: `/root/.config/mihomo/domain-rules/custom.txt`, read-only.
- The standard Compose file maps both paths to the explicitly prepared host directory
  `./domain-rules`.
- The directory must be a real, symlink-free directory owned by the Submerge runtime uid
  with mode `0700`. The file must be a regular, symlink-free, single-link file owned by
  that uid with mode `0600`.
- The file is UTF-8 text, at most 1 MiB and 10,000 unique rules. Blank lines and comments
  are allowed. A rule is either a normalized exact FQDN or `+.` followed by a normalized
  registrable domain. Embedded carriage returns and any other line form are rejected.
- At most one ordered `# BEGIN SUBMERGE MANAGED` / `# END SUBMERGE MANAGED` pair is
  allowed. Submerge owns this block; valid operator-managed lines outside it are preserved.
- Writers use `.submerge-domain-rules.lock`. A valid lock contains
  `<pid>:<opaque-id>\n`, is a regular single-link `0600` file owned by the writer uid, and
  is created with exclusive no-follow semantics. A writer re-reads `custom.txt`, compares
  its expected SHA-256-derived revision, writes and fsyncs a private same-directory
  temporary file, atomically renames it, and fsyncs the directory.
- Any existing, malformed, unsafe, or identity-changing lock blocks online mutation. No
  running service removes a lock based on age. A leftover lock or
  `.custom.txt.submerge-*.tmp` artifact is reconciled only after all writers are stopped,
  the rule volume and SQLite database are backed up, and the file state is inspected.

## Install in report mode

1. Back up `docker-compose.yml`, `.env`, `mihomo/config.yaml`, SQLite data, and every
   existing custom list.
2. Keep `DOMAIN_RULES_MODE=report`.
3. Create the mounts explicitly on Linux:

   ```bash
   mkdir -p mihomo domain-rules
   sudo chown -R 999:999 mihomo domain-rules
   sudo chmod 0700 domain-rules
   ```

4. If an existing valid `custom.txt` is being adopted, copy it to
   `domain-rules/custom.txt` while Submerge is stopped, set ownership to `999:999` and
   mode to `0600`. Do not add managed markers manually.
5. Mount the directory read-write in Submerge and read-only in Mihomo, start the stack,
   and verify reports while apply remains unavailable.

Docker Desktop may not expose a host bind with the exact numeric owner and owner-only
mode required by the safety check. In that case, replace both `./domain-rules` mounts
with the same named volume and declare it under top-level `volumes` (keep every unrelated
mount unchanged):

```yaml
services:
  mihomo:
    volumes:
      - domain-rules:/root/.config/mihomo/domain-rules:ro
  submerge:
    volumes:
      - domain-rules:/domain-rules

volumes:
  domain-rules:
```

Before the first stack start, initialize that volume once through the Submerge image:

```bash
docker compose run --rm --no-deps --user 0:0 --entrypoint /bin/sh submerge \
  -c 'chown 999:999 /domain-rules && chmod 0700 /domain-rules'
```

This is installation, not a permanent init service. When the deployment intentionally
keeps the Submerge `user: "0:0"` override, use `chown 0:0 /domain-rules` in that command;
the directory mode remains `0700`.

The standard image runs as uid 999. Prefer removing a `user: "0:0"` override and making
both writable volumes (`mihomo-config` and `domain-rules`) owned by `999:999`. If an
existing deployment intentionally keeps `user: "0:0"`, initialize the dedicated
`domain-rules` volume as `0:0` with directory mode `0700`; its `custom.txt` must be
`0:0`/`0600`. A fresh named volume copied from the image mount point starts as uid 999,
so a root-run Submerge needs this one-time ownership correction while the stack is stopped.
Any synchronizer must use the same effective uid.

## Migrate an earlier preview deployment

The removed Git-backed preview stored its working file at
`/app/data/domain-rules/repository/custom.txt`.

### Reconcile the preview-only operation index

An earlier `pr-32` image could apply the pre-merge form of migration `0012`, which created
`domain_rule_operations_commit_unique_idx`. The final migration folds the local-store
schema into `0012`, so Drizzle intentionally does not replay it on that persistent preview
database. This one-time repair is required only when `PRAGMA index_list` still reports the
old unique index.

Take a current SQLite backup first. Do not delete or edit the `0012` row in
`__drizzle_migrations`, and do not rerun the whole migration: its tables already exist.
Replace only the index in one SQLite transaction:

```sql
PRAGMA busy_timeout = 5000;
BEGIN IMMEDIATE;
DROP INDEX IF EXISTS domain_rule_operations_commit_unique_idx;
CREATE INDEX IF NOT EXISTS domain_rule_operations_revision_idx
  ON domain_rule_operations (commit_sha);
COMMIT;
PRAGMA integrity_check;
PRAGMA index_list(domain_rule_operations);
```

The final checks must return `ok`, list `domain_rule_operations_revision_idx` as
non-unique, and no longer list `domain_rule_operations_commit_unique_idx`. SQLite holds the
schema write lock for the short transaction; no Submerge or Mihomo restart is required.
The known persistent `pr-32` deployment was backed up and reconciled this way before the
pre-merge migration was squashed.

1. Stop Submerge and every external writer.
2. Back up the SQLite volume, the old path, and the new rule volume.
3. Copy the old plain `custom.txt` to the new rule volume, then set the required owner and
   `0600` mode before starting the new image.
4. Start in report mode and inspect the file before enabling apply.

If the preview database contains only terminal operation history, Submerge adopts it only
when the copied managed block exactly equals the current SQLite ownership set. Missing,
extra, or externally located owned rules fail as `local-store-migration-required`.
Non-terminal or reconciliation-required legacy operations remain blocked for explicit
operator recovery; do not delete audit rows to bypass the guard. There is no automatic
conversion for an ambiguous in-flight write. Restore the old image together with its
paired pre-upgrade SQLite/rule backup, finish or roll back that operation there, verify a
terminal state, take a new paired backup, and repeat the migration.

## Enable apply

1. Confirm the dedicated directory is persistent and mounted read-write only in Submerge,
   read-only in Mihomo.
2. Set `DOMAIN_RULES_MODE=apply` and recreate Submerge.
3. In Diagnostics, require a successful Mihomo configuration reload and provider/route
   proof. In Auto-rules, `Список custom` must report that the local list is ready.
4. Keep automatic mode disabled until manual confirmation has produced and activated a
   test rule successfully.

`local-store-migration-required` means the canonical file disappeared after initialization
or legacy audit history needs explicit migration. `local-store-unsafe` means the path,
owner, permissions, link identity, syntax, or content is unsafe. For
`local-store-reconciliation-required`, stop every writer, back up the rule volume and
SQLite database, compare `custom.txt` with the latest operation digest, and resolve the
unknown state before restarting.

## Optional Git synchronizer

Git synchronization is a separate deployment component. Give it:

- read access to the `domain-rules` volume while Submerge is running;
- a separate private volume for its Git working tree;
- its own remote URL, branch, SSH key/token, known-hosts policy, and network access;
- no access to Mihomo configuration, SQLite, or the Docker socket.

Run it with the same numeric uid as Submerge: uid 999 for the standard image, or uid 0
when the deployment explicitly runs Submerge as `0:0`. Its private repository volume must
also be writable by that uid.

The current safe online direction is local-to-remote only: observe a stable canonical
file, copy it into the private working tree, commit, and push. A synchronizer outage must
not block local rule application or routing.

The service may fetch and pull remote history into its private repository, but it must not
replace the canonical file while Submerge is running. It must also not install changed
remote content during an offline window: on restart Submerge compares the file with its
last durable digest and rejects unjournaled changes as
`local-store-reconciliation-required`. Until a narrow authenticated import API exists,
remote-to-local synchronization is therefore **staging and conflict reporting only**;
only byte-identical restoration of an existing canonical revision is accepted. The
synchronizer never calls Mihomo.

A future import API may serialize validation, SQLite reconciliation, file replacement,
reload, and route proof. That API does not move Git credentials or Git operations into
Submerge.

## Disable, uninstall, and recovery

- Disable mutations by setting `DOMAIN_RULES_MODE=report` and recreating Submerge. For an
  initialized file whose digest still matches SQLite, the existing provider remains
  injected read-only, while all rule mutations stay unavailable. A missing, unsafe, or
  externally changed file blocks reconciliation instead of silently changing routing.
- Remove an optional synchronizer by stopping it and removing only its private repository
  and credential mounts. Preserve `domain-rules`.
- The current release has no audited online deprovision action. Do not remove the rule
  mount from an initialized database: report mode deliberately preserves the proven
  provider. To uninstall, stop the stack and restore the pre-install `docker-compose.yml`,
  `.env`, Mihomo config, SQLite data, and custom-list backup from the same backup point;
  then start in report mode and verify the remaining routing. Never edit generated Mihomo
  config by hand.
- Recover a bad file by stopping all writers and restoring `custom.txt` **and SQLite from
  the same backup point**, with the runtime owner and mode `0600`. A file-only restore is
  accepted only when its SHA-256 is byte-for-byte equal to the durable marker already in
  SQLite. Start in report mode and verify configuration/provider/routes before re-enabling
  apply. Automatic rollback is not implemented in this release.
