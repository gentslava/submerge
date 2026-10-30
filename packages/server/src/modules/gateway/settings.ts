import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { dirname, resolve, sep } from "node:path";
import {
  channelMatcherSchema,
  type NetworkSettings,
  networkSettingsSchema,
  publishedRuleFile,
} from "@submerge/shared";
import { eq, inArray } from "drizzle-orm";
import * as yaml from "js-yaml";
import { z } from "zod";
import { getRuleProviders, type RuleProvidersResponse } from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { channels, settings } from "../../db/schema.js";
import { ensureDefaultChannel, ensureDirectChannel, listChannels } from "../channels/service.js";
import { ruleProviderName } from "../nodes/multiConfig.js";
import { getSetting, setSetting } from "../settings/service.js";
import {
  createGatewayDraft,
  type GatewayProfile,
  gatewayProfileSchema,
  type NetworkProfile,
  networkProfileSchema,
} from "./engine-settings.js";

export const NETWORK_SETTINGS_KEY = "internal.networkSettings";
const APPLY_STATE_KEY = "internal.gatewayApplyState";
const LEGACY_PROFILE_KEY = "networkProfile";
const LEGACY_PREFERENCES_KEY = "internal.gatewayPreferences";

export function publishedListsDirectory(): string {
  return resolve(dirname(env.MIHOMO_CONFIG_PATH), "private-lists");
}

export function availablePublishedLists(): string[] {
  try {
    return readdirSync(publishedListsDirectory())
      .filter((file) => publishedRuleFile(`file://published/${file}`) !== null)
      .sort()
      .slice(0, 128);
  } catch {
    return [];
  }
}

function savedJson(db: Db, key: string): string | undefined {
  const row = db.select({ key: settings.key }).from(settings).where(eq(settings.key, key)).get();
  if (!row) return undefined;
  const value = getSetting(db, key);
  if (value === undefined) throw new Error("Invalid persisted connection settings");
  return value;
}

export function readNetworkSettings(db: Db): NetworkSettings {
  const value = savedJson(db, NETWORK_SETTINGS_KEY);
  if (value !== undefined) return networkSettingsSchema.parse(JSON.parse(value));
  // Upgrade is transactional and never converts malformed settings to Proxy.
  if (
    savedJson(db, LEGACY_PROFILE_KEY) !== undefined ||
    savedJson(db, LEGACY_PREFERENCES_KEY) !== undefined
  ) {
    initializeNetworkSettings(db);
    return readNetworkSettings(db);
  }
  return networkSettingsSchema.parse({});
}

export function writeNetworkSettings(db: Db, value: NetworkSettings): void {
  setSetting(db, NETWORK_SETTINGS_KEY, JSON.stringify(networkSettingsSchema.parse(value)));
}

// Run once for a prepared installation or a legacy upgrade. All subsequent
// routing edits belong to channels and survive every connection-mode change.
export function initializeNetworkSettings(db: Db): void {
  if (savedJson(db, NETWORK_SETTINGS_KEY) !== undefined) {
    readNetworkSettings(db);
    return;
  }
  const activeRaw = savedJson(db, LEGACY_PROFILE_KEY);
  const savedRaw = savedJson(db, LEGACY_PREFERENCES_KEY);
  const active =
    activeRaw === undefined
      ? { profile: "proxy" as const }
      : networkProfileSchema.parse(JSON.parse(activeRaw));
  const saved =
    active.profile === "gateway"
      ? active
      : savedRaw === undefined
        ? undefined
        : gatewayProfileSchema.parse(JSON.parse(savedRaw));
  const initial = saved ?? createGatewayDraft();
  if (!saved) {
    for (const [file, target] of [
      ["notblocked.txt", "notblocked"],
      ["custom.txt", "proxy"],
    ] as const) {
      if (availablePublishedLists().includes(file))
        initial.privateLists.push({ name: file.slice(0, -4), file, target, behavior: "domain" });
    }
  }
  db.transaction(() => {
    ensureDefaultChannel(db);
    ensureDirectChannel(db);
    for (const id of ["direct", "default"]) {
      const row = db.select().from(channels).where(eq(channels.id, id)).get();
      if (!row) throw new Error("Missing routing channel during network upgrade");
      const matcher = channelMatcherSchema.parse(row.matcher);
      const refs = initial.privateLists
        .filter((list) => (list.target === "proxy") === (id === "default"))
        .map((list) => ({ url: `file://published/${list.file}`, behavior: list.behavior }));
      if (id === "direct") {
        matcher.domains = [
          ...new Set([
            ...matcher.domains,
            ...initial.localDomains.filter(
              (domain) => !createGatewayDraft().localDomains.includes(domain),
            ),
            ...initial.ruZones,
          ]),
        ];
        matcher.geosite = [...new Set([...matcher.geosite, ...initial.ruGeosite])];
        matcher.geoip = [...new Set([...matcher.geoip, ...initial.ruGeoip])];
        matcher.cidrs = [...new Set([...matcher.cidrs, ...initial.serviceCidrs])];
      }
      matcher.ruleProviders = [
        ...new Map(
          [...matcher.ruleProviders, ...refs].map((ref) => [`${ref.url}|${ref.behavior}`, ref]),
        ).values(),
      ];
      db.update(channels).set({ matcher }).where(eq(channels.id, id)).run();
    }
    writeNetworkSettings(db, {
      mode: active.profile === "gateway" ? "tun" : "proxy",
      localResolvers: initial.localResolvers,
    });
    db.delete(settings)
      .where(inArray(settings.key, [LEGACY_PROFILE_KEY, LEGACY_PREFERENCES_KEY]))
      .run();
  });
}

export function readNetworkProfile(db: Db): NetworkProfile {
  if (readNetworkSettings(db).mode === "proxy") return { profile: "proxy" };
  const runtime = readGatewayRuntimeSettings(db);
  if (!runtime) throw new Error("Missing saved connection settings");
  return runtime;
}

export function readGatewayRuntimeSettings(db: Db): GatewayProfile | undefined {
  const value = readNetworkSettings(db);
  if (savedJson(db, NETWORK_SETTINGS_KEY) === undefined) return undefined;
  const profile = createGatewayDraft();
  profile.localResolvers = value.localResolvers;
  // RU/domain/CIDR routing is generated solely from the existing channel editor.
  profile.ruZones = [];
  profile.ruGeosite = [];
  profile.ruGeoip = [];
  for (const channel of listChannels(db).filter(
    (channel) => channel.enabled || channel.isDefault,
  )) {
    for (const ref of channel.matcher.ruleProviders) {
      const file = publishedRuleFile(ref.url);
      if (!file) continue;
      const name = ruleProviderName(ref);
      if (profile.privateLists.some((list) => list.name === name)) continue;
      profile.privateLists.push({
        name,
        file,
        behavior: ref.behavior,
        target:
          channel.target === "proxy" ? "proxy" : file === "notblocked.txt" ? "notblocked" : "ru",
      });
    }
  }
  return profile;
}

export function assertGatewaySecurity(secret: string): void {
  if (!env.ADMIN_PASSWORD || !secret) {
    throw new Error("TUN requires ADMIN_PASSWORD and an engine secret");
  }
}

export function gatewayApplyState(db: Db): "applied" | "failed" | "unknown" {
  const value = getSetting(db, APPLY_STATE_KEY);
  return value === "applied" || value === "failed" ? value : "unknown";
}

export function seedGatewayMihomoSecret(db: Db, effectiveSecret: string): void {
  if (getSetting(db, "mihomoSecret")) return;
  if (!effectiveSecret) throw new Error("Gateway requires a confirmed engine secret");
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
    else if (!secret) throw new Error("Prepared deployment requires an engine secret");
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
    const name = list.name;
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
        (list) => !response.providers[list.name]?.ruleCount,
      );
      if (!initializing || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

// Inspect published files; never rewrite or normalize their domain entries.
export function validatePrivateLists(
  gateway: GatewayProfile,
  directory = publishedListsDirectory(),
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
    counts[list.name] = entries.length;
  }
  return counts;
}
