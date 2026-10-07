# Single-node configuration import

Status: Implemented and verified locally (automatic detection, no mode switch); prepared for PR to `master`, not deployed.

## Goal

Import exactly one static proxy node from pasted text or a local configuration file,
including a full Xray/V2Ray client configuration containing one proxy outbound plus
`freedom` and `blackhole` service outbounds. Importing a node must not replace
submerge's DNS, inbounds, routing, policy, or local proxy settings.

## Agreed behavior

- Automatically recognize inline JSON/YAML configs before subscription URL extraction,
  including configs containing DNS or transport URLs. No mode switch or new API input.
- Accept Xray/V2Ray and sing-box JSON (a complete config or one outbound),
  and Clash/mihomo YAML or JSON (one proxy object or a config with one proxy).
- Require exactly one proxy candidate. Ignore only recognized service outbounds
  (`freedom`, `blackhole`, `direct`, `block`, `dns`). Reject multiple candidates,
  unsupported proxy outbounds, invalid credentials/endpoints, and malformed input.
  Do not silently choose the first server or user from a multi-node outbound.
- Existing single-node URI / WireGuard imports keep their protocol kinds. HTTP URLs,
  Happ links, deep-links, and base64 lists keep the existing subscription path.
  Remote subscription bodies retain multi-node support; inline JSON/YAML configs
  require one node instead of becoming inline subscriptions.
- Retain the node name (`remarks`, `tag`, or `name`) and supported transport / TLS /
  Reality options. Require real values in the supplied template; placeholder values
  and an unquoted placeholder port are invalid input.
- Persist these imports with source kind `node`, one proxy, null subscription metadata
  and identity, and HWID off. They use existing enable/remove/reorder behavior and
  are excluded from scheduled refresh. Manual reparse retains single-node semantics.
- Hide HWID for automatically recognized structured configs. Accept `.json`, `.yaml`, `.yml`, `.conf`, `.txt`
  uploads and drops through the same text field. Preserve text after a validation failure.
- Show a static-node badge and truthful static-config information in the source row.

## Boundaries

JSON conversion uses the currently implemented Xray VLESS/VMess/Trojan and sing-box
VLESS/VMess/Trojan/Shadowsocks/Hysteria2/TUIC converters, with explicit validation and
TCP (`raw` maps to TCP), WebSocket and gRPC options. Other JSON proxy protocols,
transports, sing-box plugins, chaining and Xray mux fail explicitly; use an engine-native mihomo proxy
for connection options outside this converter subset. Native types: VLESS, VMess,
Trojan, Shadowsocks, Hysteria2, TUIC, WireGuard, SOCKS5 and HTTP.

WireGuard supports simplified syntax or exactly one full-syntax peer. Validate local
IPv4/IPv6 addresses or CIDRs, 32-byte base64 keys, nonempty full-syntax `allowed-ips`,
and optional reserved bytes. Names and passwords remain separate validation concerns:
passwords are opaque and preserve all characters. JSON/YAML mappings, flow mappings
and one-entry sequences are accepted.

Xray `method` takes precedence over `network`; normalize `raw`/`tcp` and
`ws`/`websocket` aliases. WebSocket `host` overrides a legacy Host header. gRPC
`multiMode` and explicit `authority` are rejected because this converter cannot
preserve their routing behavior. Sing-box TLS supports `enabled`, `server_name`,
`insecure`, `alpn`, `utls` and `reality`; other TLS authentication/verification
options fail explicitly, including client certificates and certificate pins.

Format references checked: [Xray VLESS](https://xtls.github.io/en/config/outbounds/vless.html),
[mihomo VLESS](https://wiki.metacubex.one/en/config/proxies/vless/),
[sing-box VLESS](https://sing-box.sagernet.org/configuration/outbound/vless/),
[mihomo WireGuard](https://wiki.metacubex.one/en/config/proxies/wg/).

Use the current source storage and node configuration pipeline. No DB migration,
external converter, new dependency, full client-config import, or automatic selection
from multi-node configs is needed. Existing subscription behavior remains compatible.

## Verification

- TDD for the provided Xray VLESS + Reality shape, complete and bare JSON/YAML,
  existing single links / `.conf`, cardinality, malformed data, unsupported proxy candidates,
  and absence of network/decoder work.
- Service integration: persistence, config generation, manual reparse, enable/remove,
  and scheduler exclusion.
- Form tests and browser evidence: paste / file / drop, automatic recognition, success/error,
  populated/empty sources, real single-node request shape, no horizontal overflow at
  320/390/425/768/1024/1440 and the existing Sources container boundary.
- Visual reference: Sources `gm1vM` (1440 x 1024, dark) and `ce3MH` (390, dark),
  retaining the measured form layout and existing design tokens.
- Run `pnpm verify:static`, incremental independent `/code-review`, and final independent
  `/code-review`; resolve findings. Commit and push only on an explicit user request.
