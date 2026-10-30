# Manual Mihomo credential correction

Status: implemented and verified locally; not merged or deployed.

Spec: [Manual Mihomo credentials](../specs/2026-10-30-manual-mihomo-secret.md).
Baseline: `7a92a3a7b764162c0fa04dea5f2e2c20c07722fc` on `codex/manual-mihomo-secret`.
This correction is separate from Default Direct PR #53.

- [x] Red: short manual bootstrap, startup, pending rotation and config activation.
- [x] Accept nonempty manual credentials; generate only when missing, including application startup.
- [x] Verify focused regressions, raw `pnpm verify:static` and applicable browser evidence.
- [x] Incremental independent `/code-review`, Standards and Spec; resolve findings.
- [x] Final independent `/code-review`, Standards and Spec; resolve findings.
- [x] Record evidence and limits. Commit/push only on user request.

No control or visual change is planned. Existing Settings secret entry and error
handling must remain usable. Full runtime/source evidence is recorded here as it
is gathered.

## Evidence

- Initial regressions: 12 failed / 35 passed across bootstrap, startup, settings,
  rotation and apply. Receipt: `/tmp/submerge-manual-secret-red.log`.
- The final raw `pnpm verify:static` passed: Biome, token drift, typecheck,
  142 shared / 1354 server / 297 web tests and production builds. Four opt-in
  server tests remain skipped. Existing Biome schema and Vite warnings remain.
  Receipt: `/tmp/submerge-manual-secret-static-final.log`.
- Dependencies were synchronized to the existing frozen master lockfile after
  switching from the old feature base. No manifest or lockfile changes were made.
- Browser: 14 scenarios, zero retries. Short-key save/reload at 390 and 1440 px;
  existing Proxy/TUN, DNS, file-editor, failure/retry, both-theme and responsive
  scenarios from 320 to 1440 px. Receipt: `/tmp/submerge-manual-secret-browser.log`.
  Screenshots: `/tmp/submerge-manual-secret-{390,1440}-dark.png`. No UI source
  or control geometry changed; no new Pencil frame was required.
- Linux/arm64 Docker runtime: 3/3 scenarios under uid 999, no network-bootstrap
  auth init: explicit `abc`, generated 64-character key, and a historical pending
  blank reset with the engine still accepting the old key. All start, authenticate,
  keep the key after restart, and end with the engine rejecting unauthenticated
  requests. The historical reset remains pending until the engine restarts and
  then promotes successfully. This uses the published runtime image with the
  locally built `dist` mounted over it, not a newly packaged release image.
  Artifact: chat scratch `manual-secret-runtime/results.json` and `smoke-final.log`.
  All test containers/networks/volumes were removed. No production was accessed.

## Incremental code-review

Invoked the installed skill at
`/Users/gentslava/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.3.1/skills/engineering/code-review/SKILL.md`.
The task-start HEAD pins the baseline; the working diff and all new files were
reviewed because commits were not requested.

### Standards

Reviewer `/root/incremental_standards`: no findings. Existing client boundaries,
validation and journal are retained; no new abstraction or control was added.

### Spec

Reviewer `/root/incremental_spec`: one P2, resolved. A valid historical pending
blank reset must not block startup. Normalize the blank stored/effective value
inside an immediate SQLite transaction, retain the previous authentication key,
and generate only when no captured effective key exists. Regression receipt:
`/tmp/submerge-manual-secret-legacy-red.log` (3 failures before the fix).

## Final code-review

### Standards

Reviewer `/root/final_standards`: no findings on the full change or final delta.
Atomic normalization and its tests preserve the established recovery contract.

### Spec

Reviewer `/root/final_spec`: one P2, resolved. A captured nonempty legacy key with
blank `nextStored` must be persisted before confirmation clears the journal;
otherwise later environment edits silently replace it. Red receipt:
`/tmp/submerge-manual-secret-captured-red.log`. Independent follow-up reproduced
both historical forms: captured `abc` stays confirmed across environment edits,
and an empty effective key generates one stable random key, both retaining the
previous recovery credential. No further gaps or scope creep.

Final totals: Standards 0; Spec 1 P2 resolved. Follow-up: 0 unresolved on both axes.
Static verification passed after the last behavior change. Later edits record
evidence and clarify the existing controller-restart requirement only.

## PR #54 review correction

Baseline: `44a72988c75c8a968e8d08dd1d39c84cf5bc92f2`. Review:
https://github.com/gentslava/submerge/pull/54#discussion_r4420570480.

Node Headers accepts byte strings, so passing Unicode credentials directly can
throw before a controller request. Preserve UTF-8 octets through a Latin-1 header
string. The engine compares the token bytes directly with its configured secret;
it does not decode URL/base64 encodings. Source checked at
https://github.com/MetaCubeX/mihomo/blob/v1.19.33/hub/route/server.go#L311-L339.
Header construction failure must permit the existing previous-key fallback,
without retrying network failures or falsely confirming the primary key.

- [x] Reproduce Unicode and header-construction fallback failures.
- [x] Correct client transport and verify focused/static/Docker gates.
- [x] Independent incremental and whole-feature final code-review.
- [x] Prepare the reviewed correction for user-authorized publication to PR #54.

Red: five added regression cases failed before the transport correction
(`/tmp/submerge-pr54-review-red.log`), including Latin-1 characters whose original
header bytes did not match the UTF-8 configuration. Green: the focused client and
rotation selection passed 141 tests (`/tmp/submerge-pr54-review-green.log`).
Network failure is not retried; an invalid primary header uses the previous key
without promoting the invalid primary.

Raw `CI=true pnpm verify:static` passed after the correction: Biome, tokens,
typecheck, 142 shared / 1360 server / 297 web tests and production builds; four
opt-in server tests remain skipped (`/tmp/submerge-pr54-review-static.log`). The
prior 14-scenario browser gate remains valid because the follow-up only changes
the server controller client and adds no UI behavior or control.

Linux/arm64 Docker runtime verification passed all four manually configured
keys: CJK, Cyrillic, emoji and Latin-1 text. The actual compiled controller client
and candidate probe authenticated against Mihomo v1.19.33, including after app and
engine restart under uid 999. Credentials stayed unchanged; wrong and missing
credentials returned 401 after engine restart. An unconstructible primary header
successfully used the previous credential without promotion. As above, the test
uses a published runtime image with locally built server dist mounted over it;
it is not packaged release acceptance. Initial controller authentication before
the first engine restart has the already documented legacy behavior.

Artifacts: chat scratch `manual-secret-unicode/{compose.yaml,smoke.py,smoke.log,results.json}`.
All temporary containers, networks and volumes were removed. No production access.

### Incremental Standards

Reviewer `/root/incremental_standards`: no findings on the four-file correction
or its subsequent transport-validation delta. No documented-standard violations
or actionable smells. Authentication transport stays within the existing client;
network errors remain outside the previous-key fallback path.

### Incremental Spec

Reviewer `/root/final_spec`: one P2, resolved. Headers construction accepts some
C0/DEL bytes that the HTTP transport rejects before sending a request. Preflight
the encoded Authorization using `node:http`'s `validateHeaderValue`, so recovery
uses the previous key before dispatch without retrying generic network failures.

Two added cases reproduced this error before correction (2 failed / 105 passed,
`/tmp/submerge-pr54-control-red.log`); focused client/rotation tests then passed
144 cases (`/tmp/submerge-pr54-control-green.log`). The independent loopback
recheck confirmed exact UTF-8 bytes for all four key examples, LF/C0/NUL/DEL
recovery through a Unicode previous key without primary promotion, and exactly
one controller mutation request on a connection failure. No remaining findings.

Incremental totals: Standards 0; Spec 1 P2 resolved. Raw static passed again:
142 shared / 1363 server / 297 web tests, four opt-in skipped, and production
builds (`/tmp/submerge-pr54-review-static-final.log`).

Final Docker rerun passed all four keys with the final compiled client and all
LF/C0/NUL/DEL recovery variants. Final receipt:
`manual-secret-unicode/smoke-final.log` and `results.json`; cleanup completed.

### Final Standards

Reviewer `/root/final_standards`: no findings on the entire feature from
`7a92a3a7b764162c0fa04dea5f2e2c20c07722fc`, including all working corrections.
Unicode transport is shared by normal requests and candidate probes; locally
invalid-header recovery stays separate from network failures and cannot promote
the primary key. No documented-standard violations or actionable smells.

### Final Spec

Reviewer `/root/pr54_final_spec`: no unresolved findings across startup,
bootstrap, configuration, activation, generation/restart persistence, legacy
journal recovery, Unicode transport and previous-key recovery. TUN administrator
authentication remains required. No scope creep or integration regression found.

Final totals: Standards 0; Spec 0. Incremental P2 independently rechecked as
resolved. Static and final Docker gates are green; the prior browser gate remains
valid. Packaged release, production and physical deployment acceptance remain
unperformed. Correction prepared for the user's authorized commit/push to PR #54.

## Review 5708397413: credential admission

Baseline: `b0fbdcfcbb147e8dfe0e5cc61b76bcd913ddece0`.
Validate a new rotation or first-install environment seed before it can become
durable. Share the controller Authorization builder with transport, reject only
unrepresentable header bytes and trailing ASCII space/tab, preserve leading
whitespace and Unicode, and leave existing confirmed/pending recovery unchanged.
The manual credential length remains unrestricted.

- [x] Red/green admission and recovery regressions.
- [x] Raw static verification and focused runtime evidence.
- [x] Independent incremental and final Standards/Spec review.
- [x] Prepare the correction for the authorized update to PR #54.

Before correction, 11 new admission cases failed (5 new rotations plus 6 initial
environment seeds; NUL rotation was already blocked by the shared schema):
`/tmp/submerge-pr54-round2-red.log`. Tests also preserve short/Unicode/leading
whitespace values, existing pending journals and confirmed credential precedence.
Focused server-package execution passed 111 tests, including real startup cases
(`/tmp/submerge-pr54-round2-green-server.log`). An earlier root-directory direct
runner could not resolve the startup child's package-local tsx; no source change
was needed when run from the server package.

Raw static passed: 142 shared / 1388 server / 297 web tests, four opt-in skipped,
and production builds (`/tmp/submerge-pr54-round2-static-final.log`). Initial
concurrent whole-worktree checks timed out in 5-second network-bootstrap child
tests in both branches; serial reruns passed unchanged. Existing browser evidence
remains valid: no web implementation or new UI control changed.

Local Linux/arm64 Docker verification passed with the final compiled server over
the published runtime image. A rejected `abc ` first-install seed left neither a
confirmed key nor a pending journal. Recreating only the app with a valid leading
space/tab + Unicode seed worked on the same volumes and preserved those bytes.
The actual controller client and credential probe authenticated after engine/app
restart; unauthenticated requests returned 401. Six unusable new rotation values
left DB credentials, journal and config unchanged; previous-key controller
recovery worked for each. App uid: 999. Temporary resources were removed.
Artifacts: chat scratch `manual-secret-admission/{compose.yaml,smoke.py,smoke.log,results.json}`.
This is runtime verification with a compiled-code overlay, not packaged release
or production acceptance.

### Incremental Standards

Reviewer `/root/incremental_standards`: no findings on the complete correction.
Admission and transport share the Authorization builder; new persistence is
guarded while historical recovery remains intact. No documented-standard
violations or actionable smells.

### Incremental Spec

Reviewer `/root/pr54_final_spec`: no findings. New seed/rotation validation runs
before persistence, existing saved/pending values retain recovery, leading
whitespace/Unicode/short values remain unchanged. Independent Node Headers checks
confirmed the valid examples survive unchanged. No scope creep or partial requirements.

Incremental totals: Standards 0; Spec 0. The environment template and runbook also
clarify the representability constraint without adding a length requirement.

### Final Standards

Reviewer `/root/final_standards`: no findings across the entire feature from
`7a92a3a7b764162c0fa04dea5f2e2c20c07722fc` and the final correction. Shared
transport/admission validation, historical recovery and documentation conform to
the repository's boundaries and standards; no actionable smells.

### Final Spec

Reviewer `/root/round2_final_spec`: no findings across the entire feature. All
new-admission review requirements are implemented before persistence; confirmed
credentials and pending journals retain recovery. Short values, Unicode and
leading whitespace remain supported. No length minimum or scope creep introduced.

Final totals for this correction: Standards 0; Spec 0. All required local gates
are green. Later environment-template/runbook edits only clarify the verified
behavior. Publication to the existing PR is authorized; no merge/deployment run.
