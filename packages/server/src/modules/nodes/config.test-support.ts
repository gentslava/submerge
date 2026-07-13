import {
  type ChannelPolicy,
  DEFAULT_SPEED_POLICY,
  type Proxy as ProxyConfig,
} from "@submerge/shared";
import { buildMultiConfig } from "./multiConfig.js";

export function buildDefaultConfig(
  proxies: ProxyConfig[],
  policy: ChannelPolicy = DEFAULT_SPEED_POLICY,
  secret = "",
): string {
  return buildMultiConfig(
    [
      {
        target: "proxy",
        id: "default",
        groupName: "AUTO",
        isDefault: true,
        policy,
        domains: [],
        cidrs: [],
        proxies,
      },
    ],
    secret,
  );
}
