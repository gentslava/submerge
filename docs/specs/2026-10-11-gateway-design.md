# Gateway network profile

Status: implemented and verified locally; not deployed.

## Scope and persistence

Add an opt-in `gateway` network profile. Existing installations default to
`proxy`, with their current DNS and routing behavior. Store the validated profile
in SQLite under `networkProfile`; subscription refresh and restart read the same
object. A deployment JSON file seeds an absent setting only. Invalid stored data
must fail explicitly rather than silently revert to proxy mode. Protected tRPC
procedures and an operator CLI configure and inspect the profile. The
[native settings specification](2026-10-11-tun-settings-design.md) adds the
Proxy / TUN product flow and a Proxy-first prepared deployment.

## DNS and TUN

Gateway generates its own TCP/UDP DNS listener, fake-IP range and persisted cache,
and Linux TUN configuration with explicit device, route table/rule indices and
outbound interface. Upstream, bootstrap and proxy-endpoint resolvers never use
`system`. Local suffixes and reverse zones use a separate explicit LAN resolver
and return real IPs. Bootstrap resolvers use literal public IPs; local resolvers
must not point back to the gateway listener or an AdGuard forwarding loop.

## Routing

The gateway owns this precedence, independent of the Direct channel's position:

1. Local names, private networks, DNS/service addresses and VPN endpoint traffic.
2. Exact `notblocked` file rules to DIRECT.
3. Forced proxy file rules, managed domain rules, and existing proxy channels.
4. RU company file rules, configured RU zones/GeoSite, and RU GeoIP to DIRECT.
5. Existing additional Direct matchers, then the default VPN channel.

RU GeoIP resolves real addresses: no `no-resolve`. Missing nodes or an empty
channel pool yield REJECT, including the default selector; gateway never inserts
DIRECT into VPN selectors. Explicit local/DIRECT exceptions remain available.

Private lists are published by the existing deploy-key fetch service and mounted
read-only in both containers. Submerge neither holds the deploy key nor changes
the source files. `notblocked` is a domain text provider preserving the complete
published FQDN verbatim (including the existing `+.fully.qualified.domain` syntax).
No registrable-domain normalization or wildcard widening is allowed.

## Deployment and failure behavior

The standard Compose prepares both modes with persistent DB/config/cache mounts,
NET_ADMIN, /dev/net/tun, forwarding, a separate DNS port, private authenticated
Mihomo API, and a dedicated LAN/network namespace. A stable namespace holder
is shared by Submerge and Mihomo so engine restarts preserve API reachability and
the app inspects the actual TUN interface. Optional macvlan attaches
an explicitly configured LAN IP; it does not seize the host default route.
An optional test override provides project-scoped isolated mounts and ports.
Bootstrap generates its credential automatically through the existing durable
rotation journal, rejects internet traffic without a VPN pool, and authenticates the API from
the first engine start. No production routing or AdGuard change is in scope.
The namespace bootstrap installs a persistent LAN↔WAN forwarding guard before
starting the engine, then drops privileges. Engine stop or death cannot silently
fall through to raw kernel forwarding.

Gateway applies candidate YAML through Mihomo's inline reload API before replacing
the canonical file; invalid configurations preserve the previous file and return
an explicit application error. Readiness distinguishes liveness from operational
readiness, checks actual UDP/TCP DNS and real DNS resolution, TUN interface, active
mode/rules, loaded providers, available VPN pool and the last apply result. DNS
resolver checks use unique names in public and local zones so stale cached
answers cannot hide an outage; validated NXDOMAIN counts as a resolver response.
Linux failure tests run in an isolated namespace; readiness is not a claim that the LAN
router or upstream VPN has passed end-to-end acceptance.

References: [Mihomo TUN](https://wiki.metacubex.one/en/config/inbound/tun/),
[DNS](https://wiki.metacubex.one/en/config/dns/),
[rule resolution](https://wiki.metacubex.one/en/config/rules/#no-resolve).
