# Single-node import implementation

Status: Complete and verified locally on `codex/single-node-import`; prepared for PR to `master`, not deployed.

Spec: [Single-node import](../specs/2026-10-07-single-node-import-design.md).

## Vertical slice

- [x] Red tests: full Xray VLESS/Reality config with DNS URL, bare outbounds,
  native YAML/JSON, cardinality, malformed/unsupported content, no fetching.
- [x] Automatic shared detection, strict single-node parser, static source persistence
  and manual refresh semantics, existing subscription compatibility.
- [x] Form hints, file/drop support, static-node row, unit and browser fixtures.
- [x] `pnpm verify:static` and focused zero-retry browser evidence.
- [x] Independent incremental `/code-review`, findings resolved.
- [x] Independent final `/code-review` for the entire change, findings resolved.

## UI evidence contract

- References: Pencil Sources `gm1vM` (1440 x 1024, dark), `ce3MH` (390, dark).
  Preserve card radius 10, header padding 14/16, form inset/gap 16, textarea 120,
  button 40, Inter/JetBrains Mono, token colors. New copy and automatic type hint
  are intentional extensions of these references; no extra control is added.
- Browser plugin not available; use the repository Playwright workflow.
- Flow: `/sources` -> paste/upload/drop one config -> type hint -> add -> one static
  source/node; invalid imports retain their text and show a validation error.
- Widths: 320/390/425/768/1024/1440 plus 991/992/993 (672px page container).
- Risk states: populated, empty, add failure, malformed JSON, large file,
  HWID previously enabled, disabled/static row, keyboard input/focus.
- Screenshots: `/tmp/submerge-single-node-1440-dark.png`,
  `/tmp/submerge-single-node-390-dark.png`, `/tmp/submerge-single-node-320-light.png`.
  Inspected desktop and mobile renders against measured Pencil values. DOM confirms
  textarea 120px, primary button 40px, card radius 10px and no overflow in `html`,
  `.app-main`, `.responsive-page` or changed controls at all nine widths.
- Static gate passed with Node 24.21.0: Biome, design-token sync, typecheck,
  140 shared + 1264 server + 290 web tests, production builds. Two existing server
  tests remain skipped. Existing store-symlink and bundle-size warnings are unchanged.
  Repeated successfully on fresh `master` (`1c5e15e`) with Vitest 5.0.3,
  better-sqlite3 13.0.3 and jest-dom 7.0.1 after frozen-lockfile installation.
  Use installed Node 24 for the project's SQLite native module. Final publication
  checks use pnpm 11.10.0; no dependency or lockfile changes belong to this feature.
- Focused browser gate: final 18 passed (21.0s on fresh `master`), zero retries, `single-node-import.spec.ts` and
  `forms-layout.spec.ts`, isolated Vite at `http://127.0.0.1:5178`, installed Chrome
  153 (17 passed, 1.7m) and installed headless Chromium on Node 24 (17 passed, 20.8s)
  via temporary `/tmp/submerge-playwright.config.mjs` (expected bundled browser
  revision absent). Form POSTs exercise the actual server ingest parser with isolated
  fixtures; service tests cover SQLite persistence/config generation. No production
  installation or actual endpoint connectivity was tested.
- Intentional reference extensions: source subtitle, JSON/YAML placeholder/file
  hint, automatic type badge and static row copy. No new control, spacing or color.
- Independent incremental reviewer: `/root/incremental_code_review`. Six P2 findings
  fixed with red regression tests: flattened Trojan, TCP/RAW header defaults/loss,
  opaque passwords, sing-box plugin rejection, WireGuard normalization/validation,
  and flow-style YAML. Follow-up review: **No findings**. The optional logs source-kind
  whitelist and the scheduler exclusion fixture were also updated.
- Final independent reviewer: `/root/final_code_review`. Five P2 findings fixed
  with failing-first regressions: YAML preamble detection, Xray method selection,
  WebSocket host precedence, explicit gRPC mode/authority rejection and sing-box
  unsupported TLS authentication rejection. Follow-up review: **No findings**.
  Publication recheck after moving to `master` (`1c5e15e`): **No findings**;
  upstream dependency updates do not introduce a concrete integration defect.
  Both independent review gates are green. Publication was requested explicitly;
  the feature branch is based on current `master`, with no production deployment.
