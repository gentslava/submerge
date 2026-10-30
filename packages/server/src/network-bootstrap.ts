import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import * as yaml from "js-yaml";
import { z } from "zod";
import { env } from "./config/env.js";
import { ensureDefaultChannel, ensureDirectChannel } from "./modules/channels/service.js";
import {
  assertGatewaySecurity,
  assertIndependentLocalDns,
  initializeNetworkSettings,
  readGatewayRuntimeSettings,
  readNetworkProfile,
  seedGatewayMihomoSecret,
  validatePrivateLists,
} from "./modules/gateway/settings.js";
import { buildMultiConfig } from "./modules/nodes/multiConfig.js";
import { collectActiveRoutingInputs, readMihomoSecret } from "./modules/nodes/service.js";
import {
  prepareMihomoSecretForBootstrap,
  restorePendingMihomoSecretRotation,
} from "./modules/settings/secret-rotation.js";

export function assertSafeGatewayBootstrap(content: string): void {
  const config = z
    .object({
      mode: z.literal("rule"),
      secret: z.string().min(1),
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

export async function bootstrapNetwork(): Promise<void> {
  const { db } = await import("./db/client.js");
  const { runMigrations } = await import("./db/migrate.js");
  try {
    runMigrations();
    ensureDefaultChannel(db);
    ensureDirectChannel(db);
    initializeNetworkSettings(db);
    restorePendingMihomoSecretRotation(db);
    const profile = readNetworkProfile(db);
    const preferences = readGatewayRuntimeSettings(db);
    if (!preferences) throw new Error("TUN deployment requires configured TUN preferences");
    const secret = prepareMihomoSecretForBootstrap(db);
    if (profile.profile === "gateway") assertGatewaySecurity(secret);
    assertIndependentLocalDns(preferences);
    validatePrivateLists(preferences);
    if (secret === readMihomoSecret(db)) seedGatewayMihomoSecret(db, secret);
    // Preserve the last accepted file on restart, including after a rejected apply.
    let content: string | undefined;
    if (existsSync(env.MIHOMO_CONFIG_PATH)) {
      const previous = readFileSync(env.MIHOMO_CONFIG_PATH, "utf8");
      const document = z.record(z.string(), z.unknown()).parse(yaml.load(previous));
      if ((document.tun as { enable?: unknown } | undefined)?.enable === true) {
        assertGatewaySecurity(secret);
      }
      try {
        assertSafeGatewayBootstrap(previous);
        if (document.secret !== secret) content = yaml.dump({ ...document, secret });
      } catch (error) {
        // Only the pre-TUN managed Proxy installation is migrated. Corrupt or
        // previously accepted TUN data still fails explicitly and is retained.
        if (
          profile.profile !== "proxy" ||
          (document.tun as { enable?: unknown } | undefined)?.enable === true
        )
          throw error;
        content = buildMultiConfig(
          collectActiveRoutingInputs(db).inputs,
          secret,
          undefined,
          undefined,
          profile,
          preferences,
        );
      }
    } else
      content = buildMultiConfig(
        collectActiveRoutingInputs(db).inputs,
        secret,
        undefined,
        undefined,
        profile,
        preferences,
      );
    if (content !== undefined) {
      mkdirSync(dirname(env.MIHOMO_CONFIG_PATH), { recursive: true });
      assertSafeGatewayBootstrap(content);
      writeFileSync(`${env.MIHOMO_CONFIG_PATH}.tmp`, content, { mode: 0o600 });
      renameSync(`${env.MIHOMO_CONFIG_PATH}.tmp`, env.MIHOMO_CONFIG_PATH);
    }
  } finally {
    db.$client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void bootstrapNetwork().catch(() => {
    process.stderr.write(
      "Network preparation failed; check saved configuration and mounted files.\n",
    );
    process.exitCode = 1;
  });
}
