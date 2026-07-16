import { healthHapp } from "../../clients/happDecoder.js";
import {
  getDelay,
  getExternalIpTrace,
  getProxies,
  getRuntimeConfig,
  getVersion,
  probeThroughProxy,
} from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import { db } from "../../db/client.js";
import { DiagnosticsService } from "./service.js";

export const diagnosticsService = new DiagnosticsService({
  db,
  getVersion,
  healthHapp,
  getProxies,
  getRuntimeConfig,
  getExternalIpTrace,
  getDelay,
  probeThroughProxy,
  proxyEndpointFallback: env.PROXY_ENDPOINT,
});
