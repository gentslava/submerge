# Diagnostics screen — design

- **Date:** 2026-07-15
- **Status:** proposed · **Scope:** server self-diagnostics and `packages/web`
  Diagnostics screen
- **Related:** [design-system.md](../design-system.md),
  [adaptive layout](2026-07-12-adaptive-layout-design.md), Pencil frames
  `QoRoZ` / `h9q7E` / `BNOEr` / `pi7pQ`, and the
  [mihomo controller API](https://wiki.metacubex.one/en/api/)

## Problem and goal

The «Диагностика» navigation entry is still an inert placeholder. Existing live
health only says whether the server can read mihomo; it does not explain whether
the sidecars are available, which exit is visible from the internet, whether each
enabled proxy channel can reach its control target, or whether common services are
reachable through the generated routing rules.

Ship one on-demand self-diagnostics screen that answers: **is the submerge proxy
stack working, and where is a failure located?** It diagnoses the self-hosted
server, mihomo, happ-decoder, proxy exits, and configured routes. It is not a
security audit of the browser or the user's device.

## Product invariants

1. **Every result is measured.** Versions, durations, IP, route targets, and
   runtime settings come from the current process or live sidecars. Mock values in
   Pencil are illustrative only.
2. **Failures stay local.** An unavailable external-IP provider must not imply that
   the proxy is broken; one failed service must not hide healthy routes or
   components.
3. **Routes follow the channel model.** The route list contains Default and every
   enabled proxy-backed channel. Direct is not presented as a proxy channel; its
   effect is still exercised by normal service requests through current rules.
4. **Checks are bounded and non-destructive.** Diagnostics never selects a node,
   reloads config, restarts a component, closes connections, or runs a bandwidth
   test.
5. **Results are short-lived.** One process-local result is fresh for five minutes.
   There is no Redis, SQLite, file history, or scheduled background polling.
6. **Refresh does not blank the screen.** «Проверить снова» keeps the previous
   result visible while the replacement run is in progress.
7. **Raw failures remain server-side.** The browser receives a stable error code
   and safe Russian explanation, never secrets, headers, stack traces, or arbitrary
   upstream bodies.

## Screen composition and data mapping

The normal desktop order is:

1. page header and «Проверить снова»;
2. overall verdict;
3. «Внешний IP» and «Компоненты»;
4. «Проверка маршрутов»;
5. «Доступность сервисов» and «Конфигурация mihomo».

Mobile keeps the same reading order in one column. «Проверка маршрутов» is one
card: its icon/title/result header, rows, and optional hint all remain inside the
same border. Other blocks do not acquire extra per-row background layers merely
to imitate the route table.

| Surface | Source | Behaviour |
|---|---|---|
| **Overall verdict** | normalized result of all checks | Shows a textual ready/warning/error state, summary counts, and completion time. Colour is supplemental. |
| **Внешний IP** | Cloudflare trace requested through mihomo's mixed port | Shows the observed IP, country/colo when present, request duration, and the resolved route/node when it is known. |
| **submerge** | server version plus a minimal local SQLite readiness read | The current request already proves HTTP/tRPC liveness; the local read checks the embedded runtime dependency and supplies the measured duration. |
| **mihomo** | controller `/version` | Shows the parsed version and controller duration. A separate `/configs` read feeds the runtime-config block without changing mihomo's component status. |
| **happ-decoder** | sidecar `GET /health` | Shows «доступен» and duration; the sidecar currently exposes no version. |
| **Проверка маршрутов** | current proxy-channel groups, active members, and policy control URLs | One row for Default and every enabled proxy channel; shows safe target host, active node, delay, or a scoped failure/skipped reason. |
| **Доступность сервисов** | lightweight HTTP requests through `MIHOMO_PROXY` | Google, YouTube, Telegram, Cloudflare, ChatGPT, and Steam exercise ordinary current routing rules. |
| **Конфигурация mihomo** | settings `proxyEndpoint` plus parsed controller `/configs` | Shows SOCKS/HTTP endpoint, mode, DNS, IPv6, and TUN. Unknown runtime fields render `—`, not generated defaults. |

The external-IP secondary line names a channel/node only when the server can
resolve it unambiguously. If a custom rule-provider, GEOSITE/GEOIP rule, or another
dynamic matcher makes attribution uncertain, it says «через mihomo · текущие
правила» instead of claiming the Default active node.

Attribution follows the same ordered enabled-channel view used to generate the
config. Static suffix/keyword matches can identify a route; any earlier dynamic
rule that cannot be evaluated from local data makes the answer unknown. If no
enabled non-default matcher can capture the trace host, the route is Default.

The service registry uses small, curated endpoints and expected status ranges.
Receiving an allowed HTTP response means the network path is reachable even if
the service would require authentication in a browser. Timeout, DNS/TLS failure,
or an unexpected 5xx response is a failed check. A slow successful response may
use the amber `slow` token without changing the pass count.

## Route-check semantics

The server loads the current channels and mihomo proxy view once at the start of
the run. For each enabled `target: "proxy"` channel:

1. derive the generated group name with the existing `channelGroupName` contract;
2. follow the group's current `now` references to a non-group leaf, with a cycle
   guard for malformed controller data;
3. derive the control URL with existing `policyProbe` semantics (manual uses the
   built-in default URL);
4. test that current member through `/proxies/{member}/delay` with a five-second
   timeout and expected successful HTTP range.

Testing the current member rather than the whole policy group avoids clearing a
fixed selection or causing a diagnostic run to choose a different node. A row is
`ok`, `failed`, or `skipped`; the UI displays only the safe hostname from a
user-configured test URL, not query parameters or credentials.

If there are no real proxy nodes, the result becomes «Нет прокси-узлов». Default
may still report a working DIRECT path, enabled proxy-channel rows are skipped,
and the external-IP check is skipped because a host DIRECT address is not a proxy
exit. Service reachability may still be shown through the current all-DIRECT
configuration.

## Execution, cache, and concurrency

Add one protected `diagnostics.run` query with a `force` flag:

- page entry calls it with `force: false`;
- a result completed less than five minutes ago is returned immediately;
- no result or an expired result starts a new run;
- «Проверить снова» calls it with `force: true` and bypasses a completed cache;
- if any run is already in progress, all callers await the same promise, including
  a forced caller. There is never more than one concurrent run per server process.

The in-process service stores only `{ result, completedAt, inFlight }`. Failures
are cached by the same five-minute rule; manual refresh remains available. There
is no periodic check while the page stays open. Re-entering the page after the
result expires starts the next run.

Independent component and outbound checks run with at most six network operations
in flight. Each operation has a five-second timeout and no automatic retry; the
whole run is capped at 15 seconds. Work that has not completed at the deadline is
normalized as a timeout, so a stalled provider or a long channel list cannot hold
the page indefinitely. Checks that depend on mihomo become `skipped` when the
controller is unavailable.

On the web, the initial run shows the checking state. A forced or stale refresh
keeps the previous result and adds progress text/spinner until the new result
replaces it atomically.

## Result states and precedence

The base frames show the all-healthy result. Pencil `pi7pQ` defines the exceptional
states:

1. **Проверка выполняется** — no initial result yet, or a previous result remains
   visible while refreshing.
2. **mihomo недоступен** — controller/version check failed; dependent IP, route,
   service, and runtime-config checks are skipped.
3. **Нет прокси-узлов** — the controller works but no real exit node exists.
4. **Нет выхода в интернет** — mihomo works and nodes exist, but every attempted
   outbound request (IP trace, route, and service checks) fails.
5. **Внешний IP не определён** — every other required check is healthy, but the
   trace provider failed or returned an invalid payload. The copy explicitly says
   this is not proof of a proxy failure.
6. **Есть замечания** — any other partial failure, including a sidecar, route, or
   individual service problem.
7. **Все проверки пройдены** — every required check succeeded; `slow` successes
   remain successful.

This order selects the most actionable headline while retaining every individual
row. Skipped checks are never counted as passed. The verdict includes counts such
as «4 из 4 маршрутов работают» rather than a vague colour-only summary.

## Architecture

### Shared

Add Zod schemas for the diagnostics result, component/route/service entries,
runtime config, IP trace, overall status, and safe error codes. The router output
remains inferred from the shared contract.

### Server

- Add `modules/diagnostics/router.ts` and `service.ts`: orchestration, precedence,
  TTL cache, in-flight deduplication, timing, and safe normalization.
- Extend `clients/mihomo.ts` with Zod-parsed `/version` and `/configs` reads plus
  bounded requests through the existing `ProxyAgent(env.MIHOMO_PROXY)` pattern.
- Extend `clients/happDecoder.ts` with a parsed `GET /health` check using a short
  diagnostic timeout; decoding keeps its existing longer timeout.
- Reuse `listChannels`, `channelGroupName`, `policyProbe`, `PSEUDO_NODE_SET`, and
  the existing mihomo proxy/delay clients. Do not duplicate routing logic.
- Register the new router under `diagnostics` in the app router.

No schema migration, Redis key, worker, cron, or new dependency is required.

### Web

- Add `/diagnostics`, activate its sidebar entry, and expose it from mobile «Ещё».
- Build `DiagnosticsScreen` from small verdict, IP, components, routes, services,
  and runtime-config sections. Reuse existing status, latency, button, icon, and
  table tokens.
- The desktop route table follows the Connections table hierarchy and surface
  contract: one bordered `bg-surface` card, `bg-elevated` only for its column
  header, content-driven rows, and internal dividers.
- Mobile uses compact route rows inside the same card rather than a horizontally
  scrolling desktop table.
- The page is the only vertical scroll owner. The screen does not introduce an
  inner page-height panel or horizontal page scrolling.

## Responsive behaviour

Follow the named page-container contract rather than viewport media queries.

| Container | Layout |
|---|---|
| **compact `<42rem`** | One column; full-width «Проверить снова»; compact route rows; services and config remain dense lists; bottom navigation keeps «Ещё» active. |
| **inline `≥42rem`** | Header action shares the title row when space allows; paired cards may use two columns without compressing labels. |
| **data `≥48rem`** | Full desktop composition, Connections-style route columns, and paired IP/components plus services/config blocks. |

At 320/390/425 widths long channel/node names truncate inside their own value area,
not the whole page. No page-level horizontal overflow is allowed, and the fixed
bottom navigation must not cover the final config row. Dark and light themes use
tokens only.

## Interaction and accessibility

- «Проверить снова» is a real button, disabled or progress-labelled while its
  deduplicated run is active, with visible keyboard focus.
- The previous completion time is available as semantic text; rapidly changing
  durations are not announced in an assertive live region.
- Overall and row states always include text or an icon label; green/amber/red is
  not the only signal.
- Tables/lists use semantic headings and rows. Decorative status dots are hidden
  from assistive technology when adjacent text already names the state.
- Truncated host, channel, and node values expose the complete safe value on
  focus/hover without exposing full sensitive URLs.
- Reduced-motion mode disables non-essential spinner/transition animation while
  preserving progress text.

## Testing and visual evidence

### Server/shared

- Zod parsing for mihomo version/config, happ health, and Cloudflare trace.
- Five-minute TTL, forced refresh, cached failures, fake-clock expiry, and one
  in-flight promise across simultaneous callers.
- Per-operation and overall timeout behaviour with no test hitting the public
  internet.
- Dynamic route derivation for Default, enabled/disabled proxy channels, manual
  policy fallback URL, Direct exclusion, pseudo members, and no-node state.
- Result precedence for ready, partial, mihomo-down, no-nodes, no-internet, and
  external-IP-only failure.
- Redaction tests proving raw errors, secrets, headers, and sensitive URL parts do
  not enter the shared result.

### Web

- Initial run, refresh-with-previous-data, and button deduplication.
- All-healthy plus every `pi7pQ` state.
- Dynamic route/service counts, skipped rows, unknown runtime fields, long values,
  and partial component failure.
- Accessible progress/button labels and complete safe-value tooltip/focus content.

### Browser

- Dark 1440×1024 comparison with Pencil `QoRoZ`.
- Light 1440×1024 comparison with Pencil `h9q7E`.
- Mobile 390 comparison with Pencil `BNOEr`.
- Exceptional-state comparison with Pencil `pi7pQ`.
- Responsive checks at 320/390/425/768/1024/1440 and changed container boundaries,
  with zero retries; inspect `html`, `.app-main`, and
  `.responsive-page--diagnostics` for overflow and scroll ownership.
- Populated, checking, partial, mihomo-down, no-nodes, external-IP failure, and
  no-internet fixtures in both themes where colour semantics are involved.

## Out of scope

- Client-device DNS/WebRTC/IP leak tests, antivirus, firewall, port scanning, or a
  general security audit.
- Persisted history, scheduled monitoring, alerts, Redis, SQLite diagnostics
  tables, Prometheus, or remote telemetry.
- Traceroute, packet capture, bandwidth tests, node races, or automatic failover
  beyond the channel controller's existing behaviour.
- Automatic component restart, config reload, route repair, or node selection.
- User-editable service probes and arbitrary URL execution from the browser.
- Guarantees about account/login availability of third-party services.

## Resolved decisions

1. The first release uses the hybrid screen: component readiness, external IP,
   dynamic channel-route checks, ordinary routed service checks, and runtime config.
2. Route rows cover Default plus enabled proxy channels; service checks exercise
   actual routing rules separately.
3. Results live only in server memory for five minutes; page entry refreshes stale
   data, manual refresh is always available, and concurrent runs are deduplicated.
4. The external-IP block is named «Внешний IP» and never overstates node
   attribution when current routing cannot be resolved safely.
5. Route-table styling follows Connections; compact service/config lists keep the
   denser Indigo Console card pattern without redundant nested backgrounds.
