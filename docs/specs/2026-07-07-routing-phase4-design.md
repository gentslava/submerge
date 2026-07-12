# Routing Phase 4 — rule-providers, keyword/geo rules, on-demand speed test

**Status:** implemented (4a–4c) · **Date:** 2026-07-07 · **Scope:** `packages/shared` matcher/policy schemas · `packages/server` config generation + channels module + mihomo client + a bandwidth probe · `packages/web` «Маршрутизация» matcher editor + a speed-test action · `docker-compose.yml` (geo/provider volume)

Builds on the shipped channel-routing model ([2026-07-01-channel-routing-design.md](2026-07-01-channel-routing-design.md), phases 1–3b). That design already listed these as **Phase 4 (Polish)**; this spec turns the bullet points into a concrete, staged design against the live code.

## 1. Why

Today a channel matches traffic only via **`DOMAIN-SUFFIX`** — expanded from curated presets (`resolveMatcherDomains`) plus a free-text domain list — and node selection ranks only by **latency**. Two gaps:

- **Matcher reach.** Maintaining large domain lists by hand goes stale; there is no keyword match, no country/category match, and no way to point a channel at an externally-maintained, auto-updating rule list. The 3b spec explicitly deferred `DOMAIN-KEYWORD`, geo rules, and rule-providers.
- **Selection blind to capacity.** *Latency ≠ throughput* — a low-ping node can be bandwidth-starved. `sticky.initialCriterion` already carries `fastest` / `lowest-loss`; the design reserved `highest-bandwidth` but there is no way to measure a node's throughput.

## 2. What ships (three features, one model)

| Feature | mihomo mechanism | Phase |
|---|---|---|
| **DOMAIN-KEYWORD** matcher | `DOMAIN-KEYWORD,<kw>,<group>` | 4a |
| **Rule-providers** (external, auto-updating rule lists) | top-level `rule-providers:` + `RULE-SET,<name>,<group>` | 4a |
| **Geo rules** (GEOSITE category / GEOIP country) | `geodata-mode` + `geox-url` + `GEOSITE,<cat>,<group>` / `GEOIP,<code>,<group>` | 4b |
| **On-demand speed test** + `highest-bandwidth` | hidden `PROBE` `select` group + fixed-payload download through the local proxy | 4c |

All three extend the existing per-channel matcher / per-channel `select`/`url-test` group model. No new routing engine, no global rule-provider registry screen — everything stays a property of a channel, mirroring how `domains`/`presets` already work.

## 3. Data model — matcher & policy schema (`packages/shared/src/schemas.ts`)

Extend `channelMatcherSchema` (and the strict write-side `channelMatcherInputSchema`) additively — every new field defaults to empty, so existing rows and the Default channel are unchanged:

```ts
// existing: presets: string[], domains: string[]  (DOMAIN-SUFFIX)
keywords: z.array(z.string()).default([]),          // DOMAIN-KEYWORD          (4a)
ruleProviders: z.array(ruleProviderRefSchema).default([]), // RULE-SET          (4a)
geosite: z.array(geoCategorySchema).default([]),    // GEOSITE,<cat>           (4b)
geoip: z.array(geoCountrySchema).default([]),       // GEOIP,<code>            (4b)
```

- **`ruleProviderRefSchema`** = `{ url: httpsUrl, behavior: "domain"|"ipcidr"|"classical" }`. The mihomo `format` (`yaml`/`text`/`mrs`) is **derived from the URL extension** (`ruleProviderFormat`: `.list`/`.txt` → text, `.mrs` → mrs, else yaml) — it's a mechanical property of the file, not a user choice (mihomo trusts the declared format, so we supply it, but the admin shouldn't have to reason about it). `behavior` **stays a user choice** — it changes how mihomo parses the file and isn't reliably derivable from the URL. Write-side validates `url` is `http(s)` and rejects an `.mrs` URL with `classical` behavior (mihomo supports `mrs` only for `domain`/`ipcidr`). No user-facing `name` — config-gen derives a stable internal id (§4).
- **Keyword / geo strings**: `keywords` validated as non-empty trimmed tokens (no dots/whitespace requirement — a keyword is a substring); `geoCategorySchema` = lowercase `[a-z0-9-]+` (e.g. `youtube`, `telegram`, `category-ads-all`); `geoCountrySchema` = ISO-3166 alpha-2 upper (e.g. `RU`, `CN`, `IR`), plus mihomo's `private`/`LAN`. Keep the validation strict at the write boundary (same pattern as `domainSchema`).

**Policy** — add `highest-bandwidth` to the sticky criterion enum (4c):

```ts
initialCriterion: z.enum(["fastest", "lowest-loss", "highest-bandwidth"]),
```

No DB migration for `channels`/`channel_pool` — matcher/policy are JSON blobs already `.parse()`d at the service boundary; the new fields are additive with defaults. A **new table `node_bandwidth`** lands in 4c (§7).

## 4. Config generation (`packages/server/src/modules/nodes/multiConfig.ts`)

`buildRules()` today emits only `DOMAIN-SUFFIX` + a terminal `MATCH`. Extend the per-channel emission and add the top-level `rule-providers:` / geo keys. The `ChannelConfigInput` passed from `applyConfig` grows to carry the resolved matcher parts (keywords, geo, provider refs) alongside the existing expanded `domains`.

### 4a — keyword + rule-providers

Per non-default channel, in priority order (unchanged: lower `priority` = earlier = higher precedence), emit **all** of the channel's rule lines pointing at its group `groupName`:

```
DOMAIN-KEYWORD,<kw>,<group>          # for each matcher.keywords
DOMAIN-SUFFIX,<domain>,<group>       # existing (presets + custom domains)
RULE-SET,<providerName>,<group>      # for each matcher.ruleProviders
```

(Intra-channel order among rule types is irrelevant — they all resolve to the same group.) The terminal `MATCH,<default-group>` / `MATCH,PROXY` / `MATCH,DIRECT` logic is unchanged.

**Top-level `rule-providers:`** — collect every distinct provider ref across all enabled channels, **dedupe by `(url, behavior)`** (format is a function of the url), and emit one entry each:

```yaml
rule-providers:
  rp-1:
    type: http
    url: "https://example.com/reject.yaml"
    behavior: classical
    format: yaml
    interval: 86400          # daily auto-update
    proxy: DIRECT            # fetch the list directly, never through the tunnel (avoid a bootstrap loop)
    path: ./providers/rp-1.yaml
```

- **Provider name** = stable `rp-<hash8(url|behavior)>` so the same list referenced by two channels collapses to one definition and two `RULE-SET` lines. The `rp-` prefix + hex digest keeps it out of the (separate) proxy/proxy-group namespace by construction.
- **`path`** must live under mihomo's Home Dir (`/root/.config/mihomo`, = host `./mihomo` bind mount) unless `SKIP_SAFE_PATH_CHECK=1`. Use `./providers/<name>.<ext>` (relative to Home Dir). `.gitignore` already ignores `mihomo/providers/`. The `mihomo` container fetches — **submerge does not download rule lists**; it only writes the YAML that tells mihomo where to fetch (boundary discipline: no new external fetch in the server).
- **`proxy: DIRECT`** is mandatory — fetching a rule list *through* the proxy it configures is a chicken-and-egg loop.
- **`interval`**: default 86400s; configurable later, not exposed in 4a UI (sane default).

### 4b — geo

When any enabled channel has `geosite`/`geoip`, emit the geo rule lines and turn on geodata at the top level:

```yaml
geodata-mode: true
geo-auto-update: true
geo-update-interval: 168        # weekly
geox-url:
  geoip: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat"
  geosite: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat"
  mmdb: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.metadb"
```

Rules: `GEOSITE,<cat>,<group>` and `GEOIP,<code>,<group>,no-resolve` (`no-resolve` avoids a DNS round-trip for IP rules). Only emit the geo top-level block **when a geo rule is actually used** — a config with no geo rules stays geo-free (no unnecessary ~MB downloads). The `mihomo` container fetches `geoip.dat`/`geosite.dat` into its Home Dir on first use; this needs egress from the mihomo container and writable Home Dir (already the case for `providers/`).

### YAML slot

In the `cfg` object, insert `rule-providers` before `proxy-groups`, and the geo keys near the top (next to `mode`). `rules:` stays last. The Default-only and no-proxy fast paths (`MATCH,PROXY` / `MATCH,DIRECT`) short-circuit before any provider/geo emission.

## 5. On-demand speed test (4c) — mechanism

mihomo has **no** "request through node X" endpoint and no throughput probe, so measure via a dedicated hidden group + a real download (same approach the original design §5 settled on):

1. **Hidden `PROBE` `select` group** in the generated config, members = all nodes (the same inventory the Default channel defines). Not listed in the top-level `PROXY` group (hidden from the manual override UI).
2. A reserved probe host (e.g. `speedtest.submerge.internal`) routed by a rule `DOMAIN,<probe-host>,PROBE` placed **above** all channel rules.
3. To test node *N*: server `PUT /proxies/PROBE {name: N}`, then issues an HTTP GET for a **fixed-size payload** (a configurable URL, default a well-known ~10 MB file) to the probe host **through mihomo's local mixed-port (7890)**, measures bytes/sec over the transfer (with a hard timeout + byte cap), then restores `PROBE` to its previous pick.
4. Serialize probes (one at a time) and gate behind an explicit **traffic-cost confirmation** in the UI — this burns real quota and briefly loads the node.

**Caching** — new table `node_bandwidth (node_name PK, mbps REAL, tested_at INTEGER)`. Results persist; the UI shows value + relative age. `highest-bandwidth` (sticky) ranks by the **cached** value; nodes without a cached value fall back to `fastest` ordering (documented, not silently dropped).

**Passive bandwidth (nearly free, may land first).** The active node's live up/down Mbps is already available from mihomo's `/traffic` stream (`streamTraffic`). Surface it as a read-only display on the active node (Nodes screen / active card) — this is the honest "real usage" number and needs no PROBE group. Active on-demand measurement stays behind the warning because of its cost.

**Client boundary** — the fixed-payload download goes through `packages/server/src/clients/mihomo.ts` (new `measureBandwidth(node, {url, timeoutMs, maxBytes})`), reusing the client's timeout/error discipline; the reserved-host rule and `PROBE` group are emitted by `multiConfig.ts`.

## 6. UI (`packages/web/src/features/channels/`)

Matcher editor (`ChannelCard` expanded, non-default channels) gains, below the existing preset chips + domain tags:

- **Keywords** — a tag-input identical in behavior to `DomainTags` (validates keyword tokens). Label «Ключевые слова».
- **Geo** — two tag-inputs / comboboxes: «Категории (GEOSITE)» and «Страны (GEOIP)», validated against the geo schemas. (4b)
- **Rule-providers** — a small repeatable row: URL + behavior («Тип») select (`classical`/`domain`/`ipcidr`) + remove. «Списки правил». The `format` is auto-derived from the URL, so there is **no** format control. (4a)

Each control follows the design-system gates (tokens-in-config, control-type fidelity, measure-don't-invent) and must back a real endpoint — no decorative inputs. Read the matcher-editor frame(s) via Pencil MCP (`fFpGe` «Маршрутизация» + its expanded-editor child; confirm exact ids at build time — the `docs/design-system.md` frame map is stale and must be refreshed as part of this work).

Speed-test (4c): a per-node / per-pool **«Тест скорости»** action (Nodes screen and/or the pool picker) gated behind a confirm dialog spelling out the traffic cost; shows the cached Mbps + age; a spinner during measurement. Passive Mbps of the active node shown on the active-node card.

## 7. Phasing (vertical slices)

Ship independently; each is behaviour-verifiable and adds no risk to the others.

- **4a — keyword + rule-providers.** Highest value/lowest risk: matcher schema (`keywords`, `ruleProviders`), `buildRules` + top-level `rule-providers:`, collision-guard names, matcher-editor UI. No container/geo change (mihomo writes providers into the existing `./mihomo` mount). **Ship first.**
- **4b — geo.** Adds `geosite`/`geoip` matcher fields, geo rule emission + conditional `geodata-mode`/`geox-url`. Infra note: the mihomo container downloads `geoip.dat`/`geosite.dat` (~MBs) on first geo use and needs egress + writable Home Dir; document in deploy notes. Verify a geo rule actually routes on the deployed instance.
- **4c — on-demand speed test + `highest-bandwidth`.** Largest surface: `PROBE` group + reserved-host rule, `measureBandwidth` client, `node_bandwidth` table, sticky `highest-bandwidth` scoring, the warning-gated UI action. Passive-bandwidth display may land alongside 4a/4b since it's nearly free.

## 8. Risks & trade-offs

- **Rule-provider trust & availability.** A bad/oversized/unreachable list can break routing; mitigate with `size-limit`, a sane `interval`, `proxy: DIRECT`, and mihomo's own fallback (a failed provider fetch keeps the last cached file). Document that provider URLs are user-supplied and fetched by mihomo, not vetted by submerge.
- **Geo download weight & egress.** `geoip.dat`/`geosite.dat` are non-trivial and need the mihomo container to reach `jsdelivr` (or a mirror). On a locked-down host this can silently fail — surface it, don't fake geo matches. This is why geo is its own phase and off unless a geo rule is used.
- **Speed-test cost.** Real quota burn + node disruption; strictly user-triggered, serialized, byte-capped, timeout-bounded, and confirmation-gated. `highest-bandwidth` uses only *cached* values — never a per-tick active probe (matches the §11 quota rationale of the base design).
- **Config size / collisions.** More rule lines and provider/group names → keep them in the joint collision-guard namespace; stable hashed provider names prevent churn on unrelated edits.
- **Honesty.** Cached bandwidth with no value → fall back to `fastest` and say so; never invent a throughput number.

## 9. Out of scope

- Global rule-provider registry / management screen (per-channel refs are enough at this scale — ADR-0004 anti-overengineering).
- `sub-rule`, `SCRIPT`/logical rules, `IP-CIDR`/`DST-PORT` hand-authored rules in the UI (rule-providers cover the "big external list" need; classical providers can carry these).
- Converting curated presets into `mrs`/geosite references (presets stay curated `DOMAIN-SUFFIX` lists; revisit only if maintenance hurts).
- Auto-updating the geo/provider intervals from the UI (sane defaults; not a knob yet).
