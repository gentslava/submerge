import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import type { DefaultRoute } from "@submerge/shared";
import * as yaml from "js-yaml";
import { z } from "zod";
import { env } from "./config/env.js";
import type { Db } from "./db/client.js";
import {
  ensureDefaultChannel,
  ensureDirectChannel,
  readDefaultChannel,
} from "./modules/channels/service.js";
import { inspectRecoverableLocalDomainRuleStore } from "./modules/domain-intelligence/deployment-production.js";
import { DOMAIN_RULE_DIRECTORY_PATH } from "./modules/domain-intelligence/rule-store.js";
import {
  assertGatewaySecurity,
  assertIndependentLocalDns,
  initializeNetworkSettings,
  readGatewayRuntimeSettings,
  readNetworkProfile,
  seedGatewayMihomoSecret,
  validatePrivateLists,
} from "./modules/gateway/settings.js";
import {
  beginConfigApply,
  readConfigApplyRecovery,
  recordConfigApplyCandidate,
} from "./modules/nodes/config-apply-journal.js";
import {
  buildMultiConfig,
  MANAGED_DOMAIN_RULE_PROVIDER_NAME,
  MANAGED_DOMAIN_RULE_PROVIDER_PATH,
  type ManagedDomainRulesProviderInput,
} from "./modules/nodes/multiConfig.js";
import { collectActiveRoutingInputs, readMihomoSecret } from "./modules/nodes/service.js";
import {
  prepareMihomoSecretForBootstrap,
  restorePendingMihomoSecretRotation,
} from "./modules/settings/secret-rotation.js";

export function assertSafeGatewayBootstrap(
  content: string,
  defaultRoute: DefaultRoute = "proxy",
): void {
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
  const unsafeDirectMatch = config.rules.some((rule, index) => {
    const intendedCatchAll =
      defaultRoute === "direct" && rule === "MATCH,DIRECT" && index === config.rules.length - 1;
    return /^MATCH,DIRECT(?:,|$)/u.test(rule) && !intendedCatchAll;
  });
  if (
    config["proxy-groups"].some((group) => group.proxies.includes("DIRECT")) ||
    unsafeDirectMatch ||
    !config.rules.at(-1)?.startsWith("MATCH,")
  ) {
    throw new Error("Existing config is not a fail-closed gateway bootstrap");
  }
}

function managedRulesForOfflineMigration(
  db: Db,
  document: Record<string, unknown>,
  ruleDirectoryPath: string,
): ManagedDomainRulesProviderInput | undefined {
  const rules = z.array(z.string()).optional().parse(document.rules) ?? [];
  const providers =
    z.record(z.string(), z.unknown()).optional().parse(document["rule-providers"]) ?? {};
  const provider = providers[MANAGED_DOMAIN_RULE_PROVIDER_NAME];
  const referenced = rules.some((rule) => {
    const [type, name] = rule.split(",");
    return type === "RULE-SET" && name === MANAGED_DOMAIN_RULE_PROVIDER_NAME;
  });
  if (provider === undefined && !referenced) return undefined;
  if (provider === undefined || !referenced) throw new Error("Incomplete accepted managed routing");
  z.object({
    type: z.literal("file"),
    behavior: z.literal("domain"),
    format: z.literal("text"),
    path: z.literal(MANAGED_DOMAIN_RULE_PROVIDER_PATH),
  })
    .strict()
    .parse(provider);
  inspectRecoverableLocalDomainRuleStore(db, ruleDirectoryPath);
  // Only the coordinated online owner can attest the current store and VPN pool.
  // Keep its destinations closed in the normal rule order until that proof exists.
  return { targetGroupName: "REJECT" };
}

export async function bootstrapNetwork(
  ruleDirectoryPath: string = DOMAIN_RULE_DIRECTORY_PATH,
): Promise<void> {
  const { db } = await import("./db/client.js");
  const { runMigrations } = await import("./db/migrate.js");
  try {
    runMigrations();
    ensureDefaultChannel(db);
    ensureDirectChannel(db);
    initializeNetworkSettings(db);
    const recovery = readConfigApplyRecovery(db, env.MIHOMO_CONFIG_PATH);
    restorePendingMihomoSecretRotation(db);
    const profile = readNetworkProfile(db);
    const preferences = readGatewayRuntimeSettings(db);
    if (!preferences) throw new Error("TUN deployment requires configured TUN preferences");
    const secret = prepareMihomoSecretForBootstrap(db);
    if (profile.profile === "gateway") assertGatewaySecurity(secret);
    assertIndependentLocalDns(preferences);
    validatePrivateLists(preferences);
    if (secret === readMihomoSecret(db)) seedGatewayMihomoSecret(db, secret);
    const defaultRoute = readDefaultChannel(db).defaultRoute;
    // Preserve the last accepted file on restart, including after a rejected apply.
    let content: string | undefined;
    if (existsSync(env.MIHOMO_CONFIG_PATH)) {
      const previous = readFileSync(env.MIHOMO_CONFIG_PATH, "utf8");
      const document = z.record(z.string(), z.unknown()).parse(yaml.load(previous));
      const managedRules = managedRulesForOfflineMigration(db, document, ruleDirectoryPath);
      if ((document.tun as { enable?: unknown } | undefined)?.enable === true) {
        assertGatewaySecurity(secret);
      }
      try {
        assertSafeGatewayBootstrap(previous, recovery.defaultRoute);
        // A pending credential rotation already retains both credentials. Keep the
        // journal-bound accepted file intact until the online apply confirms it.
        if (!recovery.pending && document.secret !== secret)
          content = yaml.dump({ ...document, secret });
      } catch (error) {
        // Only the pre-TUN managed Proxy installation is migrated. Corrupt or
        // previously accepted TUN data still fails explicitly and is retained.
        const legacyProxy = z
          .object({
            mode: z.literal("rule"),
            tun: z.undefined().optional(),
            dns: z.object({ "enhanced-mode": z.literal("redir-host").optional() }).optional(),
          })
          .safeParse(document).success;
        if (
          (recovery.pending && !legacyProxy) ||
          profile.profile !== "proxy" ||
          (document.tun as { enable?: unknown } | undefined)?.enable === true
        )
          throw error;
        content = buildMultiConfig(
          collectActiveRoutingInputs(db).inputs,
          secret,
          undefined,
          managedRules,
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
      assertSafeGatewayBootstrap(content, defaultRoute);
      if (recovery.pending)
        db.transaction(() => {
          // Rebase proof before offline migration: the primary may already be the
          // previous candidate. Both the old bytes and replacement remain provable
          // if preparation stops before or after rename; activation stays pending.
          beginConfigApply(db, env.MIHOMO_CONFIG_PATH);
          recordConfigApplyCandidate(db, env.MIHOMO_CONFIG_PATH, content);
        });
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
