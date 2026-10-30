import { healthHapp } from "../../clients/happDecoder.js";
import {
  getDelay,
  getExternalIpTrace,
  getProxies,
  getRules,
  getRuntimeConfig,
  getVersion,
  probeThroughProxy,
} from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import { db } from "../../db/client.js";
import { readConfigApplyState } from "../nodes/service.js";
import { DiagnosticsService } from "./service.js";

export const diagnosticsService = new DiagnosticsService({
  db,
  getVersion,
  healthHapp,
  getProxies,
  getRuntimeConfig,
  getRules,
  readConfigApplyState,
  getExternalIpTrace,
  getDelay,
  probeThroughProxy,
  proxyEndpointFallback: env.PROXY_ENDPOINT,
});
