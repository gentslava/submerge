# Native TUN settings implementation

Status: implemented and verified locally; not deployed.
Scope: [native settings spec](../specs/2026-10-11-tun-settings-design.md).

- [x] Slice 1: preserve TUN preferences and shared routing when selecting Proxy;
      protected setup/status API, explicit activation verification; TDD/static/review.
- [x] Slice 2: native segmented mode and inline setup/status in Settings; Pencil
      desktop/mobile references, TDD/static/browser/review.
- [x] Final whole-change independent review and resolved findings.

Agreed product behavior: Proxy / TUN, one app and one routing policy. TUN keeps
HTTP/SOCKS available. No production or client-network changes, commit or push.
Browser plugin not available; use the repository's Playwright workflow with
zero retries and an isolated Vite server. Screenshots and temporary outputs are
stored outside the repository. UI reference: `w6qeY` / `r1RQ0O`, Indigo Console.

Slice 1 evidence: full static gate passed (158 shared / 1327 server / 294 web);
native Docker tests passed 2/2, including protected TUN → Proxy → TUN and restart
bootstrap while Proxy. Independent code-review verdict APPROVE after resolving
corrupt retained-preference fallback and marking device/capability checks unknown
until engine activation. No commit or push.

Native UI reference frames: `oXxu8` (1440×1024 dark), `Q3sToj` (390×1024).
Copy the existing Indigo Console row, segmented, field and button metrics;
advanced settings are inline collapsed native details, with native selects.

Settings behavior matches the existing app: valid mode/select/list changes apply
immediately, text inputs on blur. First TUN setup waits for an explicit local DNS;
no Apply button. Blur into the mode control does not activate a pending TUN draft.
Errors have a Retry action, and Advanced stays open across autosaved field edits.

Slice 2 evidence before final review: full static gate passed (158 shared / 1330
server / 297 web); 16 native-settings browser tests in Chromium and WebKit,
plus 12 existing form/shared
layout tests passed with zero retries. Widths: 320/390/425/768/983/985/1024/1440,
both themes, collapsed/expanded, populated/empty/error, pending controls, first
DNS setup, invalid field drafts, exact-domain list editing and retries. Desktop
reference: `oXxu8`, 1440×1024 dark; mobile reference: `Q3sToj`, 390×1024. Screenshots:
`/tmp/submerge-tun-ui-1440-dark.png`, `/tmp/submerge-tun-ui-390-dark.png`;
computed styles: `/tmp/submerge-tun-ui-metrics.json`.
The new references use canonical text line heights (20/16/19.5px). Pen strokes
do not contribute to flex sizing; browser borders add 6px to the whole card.
Mobile reference includes native status chrome; the web app does not invent it.
Measured controls match: 260px desktop segment/inputs, 13px segment labels,
15px heading, 36px input, shared tokens and responsive rows. No clipping/overflow
or duplicate document scroll owner. No custom popup was introduced; details and
selects are native controls.

Reviewed backend follow-up: Proxy-first prepared deployment and truthful LAN/DNS
guide approved after excluding loopback/internal addresses, exposing nullable
reachable DNS, and keeping the activation caveat after persisted failed TUN.
Prepared Proxy blank-secret reset also has a no-preferences recovery regression.
Final built-image native tests passed 2/2 (52.24s), covering real Linux DNS/TUN,
Proxy-first setup through protected API, mode transitions, lists and outages.
Temporary Docker resources were removed by the tests.

Independent frontend `/code-review`: APPROVE after fixing the pointer-intent
case where blur has no focus target. Unit regression first failed, then passed;
both actual browser engines passed 16/16 with zero retries. Mode-switch pointer
intent is tracked independently of focus so opting into Proxy cannot activate TUN
while leaving the DNS field. The reviewer also inspected both rendered/reference
screenshots and measured responsive states. No unresolved incremental findings.

Final wide-review recovery finding: a failed LAN-interface edit retained desired
preferences while restoring the accepted TUN config, then also prevented Proxy
deactivation. Activation/readiness now require the LAN capture interface only
while TUN is enabled; shared WAN/DNS/provider checks stay active. A regression
failed before the fix. Full static verification passed again (158 shared / 1331
server / 297 web), and the rebuilt-image native suite passed 2/2 with zero retries
(48.52s), including failed edit → old TUN preserved → Proxy disables TUN → valid
TUN restored. This server-only fix does not change the verified browser behavior.

Pencil editor normalization: its serializer removed six existing unrelated
shadow `spread` fields (`WQxXi`, `dFd9Y`, `P8UQ5`, `Dt1fU`, `ql11t`, `OHptM`).
Exact restoration through MCP was rejected because the current editor schema
does not support `effect.spread`. No other unrelated intentional design changes
were made, and the design token variables remain unchanged.

The final wide pass also reproduced a same-mode configuration refresh retaining
stale form values and overwriting a newer MTU during DNS autosave. The form now
merges refreshed untouched fields, preserves edited/invalid fields and raw text,
and clears a field's dirty state only when the changed server value acknowledges
that draft. Advanced stays open. Two unit regressions failed before repair; the
dirty-text regression includes repeated unrelated refreshes while a new DNS line
is unfinished. Browser evidence includes Check → refreshed MTU → DNS-only save
retaining the newer MTU, and an invalid MTU surviving an upstream refresh.

Final verification after both recovery fixes: `pnpm verify:static` passed (158
shared / 1331 server / 299 web), production builds and final Docker image build
passed; Chromium 17/17 (22.7s) and actual WebKit 17/17 (27.6s) passed with zero
retries. The native Linux suite passed 2/2 (48.52s) after the network fix; only
frontend synchronization changed afterward. Shared form/layout tests remain
12/12. No production, LAN-client, AdGuard, commit or push action was performed.

Final whole-change independent `/code-review`: APPROVE by
`gateway_slice1_review`, covering all tracked and untracked changes against HEAD.
Both integration findings above were resolved, and the reviewer independently
reproduced the repaired MTU refresh/submission behavior. No unresolved blocking
findings remain. Physical LAN/macvlan, a real VPN subscription/upstream, and
production acceptance remain separate from the verified local test contour.
