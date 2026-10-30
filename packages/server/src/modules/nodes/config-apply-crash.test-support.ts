import { readFileSync, writeFileSync } from "node:fs";
import { defaultRouteSchema } from "@submerge/shared";
import * as yaml from "js-yaml";
import { z } from "zod";
import { env } from "../../config/env.js";
import { db } from "../../db/client.js";
import { readDefaultChannel, setDefaultRoute } from "../channels/service.js";
import { gatewayReadinessDeps } from "../gateway/readiness.js";
import { readGatewayRuntimeSettings, readNetworkProfile } from "../gateway/settings.js";
import {
  beginMihomoSecretRotation,
  restorePendingMihomoSecretRotation,
} from "../settings/secret-rotation.js";
import { readConfigApplyRecovery } from "./config-apply-journal.js";
import { applyConfig } from "./service.js";

const phase = z.enum(["staged", "reload", "replaced", "recover"]).parse(process.env.CRASH_PHASE);
const desiredRoute = defaultRouteSchema.parse(process.env.DESIRED_ROUTE);
const profile = readNetworkProfile(db);
const tun = profile.profile === "gateway";
const preferences = readGatewayRuntimeSettings(db);
const fakeAddress = preferences?.fakeIpRange.split("/")[0] ?? "198.19.0.1";
const accepted = z
  .object({ secret: z.string() })
  .parse(yaml.load(readFileSync(env.MIHOMO_CONFIG_PATH, "utf8")));
let activeSecret = accepted.secret;
let reloads = 0;
function crash(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not terminate the test process");
}

// These tests exercise durable application state and actual process termination.
// Engine/device acceptance is covered separately; the fake engine is deterministic.
gatewayReadinessDeps.runtime = async () => ({ mode: "rule", tun, ipv6: false });
gatewayReadinessDeps.interfaces = () => ({
  [preferences?.outboundInterface ?? "eth0"]: [{ address: "172.30.0.2" } as never],
  [preferences?.lanInterface ?? "lan0"]: [{ address: "172.31.0.2" } as never],
  ...(tun ? { [preferences?.tunDevice ?? "sm-gateway"]: [{ address: fakeAddress } as never] } : {}),
});
gatewayReadinessDeps.listener = async () => [fakeAddress];
globalThis.fetch = async (url, init) => {
  if (phase === "staged") crash();
  const supplied = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /u, "");
  if (supplied !== activeSecret) return Response.json({ message: "unauthorized" }, { status: 401 });
  if (String(url).includes("/version")) return Response.json({ version: "test-engine" });
  if (!String(url).includes("/configs")) throw new Error("Unexpected engine request");
  if (phase === "reload") crash();
  const body = z.object({ payload: z.string() }).parse(JSON.parse(String(init?.body)));
  activeSecret = z.object({ secret: z.string() }).parse(yaml.load(body.payload)).secret;
  reloads += 1;
  return new Response(null, { status: 204 });
};

try {
  readConfigApplyRecovery(db, env.MIHOMO_CONFIG_PATH);
  restorePendingMihomoSecretRotation(db);
  if (phase !== "recover") beginMihomoSecretRotation(db, "next-secret");
  const result = await applyConfig(db, undefined, undefined, {
    ...(phase === "recover"
      ? {}
      : {
          stageConfigMutation: () => {
            const previous = readDefaultChannel(db).defaultRoute;
            setDefaultRoute(db, desiredRoute);
            return () => setDefaultRoute(db, previous);
          },
          afterConfigActivationAttempt: () => {
            if (phase === "replaced") crash();
          },
          force: true,
        }),
  });
  if (phase !== "recover") throw new Error("Expected a process crash");
  writeFileSync(`${env.MIHOMO_CONFIG_PATH}.result`, JSON.stringify({ result, reloads }));
} finally {
  db.$client.close();
}
