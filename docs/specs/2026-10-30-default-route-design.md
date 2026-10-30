# Default route selection

Status: implemented and verified locally; not merged or deployed.

The admin can choose whether unmatched traffic goes directly from the server or
through the Default channel's VPN pool. This supports production services whose
source IP is allowlisted: only explicitly matched destinations such as Docker Hub
and npm use VPN, without maintaining a list of insurance API destinations.

- Routing → Default exposes a segmented **Напрямую / Через VPN** choice. The
  collapsed card states the selected route. Existing and new installations retain
  the current VPN default until the admin explicitly selects Direct.
- Persist `defaultRoute: proxy | direct` on the Default row, independently of the
  system Direct channel and connection mode. Only Default can change this value.
- Direct default ends with `MATCH,DIRECT` in legacy Proxy, prepared Proxy and TUN.
  All existing explicit rules retain their order and targets, including Default's
  Always VPN lists and managed VPN rules. Default's VPN pool/policy remain saved
  and available to those lists and when switching back.
- An explicit VPN channel with an empty pool rejects traffic in Direct-default
  mode; it must never silently fall through to Direct, even with zero exit nodes.
- Changing the route applies immediately. Pending changes disable duplicate
  selections; activation failure restores the saved route and accepted config and
  reports an error. A lost engine response cannot be described as confirmed active.
- Readiness accepts the selected final rule and does not require a VPN pool for
  a purely Direct configuration. Diagnostics attribute unmatched traffic to Direct.
- No host routes, Docker settings, dependencies, public deployment, or existing
  routing preferences change as part of this task.

UI uses the existing Indigo Console `Segmented` control and channel editor row:
`oXxu8/KvheA` (3 px inset/gap, 7×13 px option padding, text-sub, md/sm radii),
and Routing frames `lYrng`, `HXRTv`. No new tokens. The new row adapts these existing
controls; the original Pencil app is unavailable, so design values are read from
the tracked JSON. The user approved this choice in the task conversation.
