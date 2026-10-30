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
