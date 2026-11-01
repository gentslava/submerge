# Engine network activation correction

Status: implemented and verified locally; PR #56 open, not merged or deployed.

Spec: [Engine network activation checks](../specs/2026-11-01-network-activation-design.md).
Baseline: master `9c59907ff1afba5ea0bdcb69d4d00df2ae322403`.
Worktree: `/private/tmp/submerge-network-activation-20261101`; original checkout
remains on the user's branch, untouched.

## Diagnosis and scope

The user reports every routing edit returning the generic network activation
error and mode switches returning the generic TUN error. Refresh displays saved
settings. Source confirms channel mutations save before apply; this display is
not evidence of live engine rules. A reload can succeed before network validation
fails and rollback is attempted. Existing pending proof remains authoritative.

Local Docker reproduced a concrete false failure with two separate containers:
runtime mode rule, IPv6 false, TUN false; Mihomo DNS returns `198.19.0.4` on UDP and
TCP, but the activation check probes the app's localhost and returns
`recvmsg ECONNREFUSED`. The first scratch YAML fixture incorrectly used an unquoted
comma rule and was corrected before this receipt. No production query was made.
Artifacts live under chat scratch `network-activation/`.

Fix the endpoint and namespace assumptions in the common checks; retain TUN and
DNS safety requirements, expose a fixed specific reason and saved/unconfirmed
state. The user was told the approach before code edits. The exact production
failure has not been established and must remain qualified.

## Validation and review gates

- [x] Red regressions for remote DNS, separate Proxy interfaces and safe reasons.
- [x] Focused unit tests and raw `verify:static`.
- [x] Real-Mihomo separate-container activation and config apply.
- [x] Incremental independent Standards/Spec review.
- [x] Final independent whole-change Standards/Spec review.
- [x] Record environment limitations and final local artifacts.

No UI layout code changed. Error text is tested at the service boundary and in
the browser. No dependency or routing-rule edits.

The lockfile equals the existing checkout's. Offline pnpm package-manager mirrors
were unavailable, so validation reuses its installed dependency graph via local
symlinks, with workspace package links redirected to this isolated checkout.

## Receipts

- Red: 4 regressions failed for the missing engine DNS target, wrong Proxy
  interface namespace and exposed UDP/TCP error text. Two additional service
  regressions failed for missing saved/unconfirmed state and hidden DNS reason.
- Green: 47 focused tests. Raw `verify:static` passed: Biome, token drift,
  typecheck, 142 shared / 1475 server / 297 web tests and production builds.
  Existing 4 server integration tests remain skipped. The final browser-only
  test addition also passed raw Biome. pnpm's automatic dependency installation
  was disabled with `pnpm_config_verify_deps_before_run=false` to preserve the
  reused dependency graph; no verification stage was skipped.
- Docker: separate containers, no published host port, internal network, pinned
  Mihomo and published Submerge runtime with the locally compiled server/shared
  overlaid. Identical DNS probes returned fake-IP on both transports before and
  after the correction; only the corrected activation check passed.
- Actual apply: create a fixture VPN channel over a Direct default; confirm its
  first rule through `/rules`. A controller-only local TCP bridge then creates
  a real unreachable DNS listener. The rejected apply retains desired DB edits,
  old accepted bytes and pending journal; `/rules` confirms the previous live
  rule. Close/reopen SQLite, restore the reachable endpoint and retry: verified
  apply, new live rule, applied state and cleared journal. No insurance endpoint
  or other production target was queried.
- Browser: `tun-settings.spec.ts`, zero retries, widths
  320/390/425/768/983/985/1024/1440 in both themes; new long-error cases at
  320 and 1440 dark. Screenshot author inspection: readable wrapping, retained
  Proxy selection, no clipping or document/main/page overflow. Frame references
  `oXxu8` and `Q3sToj`; the existing segmented control still measures 260 px,
  label 15 px, buttons 13 px. Initial sandboxed Chromium launch was denied by
  macOS; rerun outside that sandbox completed normally.

Scratch artifacts: chat scratch `network-activation/` contains the isolated
Compose fixture, DNS/apply probes, logs and screenshots. Physical TUN activation
and the user's deployed instance are not qualified by this Proxy reproduction.

## Incremental review

Applied the independent two-axis `code-review` skill to base `9c59907` and staged
tree `682b6be`. Standards reviewer: `network_incremental_standards`; Spec
reviewer: `network_incremental_spec`.

- Standards: no documented-standard breaches or actionable baseline smells; one
  P2 endpoint defect for a local IPv6 controller with IPv4 DNS.
- Spec: one P1 UDP lookup failure crashing the process (newly exposed by passing
  controller names), and the same P2 IPv6 endpoint defect.
- Corrections: preserve configured IPv4 loopback for known-local controllers;
  remap wildcard/loopback only for remote controllers. Guard the UDP connect
  callback on error or already-settled probes. Both had red regressions before
  fixes; all 46 focused tests now pass. Pinned Docker Node 24.22.2 additionally
  confirms IPv6-controller/IPv4-DNS success and failed controller lookup rejection
  without a process crash. The full real-engine apply/recovery scenario passes
  again after these corrections. Both reviewers independently reran the client
  suite and cleared all findings on tree `50b7fae`; the complete static gate also
  passed again before the final whole-change review below.

## Final review

Reviewed the whole base-to-tree `96d241f` diff independently with
`network_final_standards` and `network_final_spec`.

- Spec: no actionable findings; reviewer independently reran all 46 focused
  tests from that tree.
- Standards: two P2 correctness findings. Remote DNS could be combined with an
  unrelated app-local TUN; IPv4-mapped loopback controllers were misclassified
  as remote. No further standard breaches or actionable smells.
- Both counterexamples failed regression tests before correction. TUN now rejects
  unproven controller topology in activation and marks the TUN health check false;
  this establishes a limitation of Submerge's local proof, not a remote TUN fault.
  Known-local IPv4-mapped controllers retain IPv4 DNS like ordinary loopback.
  Recovery child fixtures now explicitly identify their simulated shared namespace
  with a local controller address. No journal or recovery semantics were relaxed.
- All 47 focused tests pass. The mapped-loopback correction was also checked in
  the pinned Docker Node 24.22.2 runtime. The full raw static gate passed again
  (142 shared / 1475 server / 297 web). Both final reviewers independently reran
  all 47 focused tests and cleared tree `ce3a65f`: Standards 0 remaining findings;
  Spec 0 remaining findings. No code changed after those cleared reviews.

Temporary Docker containers and network were removed. The original checkout
remains clean. The local work is staged in the isolated worktree; a complete
patch and final logs are retained in chat scratch `network-activation/`.

## Publication preparation

The user asked to proceed after the local qualification and conceptual explanation.
The README now explains Proxy/TUN capture, the selective Docker/npm example,
Docker namespace/device/permission requirements and saved-versus-active settings,
with a link to the existing operation runbook. No host or production changes are
part of this PR. The fetched master remains `9c59907`; no rebase is needed.

The publication addendum was reviewed independently on tree `bbc04ba` by
`network_final_standards` and `network_final_spec`: both cleared, zero findings.
Source code is unchanged from the earlier cleared tree. Raw `verify:static`
passed again before publication (142 shared / 1475 server / 297 web tests and
all static/build stages). Only this receipt and status metadata changed afterward.

## PR 56 follow-up: reported TUN state and mapped controller hosts

The user reported that the combined TUN/Proxy mismatch message remained unclear.
The activation error now states what Mihomo reported after the candidate reload:
TUN disabled when enabling, still enabled when disabling, or state not reported.
The third case never claims a known state, and none invents a device/permission
root cause. Mode-switch errors preserve that distinction and retain their
previous saved mode. Past tense describes the observed candidate response even
when subsequent recovery changes the engine again.

Also verified CodeRabbit comment `discussion_r4434402866`: a remote IPv4-mapped
controller host reached the IPv4-only DNS probe as bracketed IPv6. Normalize its
canonical mapped address to IPv4, reusing the same host for locality and DNS.
Ordinary hosts and explicit listener addresses retain their behavior.

- Red: 9 failing regressions for the four readiness states, four outward mode
  errors and a real remote mapped-host DNS probe.
- Green: 43 focused tests; full raw static gate passed with 142 shared / 1483
  server / 297 web tests plus Biome, token drift, typecheck and production builds.
  Four existing opt-in server integration cases remain skipped.
- Browser: all 14 connection-settings cases passed with zero retries at the
  existing 320/390/425/768/983/985/1024/1440 widths. The actual disabled-TUN message
  is exercised at 390 dark, including pending state, retained Proxy selection,
  readable wrapping, no overflow and successful keyboard retry. Author inspected
  `/tmp/submerge-mode-state-error-390-dark.png`; no layout code changed. Existing
  frame references `oXxu8` and `Q3sToj` remain the contract.
- Incremental review on tree `1fa0320`: `network_final_standards` and
  `network_incremental_spec` independently cleared the slice, zero findings.
  Standards also reran all 43 focused tests successfully.
- Pinned Docker Node 24.22.2: actual separate-container Mihomo API and UDP/TCP
  DNS succeed through an IPv4-mapped controller URL. The activation assertion
  against this known TUN-disabled engine returns the new disabled-state message.
  No physical TUN activation was attempted by this additional probe.
- Final whole-change review on tree `7b09aeb`: `network_final_standards` and
  `network_final_spec` independently cleared the full feature, zero findings.
  Source code is unchanged after those final reviews; only this receipt changed.

The user-linked review `5726459288` contains exactly the mapped-controller
comment above. Its actual API review/comments were checked before publication.

No production request or deployment was made; these messages identify the failed
observation and do not establish the user's underlying TUN failure cause.
