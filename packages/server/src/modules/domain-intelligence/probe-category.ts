export const PROBE_CATEGORIES = [
  "http_response",
  "dns_failure",
  "unsafe_address",
  "ipv6_unavailable",
  "unsafe_redirect",
  "redirect_limit",
  "connect_timeout",
  "tls_timeout",
  "tls_handshake_reset",
  "connection_reset_before_http",
  "tls_error",
  "network_error",
  "total_timeout",
  "proxy_auth_failure",
  "route_proof_failure",
  "infrastructure_error",
] as const;

export type ProbeCategory = (typeof PROBE_CATEGORIES)[number];

export const QUALIFYING_DIRECT_FAILURE_CATEGORIES = [
  "connect_timeout",
  "tls_timeout",
  "tls_handshake_reset",
  "connection_reset_before_http",
  "dns_failure",
] as const satisfies readonly ProbeCategory[];

export const FAILURE_CATEGORIES_WITH_HTTP_STATUS = [
  "unsafe_redirect",
  "redirect_limit",
] as const satisfies readonly ProbeCategory[];
