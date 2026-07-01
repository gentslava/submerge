# Protocol parsers — Phase A (non-vless URI/JSON mappers)

**Status:** draft (spec) · **Date:** 2026-07-02 · **Scope:** `packages/server` ingest layer

## Problem

submerge parses only **vless** from single-node links and from the v2ray/xray &
sing-box JSON subscription formats. Non-vless nodes are dropped — **silently** in
the JSON path (`return null`), and with a hard error for single links
(`detectKind` throws `"single nodes are only supported for vless://"`). The
clash/mihomo YAML branch already passes every proxy type through verbatim, and
the tunnelling engine (mihomo) natively supports hysteria2, tuic, vmess, trojan,
shadowsocks and more — so the limitation lives purely in `parse.ts`, not the
engine or the config generator (`buildConfig` writes proxies untyped).

Goal: ingest non-vless protocols from all input surfaces, and stop dropping nodes
silently. **hysteria2 first** (user priority), then trojan/vmess/ss/tuic on the
same pattern. AmneziaWG is a different ingestion path and is **out of scope here**
(its own Phase B spec).

## Non-goals

- **AmneziaWG / WireGuard** — needs a `vpn://` (Qt qCompress) / `.conf` decoder
  mapping to mihomo `type: wireguard` + `amnezia-wg-option`. Separate spec (Phase B).
- **New UI beyond a "skipped nodes" notice.** Node rows already render any type
  generically (`typeBadges`).
- **Protocols the engine can't run.** Only map what mihomo supports.

## Current ingest flow (unchanged shape)

`ingestSource(value)` → `detectKind` → dispatch:
- `vless` → `parseVless(value)` (single link)
- `sub` → fetch URL (or inline) → `parseProxiesFromText(text)`
- `happ` → decoder → `parseProxiesFromText(body)`

`parseProxiesFromText` tries, in order: (1) clash-yaml `proxies:` (pass-through),
(2) v2ray/sing-box JSON outbounds, (3) base64 / plain list of `scheme://` links.

## Design

### 1. Per-protocol single-link kinds (no migration)

Today `detectKind` returns `"vless"` for a single `vless://` link and rejects
every other single-node scheme. Generalize so **the `kind` of a single link is
its protocol** (personalized, honest, and no migration since `vless` stays valid):

- `detectKind` returns the **protocol scheme** for a supported single-node URI:
  `vless`, `hysteria2` (normalizing the `hy2://` alias), `vmess`, `trojan`,
  `ss`, `tuic`. Unknown schemes still throw, with a message listing what *is*
  supported.
- New `parseSingleLink(uri): ProxyConfig` dispatches on `new URL(uri).protocol`
  to the per-protocol parser. `parseVless` stays as-is and becomes one branch.
- `ingestSource` treats any single-link kind uniformly: a
  `SINGLE_LINK_KINDS` set (`vless`, `hysteria2`, `vmess`, `trojan`, `ss`, `tuic`)
  routes to `parseSingleLink`; `sub`/`happ` keep their existing paths.

**Contract change:** `sourceKindSchema` gains the new protocol literals:
`["sub", "happ", "vless", "hysteria2", "vmess", "trojan", "ss", "tuic"]`.
Existing `kind='vless'` rows stay valid → **no DB migration**. `kind` is used
only for dispatch + display; the web maps each to a label/icon (unknown → generic).

### 2. Extend the JSON converters (add protocol branches)

`v2rayOutboundToMihomo` and `singBoxOutboundToMihomo` currently early-return on
non-vless. Replace the guard with a **dispatch on protocol/type**:

- v2ray/xray outbound `ob.protocol`: `vless` (existing), `vmess`, `trojan`,
  `shadowsocks`, plus sing-box `ob.type`: `hysteria2`, `tuic`, `vmess`, `trojan`,
  `shadowsocks`.
- Each protocol gets a small pure mapper `…OutboundToMihomo(ob) → ProxyConfig | null`.
  Unrecognized protocols return `null` (still skipped — but now **counted**, §3).

No registry/DI (ADR-0004): a `switch` on the protocol string dispatching to
named helpers is the whole mechanism.

### 3. Stop dropping silently — surface a skipped count

`parseProxiesFromText` returns `{ proxies, skipped }` where `skipped: string[]`
is the deduped list of unsupported protocol/scheme names encountered (e.g.
`["ssr", "snell"]`). Thread it through:

- `IngestResult` gains `skipped: string[]` (default `[]`).
- `sources.service.add` returns the skipped list in its tRPC result.
- Web add-source flow shows a `sonner` toast when non-empty:
  `"Добавлено N узлов · пропущено M (неподдерживаемые: ssr, snell)"`.
  **Manual add only** — subscription auto-refresh does not toast (no user
  present to read it); the skipped list is still computed and could feed a future
  per-source badge, but that's out of scope here.

Single links that fail to parse still throw (unchanged — a single bad link is a
user error, not a silent drop).

### 4. Reference mapping — hysteria2 (first slice)

Target mihomo fields (same as the clash-yaml form that already works):
`{ name, type: "hysteria2", server, port, password, sni, skip-cert-verify,
obfs, obfs-password, ports? }`.

- **URI** `hysteria2://[user:]pass@host:port[,ports]/?sni=&obfs=&obfs-password=&insecure=#name`
  (also `hy2://`): `password` = URL auth (`user:pass` → `pass`, or bare token),
  `server`/`port` = host/port, `sni` = `?sni`, `skip-cert-verify` = `insecure==1`,
  `obfs`/`obfs-password` = `?obfs`/`?obfs-password`, port range after `,` →
  `ports`.
- **sing-box JSON** `{ type:"hysteria2", server, server_port, password,
  obfs:{type,password}, tls:{server_name,insecure} }` → the same fields.
- **v2ray/xray**: hysteria2 is not a classic xray outbound; only the sing-box
  shape is mapped.
- **clash-yaml**: already works (pass-through) — add a regression test only.

> Badge (cross-concern with the shipped transport/security badge): hysteria2/tuic
> carry no `tls`/`network` fields, so `transportBadge`'s "default to TCP" would
> mislabel a QUIC node as `HYSTERIA2 · TCP`. Fix: make the transport default
> **protocol-aware** — QUIC family (`hysteria2`, `tuic`) → `QUIC`; tcp family
> (`vless`/`vmess`/`trojan`/`ss`) → `TCP`; `node.network`, when present, always
> wins. So hysteria2 reads `HYSTERIA2 · QUIC`. Folded into the hysteria2 slice.

### 5. Follow-on slices (same pattern, after hysteria2)

Each is one slice = URI parser + JSON branch(es) + tests, with canonical
fixtures:
- **trojan** — `trojan://pass@host:port?sni=&type=&security=#name` → `{type:"trojan",
  password, sni, network, …}`.
- **vmess** — `vmess://<base64 json>` (v2rayN) → `{type:"vmess", uuid, alterId,
  cipher:"auto", network, …}`.
- **shadowsocks** — `ss://<base64(method:pass)>@host:port#name` → `{type:"ss",
  cipher, password}`.
- **tuic** — `tuic://uuid:pass@host:port?…` → `{type:"tuic", uuid, password, …}`.

## Files touched

- `packages/shared/src/schemas.ts` — `sourceKindSchema` gains protocol literals
  (no migration; `vless` stays valid).
- `packages/server/src/modules/sources/parse.ts` — `detectKind`,
  `parseSingleLink` + per-protocol parsers, JSON dispatch, `parseProxiesFromText`
  return shape.
- `packages/server/src/modules/sources/ingest.ts` — `IngestResult.skipped`,
  `SINGLE_LINK_KINDS` dispatch.
- `packages/server/src/modules/sources/service.ts` + `router.ts` — surface skipped
  (manual add only).
- `packages/web/src/features/nodes/nodeView.ts` — protocol-aware transport default
  (QUIC for hysteria2/tuic).
- `packages/web` — add-source toast; per-kind label/icon for the new kinds.

## Testing

- Unit (vitest) per parser using the canonical fixtures (hysteria2 URI/clash/
  sing-box from the design research). Assert exact `ProxyConfig` output.
- `detectKind` recognizes each supported scheme; rejects unknown with the
  listing error.
- `parseProxiesFromText` returns the right `skipped` list for a mixed body
  (e.g. one vless + one hysteria2 + one `ssr://`).
- Regression: clash-yaml hysteria2 still passes through unchanged.
- Migration test: an existing `kind='vless'` row reads back as `'link'`.

## Resolved decisions

1. **Per-protocol single-link kinds** — each single link's `kind` is its protocol
   (`vless`/`hysteria2`/`vmess`/`trojan`/`ss`/`tuic`); no DB migration.
2. **Phase A ships all five** — hysteria2 first (reference), then
   trojan/vmess/ss/tuic in the same phase.
3. **Skipped toast on manual add only** — not on subscription auto-refresh.
4. **Transport badge is protocol-aware** — QUIC for hysteria2/tuic, TCP for the
   tcp family; `node.network` wins when present.

## Slice order (for the implementation plan)

1. hysteria2 (URI + sing-box JSON + parseSingleLink dispatch + `kind` literals +
   protocol-aware QUIC badge + clash regression test).
2. skipped-count contract (`parseProxiesFromText` return shape + `IngestResult` +
   manual-add toast).
3. trojan · 4. vmess · 5. shadowsocks · 6. tuic (one slice each, same pattern).
