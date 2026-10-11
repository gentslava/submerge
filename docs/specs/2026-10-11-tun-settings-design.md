# Native Proxy / TUN settings

Status: implemented and verified locally; not deployed.

Submerge remains one application. Settings provides a two-option segmented
connection mode: Proxy (existing default) and TUN. TUN retains the HTTP/SOCKS
proxy listener. Both inputs use the same channels and routing policy. This is a
server-side TUN; it does not silently change clients' routes or host networking.

The prepared Docker deployment also starts in Proxy. It uses independent public
DNS and fail-closed routing before first TUN setup; no local DNS is guessed and
TUN remains disabled. A profile JSON is an optional first-install seed; ordinary
setup happens in Settings. Missing local DNS is explicitly not ready for TUN.

Deployment correction agreed on 2026-10-11: the regular `docker-compose.yml`
must prepare both capture modes by default. No separate gateway profile,
environment file, profile JSON, or manually chosen engine credential is required
to select TUN. Internal bootstrap services prepare volume ownership, an isolated
stable namespace, the forwarding guard, and engine-only TUN permissions. The API
credential is generated automatically and persisted through the existing rotation
journal; an existing strong credential is retained. Proxy remains usable with the
existing optional-admin localhost setup; activating TUN still requires protected
administration. Existing installations receive the deployment change once,
without mode-specific Compose edits. Test isolation remains an optional override.

The existing Indigo Console Settings frame (`w6qeY`, mobile `r1RQ0O`) owns the
visual contract. Replace its obsolete three-option gateway exploration with
Proxy / TUN, using the existing segmented control, labelled rows, field widths,
tokens and responsive container rules. The native section appears first in
Settings so connection mode is discoverable.

Selecting TUN opens an inline configuration form. The only required first-time
input is a separate local DNS resolver. Public upstream/bootstrap DNS and TUN
parameters have safe defaults. Existing deployment-seeded settings are reused.
Advanced parameters stay collapsed, are validated, and preserve private-list
definitions without requiring JSON editing. Match the existing Settings autosave
behavior: mode changes apply immediately when valid; text fields apply on blur,
and selects/list edits apply immediately. First TUN selection with no local DNS
opens setup; supplying valid DNS and leaving the field activates TUN automatically.
There is no separate Apply button. Errors remain visible, with an explicit Retry
only after a failed activation. Invalid field drafts never replace accepted config.

TUN preferences are retained separately when switching back to Proxy. Once
configured, switching capture modes does not change DNS policy, private lists,
RU precedence or fail-closed routing. Accepted engine state and desired saved
mode are distinguished when activation fails. Returning to Proxy must verify
that the engine actually disabled TUN before reporting success.

Protected configuration/status procedures expose required deployment/security
checks, actual readiness, and copyable connection details. The UI shows a short
connection guide: use the shown server LAN address as the selected client's
gateway and use its reachable DNS address. It must not present loopback or
container-only addresses as generally reachable from a physical LAN. The standard
installation prepares Docker permissions automatically. Choosing a physical LAN
attachment is a one-time deployment task; the app reports missing prerequisites
without pretending to grant them itself.

Validation covers Proxy, first-time TUN, accepted TUN, retained preferences,
failed apply, unavailable deployment, empty VPN, DNS/list/TUN faults, load errors,
collapsed/expanded advanced settings, keyboard focus, light/dark and
320/390/425/768/1024/1440 plus the existing Settings container boundary. Static,
focused browser and independent incremental/final reviews are mandatory.
