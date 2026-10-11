# Gateway deployment and acceptance

Gateway is opt-in. The regular Compose file and an absent `networkProfile`
retain proxy mode. Use the standalone gateway file, a unique Compose project and
new volumes for testing. This procedure does not switch AdGuard, DHCP,
production clients or the host default route.

## Prepare the isolated stack

Use Linux with `/dev/net/tun` and Docker Compose >=2.36. Docker Desktop can run
the container-network tests; real LAN macvlan requires Linux.

```sh
cp .env.gateway.example .env.gateway
```

Set `GATEWAY_ADMIN_PASSWORD` and `GATEWAY_MIHOMO_SECRET` to distinct random values
of at least 16 characters. Set `GATEWAY_LISTS_DIR` to the existing fetch service's
**published directory**, containing readable `notblocked.txt` and `custom.txt`.
The sample path is an installation example: verify the actual path and current
service result. Keep the deploy key with the existing fetch service, outside the
mounted published directory. Both containers mount the published
directory read-only. Mount the directory, not individual files: native file
providers watch atomic replacements and rearm their watcher.
On Linux, uid999 must be able to traverse the mounted directory and read its
files; grant read/traverse access without making the published files writable.

The stack starts in **Proxy** with TUN disabled. Open Settings → Connection mode,
select TUN and set Local DNS. Changes apply automatically when leaving a valid
text field; mode/select changes apply immediately. Choose a resolver serving LAN zones independently. An
AdGuard used here must answer those zones locally and must not forward them back
to Submerge. Public and bootstrap DNS use explicit public IPs, never `system`.
Add custom LAN suffixes under Advanced settings; they return real IPs and route DIRECT.
Public DNS and fail-closed routing are prepared before first setup. No local
resolver is guessed; missing local DNS stays explicitly not ready for TUN.
`config/gateway.example.json` is an optional first-install seed for automated
deployments; it is not required for the normal Settings flow.

The sample owns `198.19.0.0/16`, `sm-gateway`, route table/rule 20220 and a separate
test LAN. Confirm the current contour uses a different fake-IP range. Every
project owns its DB, config, cache, namespace and routes. Only Mihomo receives
TUN. Both processes join a stable namespace holder, so an engine
restart preserves Submerge's API and its view of the recreated TUN. The holder
uses NET_ADMIN only to install a persistent nft forwarding guard, then drops to
uid999 with no effective capabilities. It has no application data or secrets.
The guard drops raw LAN↔WAN forwarding when TUN is absent; engine DIRECT/VPN
sockets remain allowed. It lives in a separate table that engine cleanup cannot
remove. Mihomo retains NET_ADMIN and is the only container given `/dev/net/tun`.
The namespace starts with forwarding disabled. Only after the guard healthcheck
passes does Docker enable forwarding for the engine in that same namespace.
A network-isolated one-shot root initializer fixes ownership of the three named
volume roots, then bootstrap and the server run as uid999. It does not mount or
change the published lists.
The Docker service uid999 is excluded from TUN so subscription and control-plane
downloads can bootstrap with an empty VPN pool. LAN ingress remains captured.

```sh
docker compose --env-file .env.gateway -p submerge-gateway-test \
  --profile gateway -f docker-compose.gateway.yml config --quiet
docker compose --env-file .env.gateway -p submerge-gateway-test \
  --profile gateway -f docker-compose.gateway.yml build gateway-init
docker compose --env-file .env.gateway -p submerge-gateway-test \
  --profile gateway -f docker-compose.gateway.yml up -d --no-build
```

Defaults: panel `127.0.0.1:13000`, mixed proxy `127.0.0.1:17890`, TCP/UDP DNS
`127.0.0.1:11053` → listener 1053. The authenticated engine API is not published.
Put a remote panel behind TLS and set `GATEWAY_COOKIE_SECURE=true`. For AdGuard,
bind DNS to a specific trusted address and allow intended clients only. Changing
the internal `dnsPort` also requires changing Compose's DNS target ports.

## Routing and private lists

Precedence: local/service → notblocked DIRECT → forced proxy → RU companies,
zones and GeoIP DIRECT → additional Direct matchers → default VPN. The catch-all
uses the default channel pool. Empty pools select REJECT, and connection failures
have no DIRECT member to fall back to.

`notblocked` preserves the complete published FQDN, including
`+.docs.google.com`; it is never converted to `+.google.com`. Add a company list
using its actual published filename under Settings → TUN → Advanced settings →
Published lists. Select the file, its route and format; no JSON editing is needed.

Lists support nonempty `domain`, `classical` and `ipcidr` text. Apply checks native
provider metadata and complete rule counts before publishing the candidate.
Native file updates are checked by readiness against current published entries.
The fetch service must publish validated complete files atomically. An unhealthy
result means stop sending test clients through this stack; Docker health status
does not itself disable forwarding.

RU GeoIP resolves real addresses under fake-IP. Generic private CIDRs use
`no-resolve`; explicit `serviceCidrs` resolve so service FQDNs can beat proxy
exceptions. Explicit proxy rules precede broad RU zones.

## Settings and readiness

JSON and the engine env secret seed SQLite once; later file/env edits do not
replace confirmed settings. Rotate the engine secret through protected Settings
and its recovery journal, rather than changing `GATEWAY_MIHOMO_SECRET`. A reset
through Settings to an empty secret captures the current deployment secret in
SQLite; subsequent env edits still do not replace the confirmed credential.
Protected tRPC procedures are `gateway.get`, `gateway.configuration`, `gateway.set` (complete typed profile), and
`gateway.readiness`. Generic `settings.set` cannot bypass validation. Refresh and
restart read the saved profile. Switching back to Proxy keeps TUN preferences
and the same DNS/routing rules; only traffic capture changes. The connection
guide displays a real LAN address only for a LAN attachment; default bridge
addresses are not presented as physical-LAN gateways. TUN device/capability
availability is unverified until the engine actually activates it.
For optional offline configuration, provide a validated seed JSON and stop Submerge first:

```sh
docker compose --env-file .env.gateway -p submerge-gateway-test \
  --profile gateway -f docker-compose.gateway.yml stop submerge
docker compose --env-file .env.gateway -p submerge-gateway-test \
  --profile gateway -f docker-compose.gateway.yml run --rm --no-deps \
  gateway-init node dist/gateway-cli.js configure /gateway/profile.json
docker compose --env-file .env.gateway -p submerge-gateway-test \
  --profile gateway -f docker-compose.gateway.yml up -d submerge
```

Inspect readiness (exit code 1 means not ready):

```sh
docker compose --env-file .env.gateway -p submerge-gateway-test \
  --profile gateway -f docker-compose.gateway.yml exec submerge \
  node dist/gateway-cli.js readiness
```

Apply verifies real TUN, LAN/WAN interfaces and both DNS sockets before publishing;
a 204 response alone is insufficient. Readiness requires accepted config, rule mode, IPv6 disabled, real TUN interface,
TCP/UDP fake-IP answers, public real DNS, local DNS (valid NXDOMAIN is acceptable),
fresh public/local query responses that bypass warmed DNS cache,
complete private providers, a VPN pool and successful VPN egress. `/healthz`
remains liveness. No nodes is expected to be unhealthy on first install: add
sources through the protected panel.

Mihomo may retain its controller secret until process restart. A secret change
can therefore be saved with activation pending. Restart the gateway's Mihomo
and Submerge together; the journal retains both credentials until the new secret
authenticates against the published file. Rejected or ambiguous reload does not
discard recovery.

## LAN acceptance and rollback

The default LAN is a separate bridge without IP masquerading. Docker's
`internal: true` firewall drops off-subnet frames before a container gateway,
so it cannot be used for this router. Attach only a disposable test client and set its
default route to `GATEWAY_LAN_IP` inside that client's namespace. For real LAN,
set an unused IP, subnet, router and parent, and add
`-f docker-compose.gateway.lan.yml`. Its macvlan is a separate address: clients
must opt into it. Host↔macvlan communication normally needs a separate host shim;
test from a LAN client. Preserve IPv6 isolation on clients; DHCP/router IPv6
migration is separate.

Before switching AdGuard or production clients, verify local DNS/name,
notblocked FQDN and sibling, forced proxy on a RU domain, RU company/GeoSite/GeoIP,
foreign default VPN and actual egress IP. Test two list replacements, VPN outage,
all nodes removed, missing TUN and invalid config. Reject failed readiness. Keep
the previous client DNS and route; rollback restores those first, then stops this
project with `docker compose ... down` (omit `-v` to preserve state).

Developer verification:

```sh
pnpm verify:static
docker build -t submerge-gateway:verify .
GATEWAY_INTEGRATION=1 pnpm -F @submerge/server test src/modules/gateway/gateway.integration.test.ts
```

The native tests use synthetic DIRECT/VPN endpoints in fresh networks and the
production namespace guard. They verify TUN, local and intercepted DNS,
forced-RU/default routing, exact FQDNs, two atomic replacements, VPN outage,
invalid reload, empty pools, disabled TUN and secret restart. The standalone
Compose test covers fresh volumes, real RU geodata, auth, readiness, persistence,
engine restart and raw WAN TCP/UDP audits after stop and SIGKILL, then removes
resources. It also verifies API access after a protected blank-secret reset and
an env change while retaining the database, and DNS failure after warming the
real resolver cache. It does not certify an
upstream subscription, physical LAN or macvlan.
