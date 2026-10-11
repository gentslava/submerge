import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { networkProfileSchema } from "@submerge/shared";
import * as yaml from "js-yaml";
import { z } from "zod";
import { env } from "./config/env.js";
import { ensureDefaultChannel, ensureDirectChannel } from "./modules/channels/service.js";
import { gatewayReadiness } from "./modules/gateway/service.js";
import {
  assertGatewaySecurity,
  assertIndependentLocalDns,
  readGatewayRuntimeSettings,
  readNetworkProfile,
  seedGatewayMihomoSecret,
  seedNetworkProfile,
  validatePrivateLists,
  writeNetworkProfile,
} from "./modules/gateway/settings.js";
import { buildMultiConfig } from "./modules/nodes/multiConfig.js";
import { collectActiveRoutingInputs, readMihomoSecret } from "./modules/nodes/service.js";
import { restorePendingMihomoSecretRotation } from "./modules/settings/secret-rotation.js";

export function parseGatewayCliArgs(args: readonly string[]): {
  action: "bootstrap" | "show" | "readiness" | "configure";
  file?: string;
} {
  if (args.length === 1 && ["bootstrap", "show", "readiness"].includes(args[0] ?? "")) {
    return { action: args[0] as "bootstrap" | "show" | "readiness" };
  }
  if (args.length === 2 && args[0] === "configure" && args[1])
    return { action: "configure", file: args[1] };
  throw new Error("Usage: gateway bootstrap|show|readiness|configure <profile.json>");
}

export function assertSafeGatewayBootstrap(content: string): void {
  const config = z
    .object({
      mode: z.literal("rule"),
      secret: z.string().min(16),
      dns: z.object({ enable: z.literal(true), "enhanced-mode": z.literal("fake-ip") }),
      tun: z.object({ enable: z.boolean() }),
      "proxy-groups": z.array(z.object({ proxies: z.array(z.string()) })),
      rules: z.array(z.string()).min(1),
    })
    .parse(yaml.load(content));
  if (
    config["proxy-groups"].some((group) => group.proxies.includes("DIRECT")) ||
    config.rules.some((rule) => /^MATCH,DIRECT(?:,|$)/u.test(rule)) ||
    !config.rules.at(-1)?.startsWith("MATCH,")
  ) {
    throw new Error("Existing config is not a fail-closed gateway bootstrap");
  }
}

export async function runGatewayCli(args: readonly string[]): Promise<void> {
  const options = parseGatewayCliArgs(args);
  const { db } = await import("./db/client.js");
  const { runMigrations } = await import("./db/migrate.js");
  try {
    runMigrations();
    ensureDefaultChannel(db);
    ensureDirectChannel(db);
    // Explicit offline repair must work even when the persisted profile is corrupt
    // or its old seed file is unavailable. All other commands still validate it.
    if (options.action !== "configure") seedNetworkProfile(db);
    restorePendingMihomoSecretRotation(db);
    if (options.action === "configure") {
      // Offline operator command: stop the server first; boot owns live activation.
      const profile = networkProfileSchema.parse(
        JSON.parse(readFileSync(options.file ?? "", "utf8")),
      );
      if (profile.profile === "gateway") {
        assertGatewaySecurity(readMihomoSecret(db));
        assertIndependentLocalDns(profile);
        validatePrivateLists(profile);
        seedGatewayMihomoSecret(db, readMihomoSecret(db));
      }
      writeNetworkProfile(db, profile);
      process.stdout.write("Network profile saved; start the server to apply it.\n");
    } else if (options.action === "bootstrap") {
      const profile = readNetworkProfile(db);
      const preferences = readGatewayRuntimeSettings(db);
      if (!preferences) throw new Error("TUN deployment requires configured TUN preferences");
      assertGatewaySecurity(readMihomoSecret(db));
      validatePrivateLists(preferences);
      seedGatewayMihomoSecret(db, readMihomoSecret(db));
      // Preserve the last accepted file on restart, including after a rejected apply.
      if (existsSync(env.MIHOMO_CONFIG_PATH)) {
        assertSafeGatewayBootstrap(readFileSync(env.MIHOMO_CONFIG_PATH, "utf8"));
      } else {
        mkdirSync(dirname(env.MIHOMO_CONFIG_PATH), { recursive: true });
        const content = buildMultiConfig(
          collectActiveRoutingInputs(db).inputs,
          readMihomoSecret(db),
          undefined,
          undefined,
          profile,
          preferences,
        );
        writeFileSync(`${env.MIHOMO_CONFIG_PATH}.tmp`, content, { mode: 0o600 });
        renameSync(`${env.MIHOMO_CONFIG_PATH}.tmp`, env.MIHOMO_CONFIG_PATH);
      }
    } else if (options.action === "show") {
      process.stdout.write(`${JSON.stringify(readNetworkProfile(db), null, 2)}\n`);
    } else {
      const readiness = await gatewayReadiness(db);
      process.stdout.write(`${JSON.stringify(readiness, null, 2)}\n`);
      if (!readiness.ready) process.exitCode = 1;
    }
  } finally {
    db.$client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runGatewayCli(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      "Gateway command failed; check profile, secrets, mounted lists and engine availability.\n",
    );
    process.exitCode = 1;
  });
}
