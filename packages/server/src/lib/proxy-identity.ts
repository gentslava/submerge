import { isDeepStrictEqual } from "node:util";
import type { Proxy as ProxyConfig } from "@submerge/shared";

// A socket address is not a proxy identity: providers may emit several profiles
// on one server:port with different credentials, TLS/Reality, or transport fields.
// Compare the complete validated config so only truly identical outbounds collapse.
export function sameProxy(left: ProxyConfig, right: ProxyConfig): boolean {
  return isDeepStrictEqual(left, right);
}
