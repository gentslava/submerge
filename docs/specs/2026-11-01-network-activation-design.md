# Engine network activation checks

Status: implemented and verified locally; not merged or deployed.

Ordinary routing edits must not fail because Submerge probes its own DNS socket
while Mihomo runs in another container. Stored settings are desired state;
reloading the settings page never proves engine activation.

- Probe the actual Mihomo DNS listener over both UDP and TCP. With a remote
  controller, IPv4 wildcard (`0.0.0.0`) and loopback (`127.0.0.0/8`) listener
  addresses use the host from `MIHOMO_API`. Explicit non-loopback IPv4 listener
  addresses and the configured DNS port retain their existing behavior.
- Proxy activation requires the accepted engine runtime flags and real fake-IP
  DNS responses. Inspect local OS interfaces only when the controller is local;
  the app container's interfaces do not establish a remote engine's state.
- TUN activation still requires the actual local WAN/LAN/TUN interfaces. Separate
  namespaces cannot establish TUN activation. Missing interfaces, wrong mode,
  IPv6 or bad DNS responses remain explicit failures.
  Local interface proof is supported only through a loopback controller address;
  other endpoints fail explicitly as unproven topology. This also rejects aliases
  that might share a namespace; it never establishes that a remote TUN is broken.
- Report the specific failed check with bounded, fixed messages. Routine routing
  errors distinguish saved settings from unconfirmed activation. Mode-switch
  errors retain their context and include the same safe reason. Never return raw
  controller responses, credentials or arbitrary exception text to the browser.
  The TUN-state check reports the flag returned after loading the candidate:
  disabled when enabling, still enabled when disabling, or state not reported.
  Missing state is never described as a known disabled or enabled engine.
- Preserve candidate publication, previous-file retention and the recovery journal
  protocol. No claim of successful apply follows failed readiness, and no routing
  rule is weakened. Current namespaces/privileges remain installation concerns.

Qualify with failing tests, actual separate-container DNS probes and an isolated
real-engine config apply. The deployed user's exact failure remains unconfirmed
without its runtime evidence; do not claim production acceptance.

The README explains Proxy versus TUN capture, shared routing decisions, Docker
namespace/device/permission requirements and saved-versus-active configuration.
It includes the selective Docker/npm proxy scenario without changing host routes.

Controller DNS targeting converts IPv4-mapped IPv6 controller hosts to their
IPv4 address, including remote addresses. Native IPv6 controller URLs keep
brackets in `MIHOMO_API`; only the parsed socket target removes those brackets
and uses IPv6 UDP transport. Ordinary hostnames retain the existing
IPv4 UDP transport. The listener setting remains IPv4-only; explicit non-loopback
IPv4 listener addresses retain their existing behavior. Transport to a controller
does not change engine IPv6 flags, the A query or the required fake-IPv4 answers.
