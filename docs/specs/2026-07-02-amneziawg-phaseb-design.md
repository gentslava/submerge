# AmneziaWG / WireGuard ingest — Phase B (design)

**Status:** implemented (Phase B1; hosted `vpn://` v2 = later B2 spike) · **Date:** 2026-07-02 · **Scope:** `packages/server` ingest + badge

## Problem

submerge can't ingest WireGuard/AmneziaWG configs. mihomo (our engine) supports
them natively as `type: wireguard` (+ `amnezia-wg-option` for the AmneziaWG DPI
obfuscation). Users have AmneziaWG configs in three shapes:

1. **Raw AmneziaWG `.conf`** (WireGuard INI + `Jc/Jmin/Jmax/S1/S2/H1..H4`) — a real
   sample is in hand.
2. **`vpn://` config_version 1** (self-hosted): a qCompress blob embedding the WG
   params under `containers[].awg`.
3. **`vpn://` config_version 2** ("Amnezia Free/Premium"): `api_config` +
   `auth_data.api_key`, **no WG params** — the client fetches the real config at
   runtime from Amnezia's gateway (`/api/v1/request/awg/`). A real sample is in hand.

Goal: ingest all three, mapping to a mihomo `wireguard` proxy. The user wants both
self-hosted (1, 2) **and** hosted (3) supported.

## Phasing

- **Phase B1** (this spec, buildable now — real `.conf` fixture in hand):
  - Raw AmneziaWG/WireGuard `.conf` → mihomo `wireguard`.
  - `vpn://` **config_version 1** decode → same mapping.
  - Badge handling for `wireguard` (it's UDP, not TCP/QUIC).
- **Phase B2** (spike, higher risk): `vpn://` **config_version 2** → HTTP client to
  Amnezia's gateway using `api_key`, then map the returned config. Undocumented
  proprietary API (reverse from `apnezia-client/apiController.cpp`), fragile like
  `happ://` — must fail with a clear error when Amnezia changes the format. Its own
  slice; ship B1 first.

## Engine caveats (verify at e2e)

- mihomo WireGuard **cannot be used in `relay`** proxy-groups — we don't use relay,
  fine. It sits in the `select`/`url-test` groups like any proxy.
- Historic "only one wireguard works" issue (mihomo #2338) — verify multiple WG
  nodes coexist when e2e-testing; note if it bites.
- WG latency-tests fine through the url-test group (the speed policy still works).

## Mapping — AmneziaWG `.conf` → mihomo `wireguard`

Reference (real sample):
```
[Interface]
PrivateKey = <b64>              → private-key
Address = 10.8.2.2/32           → ip: "10.8.2.2"  (strip mask; a v6 addr → ipv6)
DNS = 1.1.1.1, 1.0.0.1          → dns: ["1.1.1.1", "1.0.0.1"]
Jc/Jmin/Jmax/S1/S2/H1..H4       → amnezia-wg-option: { jc, jmin, jmax, s1, s2, h1, h2, h3, h4 } (numbers)
[Peer]
PublicKey = <b64>               → public-key
PresharedKey = <b64>            → pre-shared-key
AllowedIPs = 0.0.0.0/0, ::/0    → allowed-ips: ["0.0.0.0/0", "::/0"]
Endpoint = 194.41.113.64:443    → server: "194.41.113.64", port: 443
PersistentKeepalive = 25        → persistent-keepalive: 25
```
Plus `type: "wireguard"`, `udp: true`, `name`. The AWG params (`Jc…H4`) are
**optional** — a plain WireGuard `.conf` (no Amnezia lines) maps the same, just
without `amnezia-wg-option`. So Phase B1 supports plain WG for free.

mihomo field names verified against the wg docs: `private-key`, `public-key`,
`pre-shared-key`, `server`, `port`, `ip`, `ipv6`, `allowed-ips`, `dns`, `mtu`,
`persistent-keepalive`, `udp`, `amnezia-wg-option`.

Endpoint host may be a domain; `server` takes it verbatim (mihomo resolves). A
`[Peer]` may repeat — v1 supports one peer (the AmneziaWG case); multiple peers →
map the first, log a skip note (rare for client configs).

**Name.** The `.conf`/WireGuard format has **no standard name field** — the
convention (AmneziaVPN + most wrappers) is a comment line before `[Peer]`:
`#_Name = client1` or `# Name = client1`. So: parse the first comment matching
`/^\s*#\s*_?Name\s*=\s*(.+)$/mi` for the name; else default to
`<label> <endpoint-host>` (`AmneziaWG 194.41.113.64` / `WireGuard <host>`). The
real sample has no such comment → falls back to the endpoint host.

## Ingestion

### New source kinds — `wireguard` AND `amneziawg`
Add **both** `"wireguard"` and `"amneziawg"` to `sourceKindSchema`. The kind reflects
the protocol variant: a config carrying AmneziaWG obfuscation params
(`Jc/Jmin/Jmax/S1/S2/H1..H4`) → `"amneziawg"`; a plain WireGuard config → `"wireguard"`.
Both map to the same mihomo proxy `type: "wireguard"` (mihomo has no separate
amneziawg type — AmneziaWG is `wireguard` + `amnezia-wg-option`); the distinction
lives in the source `kind` + the node badge. Web labels: **"WireGuard"** / **"AmneziaWG"**.

### detectKind (parse.ts)
- **`.conf`**: text matching `/^\s*\[Interface\]/m` **and** containing `PrivateKey`
  (INI, not a scheme — a new non-URL branch, placed before the base64 fallback).
  Kind = `"amneziawg"` when the body has any AWG param
  (`/^\s*(Jc|Jmin|Jmax|S1|S2|H1|H2|H3|H4)\s*=/mi`), else `"wireguard"`.
- **`vpn://`**: `schemeOf` already yields `"vpn:"`. Add to the single-link handling
  a dedicated path: decode the blob, branch on `config_version`:
  - `1` → extract `containers[].awg` (or embedded `.conf`/last_config) → map → kind
    `"amneziawg"` (Amnezia's own configs are always AWG).
  - `2` → Phase B2 (throw a clear "hosted Amnezia (Free/Premium) needs the API
    spike — not yet supported" until B2 lands).
  - unknown → throw.

### New modules
- `parseWireguardConf(text): ProxyConfig` — INI parser for a `.conf`.
- `decodeAmneziaVpnLink(uri): { configVersion, conf?, apiConfig? }` — `vpn://` →
  base64url (pad) → 4-byte big-endian length prefix → `zlib.inflate` → JSON. Pure,
  unit-tested against the real v1 + v2 fixtures.
- `parseSingleLink`/`parseProxiesFromText` unaffected; ingest dispatches the two new
  kinds (`.conf` text and `vpn://`) to the WG path.

Since a `.conf` is a single-node source (not a subscription), it joins the
`SINGLE_LINK_KINDS`-style single path: `ingestSource` returns one proxy, `meta: null`.

## Badge (web)

A `wireguard` node has no `network`/`tls`/`reality` and isn't QUIC. Extend the badge
so it isn't mislabelled `WIREGUARD · TCP`:
- `transportBadge`: WireGuard family (`type === "wireguard"`) → **"UDP"** (its real
  transport), before the `security ? "TCP"` fallback.
- Optional security-slot: if the stored proxy has `amnezia-wg-option`, surface
  **"AmneziaWG"** as the security/variant badge → `WIREGUARD · UDP · AmneziaWG`;
  a plain WG node reads `WIREGUARD · UDP`. Needs `security`/variant to reach
  `NodeItem` — reuse the existing `proxyMeta` join (add an `amnezia` flag, or set
  `security: "amneziawg"`). Keep it honest: only when the option block is present.

Resolved: show the `AmneziaWG` variant badge → `WIREGUARD · UDP · AmneziaWG` when
`amnezia-wg-option` is present, else `WIREGUARD · UDP`.

## Files touched

- `packages/shared/src/schemas.ts` — `sourceKindSchema` += `"wireguard"`; possibly a
  `security` value or `amnezia` flag on `nodeItemSchema` for the badge.
- `packages/server/src/modules/sources/parse.ts` — `detectKind` `.conf` + `vpn://`
  branches; `parseWireguardConf`; `decodeAmneziaVpnLink`; wire into ingest.
- `packages/server/src/modules/sources/ingest.ts` — route `"wireguard"` (both `.conf`
  and `vpn://`) to the WG parser/decoder.
- `packages/server/src/modules/nodes/service.ts` — `proxyMeta` surfaces the AmneziaWG
  variant (if we do the variant badge).
- `packages/web/src/features/nodes/nodeView.ts` — WireGuard→UDP transport, AmneziaWG
  variant badge.
- `packages/web/src/features/sources/detectKind.ts` + `SourceRow.tsx` — "WireGuard"
  hint/label.

## Testing

- `parseWireguardConf` against the real AmneziaWG `.conf` (exact `ProxyConfig`
  incl. `amnezia-wg-option` numbers, `ip` mask stripped, `dns` array, endpoint split).
- A plain WG `.conf` (no AWG lines) → no `amnezia-wg-option`.
- `decodeAmneziaVpnLink` against a v1 fixture (structure) and the real v2 fixture
  (→ `configVersion: 2`, and B1 throws the "hosted not yet supported" error).
- `detectKind`: `[Interface]…` → `"wireguard"`; `vpn://…` → routes to the WG path.
- Badge: `type:"wireguard"` → `UDP`; with amnezia flag → `AmneziaWG`.
- e2e (manual, local docker): paste the real `.conf`, confirm the node appears as
  `WIREGUARD · UDP (· AmneziaWG)` and mihomo loads it (tunnels if the server is up).

## Resolved decisions

1. **Two kinds** — `wireguard` (plain WG) and `amneziawg` (has AWG obfuscation params).
   Both map to mihomo `type: wireguard`; the kind distinguishes them.
2. **Variant badge** — `WIREGUARD · UDP · AmneziaWG` when `amnezia-wg-option` present,
   else `WIREGUARD · UDP`.
3. **B1 first** (`.conf` + `vpn://` v1), **B2 (hosted v2 API) as a later spike**.
4. **Name** — from a `#_Name =` / `# Name =` comment if present, else
   `<label> <endpoint-host>`.

## Phase B2 — reverse-engineering findings (2026-07-07)

Decoded a real `vpn://` config_version 2 blob: it carries **no WG params and no
gateway URL** — only `api_config {service_type:"amnezia-free", service_protocol:"awg",
user_country_code}` + `auth_data {api_key:"<keyId>.<secret>"}`. The gateway is hardcoded
in the official client.

From `amnezia-vpn/amnezia-client` (dev): gateway = **`http://gw.amnezia.org:80/`**,
config request = **`POST <gateway>/v1/config`** (`subscriptionController.cpp` +
`gatewayController.cpp` + `secureAppSettingsRepository.cpp`). **This is NOT a plain
HTTP call** — it's a proprietary encrypted envelope:
- Header `X-Client-Request-ID: <uuid>`, content-type `application/json`.
- Body `{ keyPayload, apiPayload }` (both base64): the API JSON is AES-encrypted
  (`encryptAesBlockCipher`), and the AES key material is RSA-encrypted
  (`RSA_PKCS1_PADDING`) with the **AGW RSA public key** (a hardcoded client constant).
- The API JSON = `{ osVersion, appVersion, appLanguage, uuid, userCountryCode,
  serverCountryCode, serviceType, serviceProtocol, authData:{api_key}, publicKey }`,
  where `publicKey` is a **client-generated WireGuard public key** (client keeps the
  private key).
- The **response is encrypted** (decrypted with the same symmetric key/iv/salt) → JSON
  with `containers[].awg` and a `$WIREGUARD_CLIENT_PRIVATE_KEY` placeholder the client
  substitutes with its own private key.

**Implication:** B2 is materially bigger/fragiler than assumed — it means
reimplementing Amnezia's AES+RSA gateway transport in TS (extract the AGW RSA pubkey +
exact AES mode/iv/salt), generate a WG keypair, and decode an encrypted response.
Key/param rotation breaks it — exactly the staleness ADR-0001 cites for static `happ://`
decoders (solved there with the official-binary sidecar). Options: (a) reimplement the
encrypted protocol in TS (fragile); (b) a sidecar mirroring `happ-decoder` that runs
Amnezia's own logic (robust, more infra); (c) defer (YAGNI unless hosted Amnezia Free is
actually needed). Recommendation: **(c) defer** — revisit as a sidecar spike if needed.
