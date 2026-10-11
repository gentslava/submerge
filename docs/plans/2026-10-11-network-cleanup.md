# Native connection mode cleanup

Status: implemented and verified locally; not deployed.

The user rejected the deployment/configuration controls embedded in Settings and
the duplicate routing policy stored in the TUN profile. Implementation is authored
directly, without subagents, with three explicit review passes before publication.

## Agreed scope

- Settings: one Proxy / TUN selector, immediate activation, visible progress and a
  concrete failure. No manual check button, prerequisite list, advanced engine
  form, repeated success text or AdGuard/device-setup guide.
- DNS: independent defaults are automatic. Optional home-network DNS lives in a
  separate DNS setting with an example explaining its purpose; it never blocks
  ordinary TUN activation.
- Routing: the existing Direct matcher owns local networks/domains, RU zones,
  GeoSite, GeoIP and bypass lists. Published file lists use the existing channel
  list editor and read-only mount. Explicit VPN exceptions precede broad Direct
  rules; notblocked exact domains retain their earlier priority.
- One persisted network setting owns capture mode and DNS preferences. Existing
  duplicated profile/preferences are migrated once; routing values move into
  channel matchers. Mode switches do not rewrite routing rules.
- Remove JSON examples, profile-file seeding, the public gateway CLI and gateway
  environment configuration. Keep only automatic engine bootstrap and the real
  deployment permissions/forwarding guard.
- Preserve private-list fetch ownership, protected TUN/API, credentials, restart
  recovery, independent public/bootstrap DNS, real-IP GeoIP checks, fail-closed
  empty VPN pools and explicit rejection/rollback of invalid engine configuration.

## Verification

Keep focused regressions for actual behavior and remove tests of deleted controls
and configuration paths. Run the existing static gate and native Linux scenario;
render Settings and Routing at 1440x1024 dark and responsive widths
320/390/425/768/1024 plus the changed container boundary, both themes and
pending/error/empty states. Browser plugin not available; use the existing
Playwright workflow with zero retries and temporary evidence outside the repo.

Review passes: (1) routing/persistence/failure logic, (2) copy/layout/interactions,
(3) full PR diff, dependency references and removal of redundant mechanisms.
Production, existing client routes and AdGuard remain outside this task.

## Review pass 1 — logic

Fixed a duplicate late local-network rule that could override default VPN routing
after DNS resolution. Local presets/CIDRs now appear once at the agreed early
stage, while Direct domain/GeoSite/GeoIP rules follow proxy exceptions. Direct is
pinned before Default in the routing editor, rather than offering a drag order
that the TUN engine ignores. Corrupt stored encodings now fail explicitly;
notblocked.txt is always a domain provider. Obsolete tests of JSON/CLI/advanced
controls were removed; native routing/failure tests remain.

## Review pass 2 — interface

Removed the manual checker, permanent success paragraphs, advanced form and
AdGuard/client guide. DNS feedback stays beside its own field and drafts do not
blink back to the saved value during requests. The native controls use existing
260px fields, 13px segmented labels, 15px headings and design tokens; measured
browser values agree. Published lists are selected in Direct/Default, including a
long filename at all required widths. Default’s forced lists explicitly explain
their priority. Removed unused pointer-intent handlers/styles and sortable Direct
branches instead of retaining dead compatibility UI.

## Review pass 3 — whole change

Reviewed the full branch diff against origin/master as well as this cleanup.
Deleted profile JSON examples, seed/CLI pathways, all four gateway environment
settings, duplicated persistence and tests of the removed controls. The legacy
parser remains server-private only for one-time upgrade; runtime rules read
channels. Removed stale documentation and excluded the migration test helper from
production compilation. Added home-DNS resolution proof after apply; failure
restores the previous settings and attempts to restore the accepted engine configuration. Native guard,
credential recovery, file ownership and read-only publishing remain covered.
Three passes were authored directly as requested; no new subagent review was run.

## Final evidence

- `pnpm verify:static` passed: raw Biome, token drift, typecheck, 142 shared /
  1336 server / 297 web tests and production builds.
- Chromium: 44 Settings/Routing/forms/layout scenarios passed with zero retries.
  After the final file-select width correction, the 12 Settings/file scenarios
  passed again. Both themes and 320/390/425/768/983/984/985/1024/1440 widths are
  covered by the relevant suites, including loading/error/empty/pending states.
- Built-image Linux Mihomo: 2/2 scenarios passed, including Proxy/TUN switching,
  independent DNS, exact published domains, restart recovery, credential/file
  permissions and forwarding rejection after engine termination.
- Local Docker build and standard/test Compose validation passed.
- Inspected desktop and mobile screenshots in `/tmp/submerge-network-*.png`.
  Browser measurements confirm the existing 260px field, 13px segmented text
  and 15px heading geometry. Design variables remain unchanged. The Pencil
  desktop connection was unavailable, so no Pencil-renderer evidence is claimed.
- Final copy/reference pass removed the stale mandatory-DNS instruction from
  README. Published-file controls use the existing row width and retain a title
  for long filenames rather than clipping common filenames to 120px.

Physical LAN/client routes, a real subscription acceptance run and production
deployment remain separate from this verified local change.
