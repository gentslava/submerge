# Default route selection

Status: implemented and verified locally; not merged or deployed.

Spec: [Default route selection](../specs/2026-10-30-default-route-design.md).
Baseline: `330c3c5c9774434bd4cea018ac0f6d26e7ed2a80` on `codex/proxy-tun`.

One vertical slice: shared contract and migration → saved setting and activation →
Proxy/TUN config generation → Default editor → readiness/diagnostic attribution.

- [x] Red: direct catch-all, explicit VPN rules and empty VPN pools.
- [x] Implement and test persistence, activation failure, UI and route attribution.
- [x] `pnpm verify:static` and focused browser gates, zero retries.
- [x] Incremental independent `/code-review` (Standards and Spec); resolve findings.
- [x] Final independent `/code-review` across the whole feature; resolve findings.
- [x] Record visual evidence and limitations. No commit/push without user request.

Visual evidence must include `lYrng` / `HXRTv`, reused `oXxu8/KvheA` segmented
metrics, 1440×1024 dark screenshots and 320/390/425/768/1024/1440 plus the changed
container boundary. Exercise populated/empty/error, expanded/collapsed, pending,
keyboard, both route choices, reload persistence, and overflow of `html`,
`.app-main`, `.responsive-page`. No popup behavior is added.

## Evidence

- Pencil MCP cannot connect to the running app; reference values read directly
  from the tracked plain JSON as permitted by `docs/design-system.md`.
- Red: all 9 new routing tests failed against the old catch-all/empty-pool behavior;
  activation rollback and diagnostic attribution tests also reproduced their
  respective failures before the fixes.
- Raw `pnpm verify:static` passed after all review fixes: Biome, token drift, types, 142 shared / 1359
  server / 297 web tests and production builds. Four opt-in server tests remain
  skipped. Existing Biome schema/store-link and Vite warnings are unchanged.
- Chromium: 31/31 Default and existing Routing scenarios after review fixes, zero retries. This covers
  both themes; 320/390/425/768/983/984/985/1024/1440 widths; real keyboard selection;
  saved selection after reload; pending/error/retry; no-node and populated rules;
  expanded/collapsed states; the three required overflow owners.
- Screenshots inspected: `/tmp/submerge-default-route-1440-dark.png` (1440×1024,
  dark) and `/tmp/submerge-default-route-390-dark.png` (390×1024, dark). The reused
  `oXxu8/KvheA` control measures exactly 260 px at desktop, with 3 px inset/gap,
  7×13 px option padding, 13 px labels, accent `rgb(85, 88, 230)` and white active
  text. Measurements: `/tmp/submerge-default-route-metrics.json`. No clipping or
  horizontal overflow was found in the new control. Full new Pencil frame render
  is unavailable; no claim of a rendered Pencil visual diff is made.
- Final logs: `/tmp/submerge-default-route-static-accepted.log`,
  `/tmp/submerge-default-route-browser-final.log`. The 390 px failure state was also
  inspected in `/tmp/submerge-default-route-error-390-dark.png`; the previous VPN
  choice remains selected beside the inline error, with no overflow.
- No production, real subscription, physical LAN, or live engine acceptance run
  for this addition. Integration and deployment are separate from these local gates.

## Incremental code-review

Invoked the installed `code-review` skill at
`/Users/gentslava/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.3.1/skills/engineering/code-review/SKILL.md`.
It requires separate parallel Standards and Spec reviewers. Task-start HEAD is
the pinned baseline; uncommitted and new files are included because commits were
not requested. Reviewer agents are read-only.

### Standards

Reviewer: `/root/incremental_standards`. No findings. Reviewed the complete diff,
new migration/snapshot, control/tests, spec/plan, screenshots and measurements.

### Spec

Reviewer: `/root/incremental_spec`. Three P2 findings, resolved:

1. An Always VPN provider could match the IP-trace host while attribution claimed
   Direct. Attribution is now explicitly uncertain when those lists could match.
2. A channel-list refetch could expose staged state during pending activation and
   retain it after rollback. The control/header now keep the accepted selection
   during the mutation; failure restores and invalidates cached authoritative data.
3. Direct-only diagnostics still skipped the IP trace and reported no VPN nodes.
   Direct default now permits the trace and a ready state without unused VPN nodes.

Both diagnostic failures were reproduced with regression tests before their fixes.
The refetch test forces stale data/visibility refetch while activation is held.
Removing the pending-selection guard made that test fail on the selected route;
restoring it passed. This fault-injection receipt is
`/tmp/submerge-default-route-refetch-fault.log`; the diagnostic red receipt is
`/tmp/submerge-default-route-review-red.log`.

Incremental totals: Standards 0; Spec 3 P2, all resolved.

## Final code-review

The same skill reviewed the entire feature against the pinned baseline, followed
by independent verification of the final corrections.

### Initial feature final Standards review

Reviewer: `/root/final_standards`. No findings on the complete feature or final
delta. The routing-uncertainty getter preserves the existing activation-proof
contract; both registration callbacks are cleaned up together. No unresolved
standards violations or actionable smells.

### Initial feature final Spec review

Reviewer: `/root/final_spec`. One P2, resolved: the separately injected managed
provider can match the IP-trace destination before the Direct catch-all. A failed
or pending activation proof does not establish that retained rules are absent.
Diagnostics now use provisioning/initialization history to report uncertainty
whenever managed rules may remain effective, independently of activation proof.

The regression uses the real deployment controller: managed routing is retained,
the proof fails, and attribution must remain uncertain. It failed before the fix
(`/tmp/submerge-default-route-unconfirmed-red.log`) and passed afterward. Focused
diagnostic/controller/config verification passed 75 tests. Existing controller
tests also cover an initialized store failing boot attestation with both active
proof and recovery flag false. The independent reviewer reproduced retained
`submerge-custom → AUTO`, `activeProof: false`, `mayRoute: true`, and uncertain
diagnostic attribution. No further spec findings or scope creep.

Final totals: Standards 0; Spec 1 P2, resolved. Independent follow-up: 0 unresolved
on both axes. Full raw static verification passed after the final source changes;
the 31-scenario browser gate remains valid because those changes affect server
diagnostic attribution only. Production and live engine acceptance remain unrun.

## PR #53 review corrections

Baseline: `3bdbedc94bd8c34774a5b12a5b10dc6ecbbc08ea`. Follow-up verified and ready
for the user-authorized publication to the existing PR.

- [x] Reproduce accepted-route attribution, disabled Default, missing Direct probe,
  and post-apply bookkeeping failures.
- [x] Correct confirmed findings and the no-node runbook guidance.
- [x] Raw static and focused browser verification; independent incremental review.
- [x] Independent final review; correction ready for authorized publication to PR #53.

The manual credential correction is separate (PR #54).

Seven added regressions failed against the original PR behavior (7 failed / 37
passed in `/tmp/submerge-pr53-review-red.log`) and passed after correction (44/44
in `/tmp/submerge-pr53-review-green.log`). The existing staged-activation and
rollback integration test also verifies that the real apply lifecycle exposes a
busy state before staging/reload and advances its revision after either outcome.

Raw `CI=true pnpm verify:static` passed: Biome, token drift, typecheck, 142 shared /
1366 server / 297 web tests and production builds; four opt-in server tests remain
skipped. Final log: `/tmp/submerge-pr53-review-static-final.log`. Existing Biome schema-version
information and Vite native-loader/chunk-size warnings remain unchanged.

Chromium passed 41 Routing/Default/Diagnostics scenarios with zero retries
(`/tmp/submerge-pr53-review-browser.log`). This repeats the 31 original routing
cases and adds diagnostic populated/empty/error/loading states, supported widths,
and failed Direct/unconfirmed Default at 390 and 1440 px. After correcting fixture
summary counts, both added cases passed again with zero retries
(`/tmp/submerge-pr53-review-browser-final.log`). Inspected dark screenshots at
1440×1024 and 390×1024: `/tmp/diagnostics-unconfirmed-dark-{1440,390}.png` and
`/tmp/submerge-default-route-1440-dark.png`. The reused controls and existing
diagnostic hierarchy remain intact; no UI implementation changed in this follow-up.

### Diagnostics incremental Standards review

Invoked the same `code-review` skill for the full correction against `3bdbedc`,
including all working files. Reviewer: `/root/incremental_standards`.

One P2: concurrent diagnostic callers shared the raw probe promise and the second
caller bypassed the revision check. The complete checked result is now shared.
No additional documented-standard violations or actionable smells were found.

### Diagnostics incremental Spec review

Reviewer: `/root/final_spec` (incremental pass for this correction).

Three P2 findings: the concurrent-result issue above; legacy `MATCH,PROXY` was not
recognized/resolved; Default's Always VPN precedence was treated as uncertain
only with a Direct catch-all. All three were corrected. Accepted targets now
include legacy PROXY and its actual selected leaf, including DIRECT. Provider
uncertainty applies independently of the catch-all choice.

Four added regression cases failed before these corrections (4 failed / 31
passed, `/tmp/submerge-pr53-incremental-red.log`). The focused diagnostics,
runtime and channel suites then passed 78 tests
(`/tmp/submerge-pr53-incremental-green.log`). Incremental totals: Standards 1 P2;
Spec 3 P2, all resolved. Both independent reviewers repeated their reproductions
and reported no remaining findings. Raw static then passed again with 142 shared /
1370 server / 297 web tests, four opt-in server tests skipped, and production
builds (`/tmp/submerge-pr53-incremental-static.log`). The browser gate remains
valid because the final corrections affect server attribution only. The
whole-feature final review follows below.

### Final Standards

Reviewer: `/root/final_standards`. No findings across the entire feature and all
working corrections. Migration snapshot, persistence, rollback, revision checks,
shared concurrent results and runtime recovery fit the documented boundaries.
Desktop/mobile screenshots retain the existing control metrics.

### Final Spec

Reviewer: `/root/pr53_final_spec`. No findings across the entire feature and all
working corrections: preserved defaults, explicit VPN precedence, empty pools,
Proxy/TUN configuration, rollback, pending/error UI, readiness, accepted-route
diagnostics and post-apply recovery. No scope creep found.

The final review uses the exact PR merge-base `330c3c5c9774434bd4cea018ac0f6d26e7ed2a80`
against the committed feature plus all working corrections. Final totals:
Standards 0; Spec 0. All incremental findings were independently rechecked as
resolved. Live engine/physical LAN/production acceptance for the feature and a
rendered Pencil comparison remain unperformed.

## Review 5708333779: lifecycle test assertions

Baseline: `add23e5ba48a84efe63a86be649bb134f84c93db`.
Record apply lifecycle observations inside callbacks and assert them after the
operation. Assert successful apply results explicitly and keep the failed-reload
rollback checks. Prove that an incorrect reload observation makes the corrected
test fail instead of being swallowed as the expected rejection.

- [x] Reproduce the false-positive test and verify the corrected assertion.
- [x] Raw static verification.
- [x] Independent incremental and final Standards/Spec review.
- [x] Prepare the correction for the authorized update to PR #53.

Fault injection in the original failing-reload mock replaced its busy-state
assertion with `expect(false).toBe(true)`; the old test still passed
(`/tmp/submerge-pr53-round2-false-positive.log`). The corrected test records reload
and staging observations, checks successful apply results, and asserts all
observations after rollback. Injecting a false failing-reload observation now
fails the outer assertion (`/tmp/submerge-pr53-round2-red.log`). The fault was
removed before verification; no production implementation changed.

Raw static passed: 142 shared / 1370 server / 297 web tests, four opt-in skipped,
and production builds (`/tmp/submerge-pr53-round2-static-final.log`). Initial
simultaneous full-suite runs on both worktrees timed out in two unrelated
5-second network-bootstrap subprocess tests each; serial reruns passed without
source or timeout changes. The existing 41-scenario browser evidence remains
valid because this correction only changes a test and its plan.

### Lifecycle assertions incremental Standards review

Reviewer `/root/incremental_standards`: no findings. Lifecycle callbacks record
observations and all checks run outside the application error-catching path.
No documented-standard violations or actionable smells.

### Lifecycle assertions incremental Spec review

Reviewer `/root/pr54_final_spec`: no findings. The requested assertion placement,
explicit successful results and existing rollback/rejection checks are preserved.
The fault-injection receipt demonstrates the corrected outer assertion fails.
No production behavior change or scope creep.

Incremental totals: Standards 0; Spec 0.

### Final review: bootstrap integration finding

Final Standards reviewer `/root/final_standards`: no findings. Final Spec
reviewer `/root/round2_final_spec`: one P1. The old bootstrap validator rejects
every `MATCH,DIRECT`, so prepared Proxy/TUN cannot restart with the saved Direct
default. Extend bootstrap validation to permit an explicitly selected terminal
Direct catch-all while preserving fail-closed VPN groups, accepted files and
existing TUN security requirements. Add real bootstrap subprocess regressions
for Proxy and TUN, including repeated startup, before publishing this correction.

Four real bootstrap subprocess cases (prepared Proxy/TUN, with/without an accepted
file) failed before the fix (`/tmp/submerge-pr53-bootstrap-red.log`). Bootstrap
now passes the saved Default route to validation: only an explicitly intended
terminal `MATCH,DIRECT` is allowed. Premature Direct matches, Direct members of
VPN groups, and an unintended Direct catch-all remain rejected. Accepted files
are retained and TUN administrator authentication remains required.

Focused bootstrap/channel/config suites passed 50 tests
(`/tmp/submerge-pr53-bootstrap-green.log`); each new restart case also checks the
explicit Docker/npm rules and REJECT-only empty VPN pool. Raw static passed:
142 shared / 1375 server / 297 web tests, four opt-in skipped, and production
builds (`/tmp/submerge-pr53-bootstrap-static.log`). No UI implementation changed;
prior browser evidence remains valid.

The final bootstrap also passed four isolated Docker runtime cases under Node
24.22.2 and uid 999, each invoking the actual compiled bootstrap CLI twice.
Server/shared/migration artifacts were mounted over the published runtime; no
network or TUN engine/device was used. Direct catch-all, accepted file and
REJECT-only explicit package pool survived both invocations. Artifacts: chat
scratch `default-bootstrap/{smoke.mjs,results.json,smoke.log}`. Container removed.

Incremental bootstrap review: Standards `/root/incremental_standards` 0 findings;
Spec `/root/pr54_final_spec` 0 findings. The intended terminal exception does not
weaken VPN-group restrictions or existing TUN administrator checks. Separate
whole-feature final recheck follows.

### Final recheck Standards

Reviewer `/root/final_standards`: no findings across the entire feature and final
working corrections. The saved domain type controls the terminal Direct exception,
VPN-group restrictions and TUN administrator checks remain intact, and accepted
and regenerated files use the same validator. Lifecycle observations are checked
outside swallowed callback errors. No actionable smells or rule violations.

### Final recheck Spec

Reviewer `/root/round2_final_spec`: no findings. The P1 is resolved. Independent
generator-to-validator reproductions accept the selected Direct default in
prepared Proxy and TUN, reject a VPN-default mismatch and Direct VPN-group fallback.
The reviewer independently ran all 10 bootstrap tests, including the four actual
subprocess startup/restart combinations. No remaining full-feature spec gap or
scope creep.

Final correction totals: Standards 0; Spec 1 P1, resolved and independently
rechecked, with 0 unresolved. Raw static and Docker bootstrap gates are green;
prior UI evidence remains valid. Engine/device, production and physical LAN
acceptance remain unperformed. The correction is ready for authorized publication.

## PR review 5708615219 and master merge

Master `fe3a5c290e127e7253cc8d9f587d7e5f2094cc54` includes merged PR #54.
Only the spec/plan indexes conflict; retain both feature entries. Preserve the
merged credential admission, Unicode transport and durable rotation behavior.

The remaining Major finding is a crash between route staging and accepted-file
replacement. The user requested architectural recovery for config application,
rather than a Default-only repair. Extend the common serialized apply lifecycle:
durable pending candidate, last accepted file, and bounded journal staged atomically
with DB mutations. Preserve desired settings across a crash, validate the accepted
file using journal proof, and resume through the existing coordinated apply owner.
Do not blindly replay stale managed-rule payloads or relax bootstrap safety.
Cover ordinary config changes as well as both Default directions, failed reload,
interrupted staging, accepted-file replacement, corrupt proof and credentials.
Use red/green tests, raw static, isolated Docker crash/restart evidence, incremental
and whole-feature reviews. UI code is unchanged; retain prior 41-case browser proof.

### Common apply recovery evidence

The original TUN bootstrap rejected Direct-to-VPN staging before file publication
(`/tmp/submerge-pr53-recovery-red.log`). A separate corrected outer assertion proved
that legacy Proxy replaced its accepted path before a failed reload
(`/tmp/submerge-pr53-recovery-apply-red.log`). The common pipeline now journals
every apply, stages mutations transactionally, stores a separate pending payload,
and sends it inline in all modes. Only verified reload/readiness publishes it;
pending proof bypasses byte-identical no-op optimization. Existing explicit
rollback restores file, settings and preceding journal in that order.

Journal tests cover atomic failed staging, accepted/candidate identity, repeated
recovery, prior-journal rollback, absent first file, unknown/missing files, path
mismatch, malformed proof and invalid UTF-8. Nine actual SIGKILL subprocess cases
cover legacy Proxy, prepared Proxy and TUN at committed staging, pending reload
and accepted-file replacement. Each retains desired settings, coordinates the
credential journal, preserves accepted files through offline preparation, then
performs a real apply attempt before clearing intent. Engine and interfaces are
deterministic fakes in these tests; they are not device acceptance.

Raw `pnpm verify:static` passed: 142 shared / 1449 server / 297 web tests, four
opt-in skipped, plus Biome, token drift, typecheck and production builds
(`/tmp/submerge-pr53-recovery-static.log`). One existing source test originally
used a different config path for every call on the same DB; it now reuses one
installation path so pending intent correctly remains bound to that installation.
Focused source/recovery suites passed 28 tests.

Six isolated Docker cases ran Node 24.22.2, uid 999, the compiled server/shared
artifacts over a pinned published runtime, and real Mihomo. Legacy and prepared
Proxy each receive SIGKILL after staging, after Mihomo accepts reload, and after
accepted-file replacement. The ordinary application entry point, existing boot
coordinator and real engine finish every pending operation. Prepared bootstrap
runs twice without promoting pending proof. Saved route, accepted file and active
engine agree after recovery. Artifacts: chat scratch
`config-recovery/{compose.yaml,runtime.mjs,smoke.py,results.json,smoke.log}`.
The network was isolated; temporary containers, networks and volumes were removed.
Real TUN/device, production and physical LAN acceptance remain unperformed.

### Common recovery incremental Standards review

Reviewer `/root/final_standards`: one P2 documented-standard finding.
CONTRIBUTING requires an ADR for a significant architectural decision. Added
[ADR-0007](../adr/0007-recoverable-config-apply.md), its index entry and an
architecture overview link, describing ownership, boundaries and tradeoffs.
No actionable heuristic smells. Independent resolution check follows.

### Common recovery incremental Spec review

Reviewer `/root/pr54_final_spec`: no findings. The common desired/pending/accepted
lifecycle matches the user's architectural request. Both proven file generations
remain pending until online confirmation; unknown proof fails explicitly. Existing
coordinated startup/first-connect/reconnect recovery is reused, and no separate
retry worker or stale managed-rule replay was added. The reviewer independently
ran all 20 journal/SIGKILL tests successfully.

Incremental totals: Standards 1 P2, addressed; Spec 0. Full-feature final review
and independent ADR resolution confirmation remain pending.

### Whole-feature review and migration correction

Standards reviewer `/root/final_standards` confirmed ADR-0007 resolves the P2,
then found no whole-feature Standards violations or actionable smells in tree
`bbd4b2923699f6f68ff5039334bc1e18d115bc02` against master `fe3a5c2`.
Spec reviewer `/root/round2_final_spec` found one P2: a proven interrupted legacy
Proxy apply prevents the supported prepared-install migration because the pending
guard rejects the old DNS/config shape. The reviewer reproduced it with the real
bootstrap CLI; the remainder of the whole feature had no Spec findings.

Three added legacy-to-prepared SIGKILL cases failed before correction
(`/tmp/submerge-pr53-recovery-migration-red.log`). Bootstrap now permits only the
proven pre-native Proxy migration. It atomically rebases the current primary hash
(which may already be the previous candidate) and records the replacement before
offline publication. It retains desired settings, credential recovery and pending
activation. A fault between proof rebasing and file publication leaves the old
primary recognizable; the test injects a blocked temp path, checks proof and
retries successfully. A separate CLI regression rejects unsafe native Proxy bytes
even when their hash is journal-proven; TUN restrictions remain intact.

Final raw static passed: 142 shared / 1453 server / 297 web tests, four opt-in
skipped, plus all static checks and production builds
(`/tmp/submerge-pr53-recovery-static-final.log`). There are now 12 actual SIGKILL
cases and the journal/native safety regressions. Additional real-engine migration
Docker qualification and independent incremental/final rechecks follow.

The three additional real-Mihomo Docker legacy-to-prepared migration cases passed
at the same interruption boundaries. Valid legacy preference fixtures avoid public
geodata downloads on the isolated network. Offline preparation migrates the file
twice while retaining pending activation, then ordinary application startup applies
and confirms the desired route. Node 24.22.2, uid 999; compiled artifact overlay as
above. Artifacts `config-recovery/{results-migration.json,smoke-migration.log}`.
All temporary containers, networks and volumes were removed. Total real-engine
recovery cases: nine. No source changed after the final static run.

Migration incremental Standards `/root/final_standards`: no findings; boundary
validation and transactional proof rebasing meet documented standards. Incremental
Spec `/root/pr54_final_spec`: no findings; only proven pre-native Proxy migrates,
pending intent and credential recovery survive, and failed publication retains
recognizable proof. The Spec reviewer independently ran all three migration
SIGKILL cases, including the blocked publication regression. Migration incremental
totals: Standards 0; Spec 0. Whole-feature final rechecks follow.

### Managed-provider integration correction

Final Spec `/root/round2_final_spec` confirmed the migration P2 resolved and found
no remaining whole-feature Spec gaps; independently ran all 13 bootstrap tests.
Final Standards `/root/final_standards` found one P1 against ADR-0006: rebuilding
an accepted legacy managed config without its provider drops the forced VPN rule
while retaining a Direct default. The reviewer reproduced that exact CLI output.

Four new CLI regressions failed before correction
(`/tmp/submerge-pr53-recovery-managed-red.log`). Offline preparation now validates
the accepted canonical managed provider and retains it at REJECT in the normal
generator rule position, before custom Direct matchers. Only prepared generation
permits this reserved rejection target without an available VPN pool. Missing or
unsafe provider definitions fail explicitly. The online coordinated owner remains
responsible for attesting the store and restoring its current VPN target; offline
preparation cannot claim activation. Tests include an empty desired VPN pool,
overlapping custom Direct matcher, repeated bootstrap and invalid definitions.
All four pass (`/tmp/submerge-pr53-recovery-managed-green.log`).

Raw static passed again: 142 shared / 1457 server / 297 web tests, four opt-in
skipped, all static checks and production builds
(`/tmp/submerge-pr53-recovery-static-managed.log`). Focused real-Mihomo guard
qualification and independent incremental/final rechecks follow.

Incremental Standards `/root/final_standards` independently passed all 17 bootstrap
tests and confirmed provider retention/priority resolves the original P1. Spec
`/root/pr54_final_spec` found one further P1: a provider declaration alone does not
prove its backing file is usable; Mihomo can log initialization failure and keep
running with no matching rules. The reviewer cited the engine initialization path.

Bootstrap now uses the existing local-store file safety checks and SQLite history
authority before loading any accepted managed provider. It accepts only the
confirmed digest or a known unfinished operation's intended digest. Missing,
invalid, unattested, unknown-digest or reconciliation-blocked state fails before
file publication; offline inspection never advances the store marker or completes
a domain-rule operation. The read-only helper lives beside the existing production
store history, rather than creating a second attestation scheme. The bootstrap
composition accepts a rule directory argument for isolated subprocess fixtures;
the shipped CLI always uses the canonical `/domain-rules` mount.

Backing-store regressions cover all rejection cases and a recoverable unfinished
store operation without marker promotion. Four rejection assertions failed before
the fix (`/tmp/submerge-pr53-recovery-store-red.log`); the terminal-operation test
fixture was corrected to satisfy its existing completed-at constraint. Full raw
static is green: 142 shared / 1463 server / 297 web tests, four opt-in skipped,
all static checks and builds (`/tmp/submerge-pr53-recovery-static-store.log`).
Independent rechecks and final real-engine backing-store proof follow.

Backing-store incremental Standards `/root/final_standards`: no findings,
independently passed all 23 bootstrap tests. Spec `/root/pr54_final_spec`: prior P1
resolved, no new findings; independently passed all 10 managed bootstrap cases,
including recoverable operation intent without marker promotion.

The real canonical-mount Docker probe passed under Node 24.22.2 and uid 999:
missing and digest-mismatched store files reject preparation without changing the
accepted file or config journal. After restoring the attested file, repeated
offline migration retains pending activation; real Mihomo loads the one-rule
canonical provider at REJECT before the overlapping custom Direct matcher, while
the final catch-all remains Direct and the desired VPN pool is empty. Artifacts:
`config-recovery/{results-managed.json,smoke-store.log,smoke-managed.py}`.
Temporary runtime resources were removed. No production or physical LAN claim.
Final whole-feature rechecks and a repeat of all nine runtime recovery cases on
the final compiled source follow.

The final-source Docker repeat passed all nine recovery cases: legacy Proxy,
prepared Proxy and legacy-to-prepared migration, each killed after staging,
engine reload and accepted-file replacement. Ordinary application startup restored
agreement between desired settings, accepted file and real engine rules, then
cleared pending proof. Node 24.22.2, uid 999; no source changed after the 1463-test
static run. Artifacts `config-recovery/{results-final.json,smoke-final.log}`.
All temporary containers, networks and volumes were removed.

### Final whole-feature review after recovery corrections

Reviewed final source tree `b2bbcfd3b3b1b770a1587a209acf3a10b1fcedc4` against
master `fe3a5c290e127e7253cc8d9f587d7e5f2094cc54`. Subsequent changes only append
the factual runtime/review receipts in this plan; production source is unchanged.

#### Common recovery final Standards review

`/root/final_standards`: no findings. The wide pass covered routing, rollback,
common recovery, managed-store protection, credential integration, diagnostics
and readiness, UI, tests, migration snapshot and documentation. No unresolved
documented-standard violations or actionable smell findings. The reviewer also
checked the subsequent Docker receipt and independently passed all 23 bootstrap
tests during the final correction.

#### Common recovery final Spec review

`/root/round2_final_spec`: no unresolved findings. The wide pass covered Default
routing, empty VPN pools, common crash recovery, proof rebasing, explicit rollback,
merged credential behavior, accepted-route diagnostics and coordinated recovery.
Managed-provider preservation and backing-store authority match the specification;
offline inspection neither promotes the marker nor completes an operation. The
reviewer independently passed all 23 final bootstrap tests. No missing requirement,
incorrect behavior or scope creep identified.

Final totals: Standards 0 unresolved; Spec 0 unresolved. Earlier findings about
the missing architecture decision, legacy migration, lost managed provider and
unverified backing file were corrected and independently rechecked before this
wide pass. Static and local runtime gates are green; real TUN-device, production
and physical LAN acceptance remain unperformed. Publication targets PR #53 only.

### Review follow-up: unconfirmed engine rollback

The latest CodeRabbit review on `1659422` reports an unconfirmed rollback gap:
after a candidate reload loses its response and restoring the prior payload also
fails, legacy Proxy clears the apply journal. A later ordinary apply can then skip
reload because the restored file matches the desired settings, although the engine
may still run the candidate. CI and both Docker builds on `1659422` passed.

Retain a new pending apply bound to the restored file when the restore reload
fails, after atomically undoing the staged mutation. Keep successful rollback's
existing journal restoration. Regressions will model an accepted candidate with a
lost response, both restore outcomes, both Default routes and a non-forced retry.
Run static verification, incremental and final independent review before commit
and push to the existing PR. UI implementation and visual evidence are unchanged.

Red: both failed-restore route cases lost their pending journal on the old code;
both successful-restore controls passed (`/tmp/submerge-pr53-restore-red.log`).
The minimal correction tracks restore failure and transactionally rebases pending
proof to the restored file after undoing the mutation. All 107 focused lifecycle,
journal, crash-recovery and channel tests pass
(`/tmp/submerge-pr53-restore-focused.log`). The four added cases also prove a
non-forced retry restores the active engine model and clears pending proof, while
successful rollback retains the confirmed no-op optimization.

Raw `pnpm verify:static` passes: 142 shared / 1467 server / 297 web tests,
four opt-in server tests skipped, plus Biome, token drift, typecheck and production
builds (`/tmp/submerge-pr53-restore-static.log`). Independent incremental/final
review and a focused real-engine rollback probe follow.

The real-Mihomo Docker rollback probe passed both directions under Node 24.22.2,
uid 999. The candidate actually reaches the engine before its response is lost;
the restore request is then blocked. The probe verifies the restored DB/file,
still-candidate engine rules and pending proof before an ordinary non-forced retry
reloads the restored route and clears the journal. A subsequent no-op skips reload.
Compiled artifacts overlay the same pinned runtime/engine images as above, on an
isolated internal network. Artifacts:
`config-recovery/{results-rollback.json,smoke-rollback.log,smoke-rollback.py}`.
Temporary containers, networks and volumes are removed by the harness.

Incremental `/code-review` on `1659422` to source tree
`a5ca5cbadaaea83b41c9087214c8e3326619c013`:

#### Rollback incremental Standards review

`/root/final_standards`: no findings; no documented-standard violations or
actionable smells. Atomic mutation rollback and file-bound pending proof preserve
the common lifecycle. Independently passed all four new cases.

#### Rollback incremental Spec review

`/root/pr54_final_spec`: no findings; unconfirmed rollback gap resolved. Ordinary
retry now verifies identical restored bytes, successful restore keeps prior
journal behavior, and current desired settings/credential recovery remain the
retry authority. Independently passed all four new cases.

Incremental totals: Standards 0; Spec 0. Whole-feature final rechecks follow.
Remote master advanced through PR #55, touching only the Postman preset domain
list; no overlap with this correction. Its merge base remains `fe3a5c2`.

Final whole-feature `/code-review` against `fe3a5c2`, pinned tree
`7554cf59b0b4ffd042392353e5eba780973ec9b8`:

#### Rollback final Standards review

`/root/final_standards`: zero unresolved documented violations and actionable
smells. Reviewed persistence, API/UI behavior, generated routing, rollback and
restart recovery, managed-store protection, credentials, diagnostics/readiness,
tests and documentation. The correction fits the existing recovery owner.

#### Rollback final Spec review

`/root/pr54_final_spec`: zero unresolved findings across the complete feature.
Default routing and explicit VPN priority, accepted-engine diagnostics, pending
UI, common recovery, managed-provider safety and credential integration match the
specification. Independently passed 83 focused routing, diagnostics, readiness and
router tests in this wide pass, in addition to the four incremental regressions.

Final totals: Standards 0; Spec 0. Source remains unchanged since the full static
and real-engine rollback runs. Only these review receipts follow the pinned tree.
UI rendering is unchanged; prior browser evidence remains applicable. Production,
physical LAN and real TUN-device acceptance remain unperformed.

Review `5710153057` reports no new functional finding on `d8f9d08`; the engine
rollback comment is resolved by CodeRabbit. GitHub CI, including browser E2E,
both Docker builds and secret scanning passed on that commit. Its remaining
unverified Markdown comment identifies repeated review headings. Scope each
repeated heading by the review round without changing any recorded result or
production source; verify that headings are unique throughout this plan.

The duplicate-heading check passes with 33 unique headings. Full raw static also
passes again with 142 shared / 1467 server / 297 web tests, four opt-in skips and
all builds (`/tmp/submerge-pr53-headings-static.log`). This follow-up changes only
this plan; production code, tests and UI are identical to `d8f9d08`.

Documentation incremental and final integration reviews on tree `9491c6e`:
Standards `/root/final_standards` and Spec `/root/pr54_final_spec` both report zero
findings at both scales. Each independently confirmed unchanged application/test/UI
source and preserved evidence. All GitHub checks, including CodeRabbit, passed on
`d8f9d08`; this follow-up only changes plan headings and these factual receipts.

### CI follow-up: routing order before channel loading

CI on `6c08eda` passed 186 browser cases but the Direct/Default ordering case read
an empty channel-header list (`indexOf` returned -1 for both names). The existing
absence assertion succeeds during loading and `evaluateAll` does not await data.
The failed run uploaded no workflow artifacts, so its local trace is unavailable.
Reproduce with a deliberately delayed channel-list response, then await the full
expected accessible-label sequence before checking that Direct has no move
control. Keep the same channel order and zero test retries. No application or
routing behavior changes; run static, focused/full browser and independent review
gates before updating the existing PR.

The unchanged ordering assertions fail with the exact CI `-1 < -1` error when
the channel-list fixture response is delayed by 500 ms. The saved failure
screenshot shows loading skeletons; its later error-context snapshot already
contains the loaded cards. This confirms a test synchronization gap. Artifacts:
`routing-order-ci/{red.log,red/test-failed-1.png,red/error-context.md,red/trace.zip}`
in chat scratch, plus `/tmp/submerge-pr53-routing-order-red.log`.

Keep that deliberate fixture latency as a regression condition. The assertion now
polls the exact ordered labels of the three primary expand controls, distinguished
by their `aria-expanded` state from the separate chevron buttons. Check the absent
Direct move control only after the cards are present. The same delayed case
passes with zero retries (`/tmp/submerge-pr53-routing-order-delayed-green.log`).
The installed Playwright 1.64.1 role types confirm the `expanded` filter.

Raw static passes: 142 shared / 1467 server / 297 web tests, four opt-in server
skips, Biome, token drift, typecheck and production builds
(`/tmp/submerge-pr53-routing-order-static.log`). The complete 187-case Chromium
suite runs with one worker and zero retries before independent review.

The first complete local run passed the corrected routing case and 185 other
cases, but exposed a pre-existing drawer geometry race in
`domain-intelligence-layout.spec.ts`: the bottom was sampled at 844.290466 px
instead of the final 844 px while entry animation was still settling. That test
and all application source are unchanged from `6c08eda`, and it runs before the
modified routing test. Artifacts `routing-order-ci/{full-initial.log,drawer-red/}`.

Keep the drawer's exact 844 px assertion and all animation/swipe checks, but poll
the final bottom edge before capturing geometry for the drag. Do not relax pixel
tolerance or increase test retries. This is a second E2E synchronization fix;
application behavior remains unchanged. Repeat focused browser checks and the
complete local suite after this correction.

Both focused cases pass with one worker and zero retries
(`/tmp/submerge-pr53-routing-order-focused.log`). Raw static passes again after
the drawer correction, with the same 142 shared / 1467 server / 297 web tests,
four opt-in skips and all builds
(`/tmp/submerge-pr53-routing-order-static-final.log`). Incremental independent
review and the final complete browser run follow. Only the two E2E files and this
plan differ from `6c08eda`; production code, styles and dependency versions do not.

#### CI synchronization incremental Standards review

`/root/final_standards`: no documented-standard violations or actionable smells
in `6c08eda` to tree `11fe39c`. Exact order/geometry assertions and zero test
retries remain intact; no production code changed. No concurrent browser process
was started by the reviewer.

#### CI synchronization incremental Spec review

`/root/pr54_final_spec`: no findings. The loaded order is checked before absence,
primary headers exclude duplicate chevrons, and settled drawer geometry retains
the exact 844 px requirement and entry/swipe checks. No weakened assertions,
missing requirement or scope creep. No concurrent browser tests were launched.

Incremental totals: Standards 0; Spec 0. Whole-feature final integration review
and the complete browser run follow before publication.

#### CI synchronization final Standards review

`/root/final_standards`: zero unresolved documented-standard violations or
actionable smells on full feature tree `77e047e` against `fe3a5c2`. Production,
UI, shared fixtures, migrations and other tests match the previously reviewed
feature. Both synchronization changes retain exact assertions. No concurrent
browser run was launched by the reviewer.

#### CI synchronization final Spec review

`/root/pr54_final_spec`: zero unresolved findings across the complete feature.
The routing/recovery/rollback/managed-store/credential/diagnostic/UI contracts
remain unchanged. The new waits preserve exact ordering, geometry and animation
checks. The review did not mark the then-pending full browser gate complete.

The final full local run completed with 186 passing cases and one independent
network failure in unchanged `priority-node-pool.spec.ts` at 984 px. Both modified
cases passed. Keyboard/geometry assertions in the failing case passed; its final
console-error check caught a Google Fonts CSS request ending in
`net::ERR_CONNECTION_CLOSED`. The trace console and HAR identify the external
`fonts.googleapis.com` URL. The same unchanged case passed in the first full run
and a separate zero-retry check after the error
(`/tmp/submerge-pr53-priority-network-check.log`). No errors were filtered out.
Artifacts: `routing-order-ci/{full-final.log,priority-network/}`. Required raw
static and focused browser checks are green; the broad full run is not claimed
green. New-head GitHub CI remains a separate verification step after publication.

Both final reviewers inspected the network-failure trace and retained zero
change-related findings. Standards confirms no change-related blocker; Spec
retains its conclusion without marking the broad browser result green or waiving
verification. The unchanged priority case's separate zero-retry check passed.
No production change, console-error filtering or font substitution was introduced.
Publication is to the PR branch only; remote CI must still be checked on the new
head, and merging/deployment remain separate.
