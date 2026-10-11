import { readdirSync } from "node:fs";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { createGatewayDraft, type NetworkProfile } from "@submerge/shared";
import { getRuntimeConfig } from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { applyConfig, collectActiveRoutingInputs, readMihomoSecret } from "../nodes/service.js";
import { checkGatewayReadiness } from "./readiness.js";
import {
  assertGatewaySecurity,
  assertIndependentLocalDns,
  gatewayApplyState,
  readGatewayPreferences,
  readGatewayRuntimeSettings,
  readNetworkProfile,
  validatePrivateLists,
  writeNetworkProfile,
} from "./settings.js";

export function getGatewayConfiguration(
  db: Db,
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
) {
  const profile = readNetworkProfile(db);
  const saved = readGatewayPreferences(db);
  const tun = saved ?? createGatewayDraft();
  let availableLists: string[] = [];
  try {
    availableLists = readdirSync(env.GATEWAY_LISTS_PATH)
      .filter((file) => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.txt$/u.test(file))
      .sort()
      .slice(0, 128);
  } catch {
    // No mounted lists is valid until a list is configured.
  }
  if (!saved) {
    for (const [file, target, name] of [
      ["notblocked.txt", "notblocked", "notblocked"],
      ["custom.txt", "proxy", "custom"],
    ] as const) {
      if (availableLists.includes(file))
        tun.privateLists.push({ file, target, name, behavior: "domain" });
    }
  }
  let listsOk = true;
  try {
    validatePrivateLists(tun);
  } catch {
    listsOk = false;
  }
  const lanAddress =
    interfaces[tun.lanInterface]?.find(
      (entry) =>
        entry.family === "IPv4" &&
        !entry.internal &&
        !/^(?:0\.|127\.|169\.254\.|198\.(?:18|19)\.)/u.test(entry.address) &&
        Number(entry.address.split(".")[0]) < 224,
    )?.address ?? null;
  const dnsAddress =
    env.GATEWAY_LAN_ACCESS === "lan" &&
    lanAddress &&
    (tun.dnsListen === "0.0.0.0" || tun.dnsListen === lanAddress)
      ? `${lanAddress}:${tun.dnsPort}`
      : null;
  return {
    profile,
    tun,
    availableLists,
    prerequisites: [
      { name: "admin-password", ok: (env.ADMIN_PASSWORD?.length ?? 0) >= 16 },
      { name: "engine-secret", ok: readMihomoSecret(db).length >= 16 },
      { name: "network", ok: Boolean(lanAddress && interfaces[tun.outboundInterface]?.length) },
      { name: "private-lists", ok: listsOk },
      // The app shares the engine namespace, not its device or capabilities.
      // Only successful TUN activation can prove the engine deployment supports it.
      { name: "tun-access", ok: null },
    ],
    connection: {
      lanAddress,
      dnsAddress,
      dnsPort: tun.dnsPort,
      access: env.GATEWAY_LAN_ACCESS,
    },
  };
}

export async function configureGateway(db: Db, profile: NetworkProfile) {
  if (profile.profile === "gateway") {
    assertGatewaySecurity(readMihomoSecret(db));
    assertIndependentLocalDns(profile);
    validatePrivateLists(profile);
  }
  // Keep desired settings after an activation failure, so the operator can retry.
  // The canonical engine file is published only after candidate activation succeeds.
  return applyConfig(db, undefined, undefined, {
    force: true,
    stageConfigMutation: () => {
      writeNetworkProfile(db, profile);
      return () => {};
    },
  });
}

export async function gatewayReadiness(db: Db) {
  try {
    const profile = readNetworkProfile(db);
    const preferences = readGatewayRuntimeSettings(db);
    if (!preferences) {
      const runtime = await getRuntimeConfig();
      const ok = runtime.tun !== true;
      return { profile: "proxy" as const, ready: ok, checks: [{ name: "runtime", ok }] };
    }
    const defaultChannel = collectActiveRoutingInputs(db).inputs.find(
      (channel) => channel.isDefault,
    );
    const group = defaultChannel?.target === "proxy" ? defaultChannel.groupName : "PROXY";
    return checkGatewayReadiness(
      preferences,
      gatewayApplyState(db),
      group,
      undefined,
      profile.profile === "gateway",
    );
  } catch {
    return {
      profile: "gateway" as const,
      ready: false,
      checks: [{ name: "configuration", ok: false }],
    };
  }
}
