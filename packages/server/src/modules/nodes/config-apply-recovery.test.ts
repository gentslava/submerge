import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SPEED_POLICY, emptyChannelMatcher } from "@submerge/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { createDb } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import { assertSafeGatewayBootstrap } from "../../network-bootstrap.js";
import { setPool } from "../channels/pool.js";
import {
  createChannel,
  ensureDefaultChannel,
  ensureDirectChannel,
  readDefaultChannel,
  setDefaultRoute,
} from "../channels/service.js";
import {
  initializeNetworkSettings,
  readGatewayRuntimeSettings,
  readNetworkProfile,
  writeNetworkSettings,
} from "../gateway/settings.js";
import { getSetting, setSetting } from "../settings/service.js";
import { readConfigApplyRecovery } from "./config-apply-journal.js";
import { buildMultiConfig } from "./multiConfig.js";
import { collectActiveRoutingInputs } from "./service.js";

describe.each([
  { mode: "legacy", migrateLegacy: false },
  { mode: "proxy", migrateLegacy: false },
  { mode: "tun", migrateLegacy: false },
  { mode: "legacy", migrateLegacy: true },
] as const)(
  "config apply crash recovery: $mode (prepared migration: $migrateLegacy)",
  ({ mode, migrateLegacy }) => {
    it.each(["staged", "reload", "replaced"] as const)(
      "resumes desired config after SIGKILL at %s",
      (phase) => {
        const directory = mkdtempSync(join(tmpdir(), "config-apply-crash-"));
        const databasePath = join(directory, "test.db");
        const configPath = join(directory, "config.yaml");
        const db = createDb(databasePath);
        const previousRoute = phase === "replaced" ? "proxy" : "direct";
        const desiredRoute = previousRoute === "direct" ? "proxy" : "direct";
        try {
          migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
          ensureDefaultChannel(db);
          ensureDirectChannel(db);
          if (mode !== "legacy") {
            initializeNetworkSettings(db);
            writeNetworkSettings(db, { mode, localResolvers: [] });
          }
          setDefaultRoute(db, previousRoute);
          setSetting(db, "mihomoSecret", "old-secret");
          db.insert(sources)
            .values({
              kind: "sub",
              value: "test",
              label: "test",
              proxies: [
                {
                  name: "vpn",
                  type: "ss",
                  server: "vpn.example.com",
                  port: 443,
                  cipher: "aes-128-gcm",
                  password: "test",
                },
              ],
            })
            .run();
          const packages = createChannel(db, {
            name: "Packages",
            policy: DEFAULT_SPEED_POLICY,
            matcher: { ...emptyChannelMatcher(), domains: ["docker.io", "npmjs.org"] },
          });
          setPool(db, packages.id, [{ kind: "node", ref: "missing" }]);
          const content = buildMultiConfig(
            collectActiveRoutingInputs(db).inputs,
            "old-secret",
            undefined,
            undefined,
            readNetworkProfile(db),
            readGatewayRuntimeSettings(db),
          );
          writeFileSync(configPath, content);
          const childEnv = {
            ...process.env,
            DB_PATH: databasePath,
            MIHOMO_CONFIG_PATH: configPath,
            ADMIN_PASSWORD: "test-admin",
            MIHOMO_SECRET: "old-secret",
            DESIRED_ROUTE: desiredRoute,
          };
          const script = [
            "--import",
            "tsx",
            "--conditions=development",
            new URL("./config-apply-crash.test-support.ts", import.meta.url).pathname,
          ];
          const crashed = spawnSync(process.execPath, script, {
            env: { ...childEnv, CRASH_PHASE: phase },
            encoding: "utf8",
            timeout: 12_000,
          });
          expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
          expect(readDefaultChannel(db).defaultRoute).toBe(desiredRoute);
          const journal = getSetting(db, "internal.configApply");
          expect(journal).toBeDefined();
          const afterCrash = readFileSync(configPath, "utf8");
          if (phase !== "replaced") expect(afterCrash).toBe(content);
          if (mode !== "legacy" || migrateLegacy) {
            let prepared: string | undefined;
            const bootstrap = () =>
              execFileSync(
                process.execPath,
                [
                  "--import",
                  "tsx",
                  "--conditions=development",
                  new URL("../../network-bootstrap.ts", import.meta.url).pathname,
                ],
                { env: childEnv, stdio: "pipe" },
              );
            if (migrateLegacy && phase === "replaced") {
              // Fail after rebasing proof but before publishing the prepared file.
              // The current primary is the earlier candidate, not the old accepted hash.
              mkdirSync(`${configPath}.tmp`);
              expect(bootstrap).toThrow();
              expect(readFileSync(configPath, "utf8")).toBe(afterCrash);
              expect(() => readConfigApplyRecovery(db, configPath)).not.toThrow();
              rmSync(`${configPath}.tmp`, { recursive: true });
            }
            for (let restart = 0; restart < 2; restart += 1) {
              bootstrap();
              const current = readFileSync(configPath, "utf8");
              if (migrateLegacy) {
                expect(() => assertSafeGatewayBootstrap(current, desiredRoute)).not.toThrow();
                if (prepared !== undefined) expect(current).toBe(prepared);
                prepared = current;
                expect(getSetting(db, "internal.configApply")).toBeDefined();
              } else {
                expect(current).toBe(afterCrash);
                expect(getSetting(db, "internal.configApply")).toBe(journal);
              }
            }
          }
          execFileSync(process.execPath, script, {
            env: { ...childEnv, CRASH_PHASE: "recover" },
            stdio: "pipe",
          });
          expect(JSON.parse(readFileSync(`${configPath}.result`, "utf8"))).toMatchObject({
            result: { applied: true, activationVerified: true },
            reloads: 1,
          });
          expect(getSetting(db, "internal.configApply")).toBeUndefined();
          expect(getSetting(db, "internal.mihomoSecretRotation")).toBeUndefined();
          expect(getSetting(db, "mihomoSecret")).toBe("next-secret");
          expect(readDefaultChannel(db).defaultRoute).toBe(desiredRoute);
          const config = yaml.load(readFileSync(configPath, "utf8")) as {
            rules: string[];
            "proxy-groups": Array<{ name: string; proxies: string[] }>;
          };
          expect(config.rules.at(-1)).toBe(
            desiredRoute === "direct" ? "MATCH,DIRECT" : "MATCH,AUTO",
          );
          expect(config.rules.some((rule) => rule.startsWith("DOMAIN-SUFFIX,docker.io,"))).toBe(
            true,
          );
          if (mode !== "legacy" || desiredRoute === "direct")
            expect(
              config["proxy-groups"]
                .filter((group) => group.name.startsWith("ch-"))
                .every((group) => group.proxies.length === 1 && group.proxies[0] === "REJECT"),
            ).toBe(true);
          expect(existsSync(`${configPath}.pending`)).toBe(false);
        } finally {
          db.$client.close();
          rmSync(directory, { recursive: true, force: true });
        }
      },
      25_000,
    );
  },
);
