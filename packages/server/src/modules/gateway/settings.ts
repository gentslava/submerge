import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { resolve, sep } from "node:path";
import {
  createGatewayDraft,
  type GatewayProfile,
  gatewayProfileSchema,
  type NetworkProfile,
  networkProfileSchema,
} from "@submerge/shared";
import { eq } from "drizzle-orm";
import * as yaml from "js-yaml";
import { z } from "zod";
import { getRuleProviders, type RuleProvidersResponse } from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { settings } from "../../db/schema.js";
import { getSetting, setSetting } from "../settings/service.js";

export const NETWORK_PROFILE_KEY = "networkProfile";
const APPLY_STATE_KEY = "internal.gatewayApplyState";
const PREFERENCES_KEY = "internal.gatewayPreferences";

export function readNetworkProfile(db: Db): NetworkProfile {
  const row = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, NETWORK_PROFILE_KEY))
    .get();
  if (!row) return { profile: "proxy" };
  try {
    const value = getSetting(db, NETWORK_PROFILE_KEY);
    if (value === undefined) throw new Error("invalid encoding");
    return networkProfileSchema.parse(JSON.parse(value));
  } catch {
    throw new Error("Invalid persisted network profile; repair networkProfile explicitly");
  }
}

export function writeNetworkProfile(db: Db, profile: NetworkProfile): void {
  const validated = networkProfileSchema.parse(profile);
  db.transaction(() => {
    setSetting(db, NETWORK_PROFILE_KEY, JSON.stringify(validated));
    if (validated.profile === "gateway") setSetting(db, PREFERENCES_KEY, JSON.stringify(validated));
  });
}

export function readGatewayPreferences(db: Db): GatewayProfile | undefined {
  const active = readNetworkProfile(db);
  if (active.profile === "gateway") return active;
  const row = db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, PREFERENCES_KEY))
    .get();
  if (!row) return undefined;
  try {
    const value = getSetting(db, PREFERENCES_KEY);
    if (value === undefined) throw new Error("invalid encoding");
    return gatewayProfileSchema.parse(JSON.parse(value));
  } catch {
    throw new Error("Invalid persisted TUN preferences; repair explicitly");
  }
}

export function seedNetworkProfile(
  db: Db,
  path: string | undefined = env.GATEWAY_PROFILE_FILE,
): void {
  if (
    db
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.key, NETWORK_PROFILE_KEY))
      .get()
  ) {
    readNetworkProfile(db);
    return;
  }
  if (path)
    writeNetworkProfile(db, networkProfileSchema.parse(JSON.parse(readFileSync(path, "utf8"))));
}

export function readGatewayRuntimeSettings(db: Db): GatewayProfile | undefined {
  return readGatewayPreferences(db) ?? (env.GATEWAY_DEPLOYMENT ? createGatewayDraft() : undefined);
}

export function assertGatewaySecurity(secret: string): void {
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16 || secret.length < 16) {
    throw new Error("Gateway requires ADMIN_PASSWORD and MIHOMO_SECRET of at least 16 characters");
  }
}

export function gatewayApplyState(db: Db): "applied" | "failed" | "unknown" {
  const value = getSetting(db, APPLY_STATE_KEY);
  return value === "applied" || value === "failed" ? value : "unknown";
}

export function seedGatewayMihomoSecret(db: Db, effectiveSecret: string): void {
  if (getSetting(db, "mihomoSecret")) return;
  if (effectiveSecret.length < 16)
    throw new Error("Gateway requires a strong confirmed engine secret");
  // Environment is a first-install seed, never a restart-time auth rotation.
  setSetting(db, "mihomoSecret", effectiveSecret);
}

export function validateGatewayStartup(db: Db, candidateSecret?: string): void {
  if (readGatewayRuntimeSettings(db)) {
    const confirmed = getSetting(db, "mihomoSecret") || env.MIHOMO_SECRET;
    const secret = candidateSecret ?? confirmed;
    const acceptedTun = existsSync(env.MIHOMO_CONFIG_PATH)
      ? z
          .object({ tun: z.object({ enable: z.boolean().optional() }).optional() })
          .parse(yaml.load(readFileSync(env.MIHOMO_CONFIG_PATH, "utf8"))).tun?.enable === true
      : false;
    if (readNetworkProfile(db).profile === "gateway" || acceptedTun) assertGatewaySecurity(secret);
    else if (secret.length < 16)
      throw new Error("Prepared deployment requires a strong engine secret");
    if (secret === confirmed) seedGatewayMihomoSecret(db, secret);
  }
}

export function assertIndependentLocalDns(
  profile: GatewayProfile,
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
): void {
  const ownAddresses = new Set(
    Object.values(interfaces).flatMap(
      (addresses) => addresses?.map((address) => address.address) ?? [],
    ),
  );
  for (const resolver of profile.localResolvers) {
    const [host, rawPort] = resolver.split(":");
    const port = Number(rawPort ?? 53);
    if (
      port === profile.dnsPort &&
      (host === profile.dnsListen ||
        (profile.dnsListen === "0.0.0.0" && ownAddresses.has(host ?? "")))
    ) {
      throw new Error("Local DNS resolver points back to the gateway listener");
    }
  }
}

export function assertPrivateProvidersLoaded(
  profile: GatewayProfile,
  counts: Record<string, number>,
  response: RuleProvidersResponse,
): void {
  for (const list of profile.privateLists) {
    const name = `gateway-${list.name}`;
    const provider = response.providers[name];
    if (
      !provider ||
      provider.ruleCount !== counts[name] ||
      provider.behavior.toLowerCase() !== list.behavior ||
      !["text", "textrule"].includes(provider.format.toLowerCase()) ||
      provider.vehicleType.toLowerCase() !== "file"
    ) {
      throw new Error(`Gateway list is incomplete or incompatible: ${list.name}`);
    }
  }
}

export function recordGatewayApply(db: Db, state: "applied" | "failed"): void {
  setSetting(db, APPLY_STATE_KEY, state);
}

export async function waitForPrivateProvidersLoaded(
  profile: GatewayProfile,
  counts: Record<string, number>,
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (true) {
    const response = await getRuleProviders(
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    );
    try {
      assertPrivateProvidersLoaded(profile, counts, response);
      return;
    } catch (error) {
      // Mihomo acknowledges reload before its provider goroutines finish. A
      // populated but incomplete provider is a validation failure, not startup.
      const initializing = profile.privateLists.some(
        (list) => !response.providers[`gateway-${list.name}`]?.ruleCount,
      );
      if (!initializing || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

// Inspect published files; never rewrite or normalize their domain entries.
export function validatePrivateLists(
  gateway: GatewayProfile,
  directory = env.GATEWAY_LISTS_PATH,
): Record<string, number> {
  const counts: Record<string, number> = {};
  if (gateway.privateLists.length === 0) return counts;
  const root = realpathSync(directory);
  for (const list of gateway.privateLists) {
    const path = realpathSync(resolve(root, list.file));
    const stat = statSync(path);
    if (!path.startsWith(`${root}${sep}`) || !stat.isFile() || stat.size > 32 * 1024 * 1024) {
      throw new Error(`Invalid gateway list: ${list.name}`);
    }
    const entries = readFileSync(path, "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    if (entries.length === 0) throw new Error(`Empty gateway list: ${list.name}`);
    if (
      list.target === "notblocked" &&
      entries.some((entry) => {
        const domain = entry.startsWith("+.") ? entry.slice(2) : entry;
        return (
          domain.length > 253 ||
          !domain.includes(".") ||
          domain
            .split(".")
            .some((label) => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u.test(label))
        );
      })
    )
      throw new Error(`notblocked must preserve complete FQDN entries: ${list.name}`);
    counts[`gateway-${list.name}`] = entries.length;
  }
  return counts;
}
