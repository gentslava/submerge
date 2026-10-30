# Native Proxy / TUN settings

Status: implemented and verified locally; not deployed.

Settings has one Proxy / TUN segmented choice. Proxy is the default. Selecting
another mode applies immediately, displays progress, and disables duplicate
requests. The confirmed selection changes only after successful activation.
Failure keeps the previous setting and shows one actionable error. No Apply or
Check button, readiness checklist, device guide or advanced engine form.
TUN retains HTTP/SOCKS; both inputs use exactly the same routing channels.

DNS has its own optional home-network resolver field, with nas.lan as the example.
An empty field is valid in either mode. Public upstream and bootstrap DNS,
fake-IP, device, route table and engine credentials are generated automatically.
DNS edits save on blur or Enter and validate IP addresses before submission.

Routing owns Direct domains, local-network presets, CIDRs, GeoSite, GeoIP and
rule lists. Published read-only files are selected in the existing list editor.
Default has an explicit list section for forced VPN exceptions before Direct.
No route setting is duplicated in the connection-mode form or network record.
Legacy route settings migrate once into channels; changing capture mode never
resets subsequent route edits. One protected SQLite record stores mode and DNS.
The full legacy parser is server-private upgrade data, not a public input.

The standard Compose prepares both modes during installation. Internal bootstrap
has no user commands, profile files or gateway environment flags. Existing
installations need the complete deployment update once to gain Docker devices
and ports; ordinary mode changes then happen entirely inside the application.
The engine API stays private and authenticated. Empty VPN pools remain REJECT.

Indigo Console tokens, rows and segmented controls remain the visual contract.
References: w6qeY/oXxu8 at1440×1024 dark, r1RQ0O/Q3sToj at390px; adapt the
approved structure without preserving the rejected explanatory blocks.
Browser evidence covers all required widths, both themes, keyboard, loading,
errors, mode switching and published-list editing with zero retries.
The user explicitly requires direct authorship and three author review passes.
