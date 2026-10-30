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

### Standards

Reviewer: `/root/final_standards`. No findings on the complete feature or final
delta. The routing-uncertainty getter preserves the existing activation-proof
contract; both registration callbacks are cleaned up together. No unresolved
standards violations or actionable smells.

### Spec

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

### Incremental Standards

Invoked the same `code-review` skill for the full correction against `3bdbedc`,
including all working files. Reviewer: `/root/incremental_standards`.

One P2: concurrent diagnostic callers shared the raw probe promise and the second
caller bypassed the revision check. The complete checked result is now shared.
No additional documented-standard violations or actionable smells were found.

### Incremental Spec

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
