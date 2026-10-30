import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelGroupName, DEFAULT_SPEED_POLICY, emptyChannelMatcher } from "@submerge/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { domainRuleOperations, sources } from "./db/schema.js";
import {
  createChannel,
  ensureDefaultChannel,
  ensureDirectChannel,
  readDefaultChannel,
  setDefaultRoute,
  updateDirect,
} from "./modules/channels/service.js";
import {
  initializeNetworkSettings,
  readGatewayRuntimeSettings,
  readNetworkProfile,
  writeNetworkSettings,
} from "./modules/gateway/settings.js";
import { beginConfigApply } from "./modules/nodes/config-apply-journal.js";
import { buildMultiConfig } from "./modules/nodes/multiConfig.js";
import { collectActiveRoutingInputs } from "./modules/nodes/service.js";
import { getSetting, setSetting } from "./modules/settings/service.js";
import { assertSafeGatewayBootstrap } from "./network-bootstrap.js";

describe("automatic network bootstrap", () => {
  it.each([
    "valid",
    "empty-pool",
    "missing-provider",
    "unsafe-provider",
    "missing-file",
    "digest-mismatch",
    "invalid-file",
    "unattested-store",
    "pending-store-operation",
    "blocked-store-operation",
  ] as const)(
    "keeps accepted managed VPN destinations closed during legacy migration: %s",
    (scenario) => {
      const directory = mkdtempSync(join(tmpdir(), "submerge-bootstrap-managed-"));
      const databasePath = join(directory, "test.db");
      const configPath = join(directory, "config.yaml");
      const ruleDirectory = join(directory, "domain-rules");
      const db = createDb(databasePath);
      try {
        migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
        ensureDefaultChannel(db);
        ensureDirectChannel(db);
        setDefaultRoute(db, "direct");
        setSetting(db, "mihomoSecret", "test-key");
        updateDirect(db, { matcher: { ...emptyChannelMatcher(), domains: ["managed.example"] } });
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
        const document = yaml.load(
          buildMultiConfig(collectActiveRoutingInputs(db).inputs, "test-key", undefined, {
            targetGroupName: "AUTO",
          }),
        ) as {
          "rule-providers": Record<string, unknown>;
        };
        if (scenario === "missing-provider") delete document["rule-providers"]["submerge-custom"];
        if (scenario === "unsafe-provider")
          document["rule-providers"]["submerge-custom"] = {
            type: "http",
            behavior: "domain",
            format: "text",
            path: "./other.txt",
            url: "https://example.com/unsafe.txt",
          };
        const previous = yaml.dump(document);
        writeFileSync(configPath, previous);
        mkdirSync(ruleDirectory, { mode: 0o700 });
        const rulesContent = "managed.example\n";
        const digest = createHash("sha256").update(rulesContent).digest("hex");
        writeFileSync(join(ruleDirectory, "custom.txt"), rulesContent, { mode: 0o600 });
        if (scenario !== "unattested-store")
          setSetting(
            db,
            "internal.domainRuleStore.v1",
            `sha256:${scenario === "pending-store-operation" ? "a".repeat(64) : digest}`,
          );
        if (scenario === "missing-file") rmSync(join(ruleDirectory, "custom.txt"));
        if (scenario === "digest-mismatch")
          writeFileSync(join(ruleDirectory, "custom.txt"), "other.example\n");
        if (scenario === "invalid-file")
          writeFileSync(join(ruleDirectory, "custom.txt"), "DOMAIN,unsafe.example,DIRECT\n");
        if (scenario === "pending-store-operation" || scenario === "blocked-store-operation")
          db.insert(domainRuleOperations)
            .values({
              id: "pending-bootstrap",
              idempotencyKey: "pending-bootstrap",
              action: "manual-add",
              phase:
                scenario === "pending-store-operation" ? "prepared" : "reconciliation-required",
              expectedSourceRevision: "a".repeat(40),
              intendedContentSha256: digest,
              proposedRule: "managed.example",
              ownershipDelta: {
                upserts: [{ rule: "managed.example", ownership: "manual" }],
                deletes: [],
              },
              createdAt: 100,
              updatedAt: 100,
              completedAt: scenario === "blocked-store-operation" ? 100 : null,
            })
            .run();
        const storeMarker = getSetting(db, "internal.domainRuleStore.v1");
        db.transaction(() => {
          beginConfigApply(db, configPath);
          if (scenario === "empty-pool") db.update(sources).set({ enabled: false }).run();
        });
        const journal = getSetting(db, "internal.configApply");
        const bootstrap = () =>
          execFileSync(
            process.execPath,
            [
              "--import",
              "tsx",
              "--conditions=development",
              "--input-type=module",
              "--eval",
              `import { bootstrapNetwork } from ${JSON.stringify(new URL("./network-bootstrap.ts", import.meta.url).href)}; await bootstrapNetwork(process.env.TEST_RULE_DIRECTORY);`,
            ],
            {
              env: {
                ...process.env,
                DB_PATH: databasePath,
                MIHOMO_CONFIG_PATH: configPath,
                TEST_RULE_DIRECTORY: ruleDirectory,
                ADMIN_PASSWORD: "test-admin",
                MIHOMO_SECRET: "test-key",
              },
              stdio: "pipe",
            },
          );
        if (!["valid", "empty-pool", "pending-store-operation"].includes(scenario)) {
          expect(bootstrap).toThrow();
          expect(readFileSync(configPath, "utf8")).toBe(previous);
          expect(getSetting(db, "internal.configApply")).toBe(journal);
        } else {
          bootstrap();
          const content = readFileSync(configPath, "utf8");
          const config = yaml.load(content) as {
            rules: string[];
            "rule-providers": Record<string, unknown>;
          };
          const managedIndex = config.rules.indexOf("RULE-SET,submerge-custom,REJECT");
          expect(managedIndex).toBeGreaterThanOrEqual(0);
          expect(managedIndex).toBeLessThan(
            config.rules.indexOf("DOMAIN-SUFFIX,managed.example,DIRECT"),
          );
          expect(config["rule-providers"]["submerge-custom"]).toEqual({
            type: "file",
            behavior: "domain",
            format: "text",
            path: "./domain-rules/custom.txt",
          });
          expect(config.rules.at(-1)).toBe("MATCH,DIRECT");
          expect(() => assertSafeGatewayBootstrap(content, "direct")).not.toThrow();
          expect(getSetting(db, "internal.configApply")).toBeDefined();
          expect(getSetting(db, "internal.domainRuleStore.v1")).toBe(storeMarker);
          bootstrap();
          expect(readFileSync(configPath, "utf8")).toBe(content);
        }
      } finally {
        db.$client.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );
  it("rejects an unsafe native Proxy file even when its bytes are journal-proven", () => {
    const directory = mkdtempSync(join(tmpdir(), "submerge-bootstrap-unsafe-pending-"));
    const databasePath = join(directory, "test.db");
    const configPath = join(directory, "config.yaml");
    const db = createDb(databasePath);
    const content =
      'mode: rule\nsecret: test-key\ndns: {enable: true, enhanced-mode: fake-ip}\ntun: {enable: false}\nproxy-groups: [{proxies: [DIRECT]}]\nrules: ["MATCH,AUTO"]\n';
    try {
      migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
      ensureDefaultChannel(db);
      ensureDirectChannel(db);
      initializeNetworkSettings(db);
      setSetting(db, "mihomoSecret", "test-key");
      writeFileSync(configPath, content);
      beginConfigApply(db, configPath);
      const journal = getSetting(db, "internal.configApply");
      expect(() =>
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--conditions=development",
            new URL("./network-bootstrap.ts", import.meta.url).pathname,
          ],
          {
            env: {
              ...process.env,
              DB_PATH: databasePath,
              MIHOMO_CONFIG_PATH: configPath,
              ADMIN_PASSWORD: "test-admin",
              MIHOMO_SECRET: "test-key",
            },
            stdio: "pipe",
          },
        ),
      ).toThrow();
      expect(readFileSync(configPath, "utf8")).toBe(content);
      expect(getSetting(db, "internal.configApply")).toBe(journal);
    } finally {
      db.$client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each(["direct", "proxy"] as const)(
    "preserves the accepted TUN config after staging a change from %s and keeps it pending",
    (previousRoute) => {
      const directory = mkdtempSync(join(tmpdir(), "submerge-bootstrap-pending-"));
      const configPath = join(directory, "config.yaml");
      const databasePath = join(directory, "test.db");
      const nextRoute = previousRoute === "direct" ? "proxy" : "direct";
      const db = createDb(databasePath);
      try {
        migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
        ensureDefaultChannel(db);
        ensureDirectChannel(db);
        initializeNetworkSettings(db);
        writeNetworkSettings(db, { mode: "tun", localResolvers: [] });
        setDefaultRoute(db, previousRoute);
        setSetting(db, "mihomoSecret", "secure-test-secret");
        const content = buildMultiConfig(
          collectActiveRoutingInputs(db).inputs,
          "secure-test-secret",
          undefined,
          undefined,
          readNetworkProfile(db),
          readGatewayRuntimeSettings(db),
        );
        writeFileSync(configPath, content);
        db.transaction(() => {
          setSetting(
            db,
            "internal.configApply",
            JSON.stringify({
              version: 1,
              id: randomUUID(),
              configPath,
              accepted: {
                hash: createHash("sha256").update(content).digest("hex"),
                defaultRoute: previousRoute,
              },
              candidate: null,
            }),
          );
          setDefaultRoute(db, nextRoute);
        });
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--conditions=development",
            new URL("./network-bootstrap.ts", import.meta.url).pathname,
          ],
          {
            env: {
              ...process.env,
              DB_PATH: databasePath,
              MIHOMO_CONFIG_PATH: configPath,
              ADMIN_PASSWORD: "bootstrap-test-admin",
              MIHOMO_SECRET: "secure-test-secret",
            },
            stdio: "pipe",
          },
        );
        expect(readFileSync(configPath, "utf8")).toBe(content);
        expect(readDefaultChannel(db).defaultRoute).toBe(nextRoute);
        expect(getSetting(db, "internal.configApply")).toBeDefined();
      } finally {
        db.$client.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );
  it.each([
    ["proxy", false],
    ["proxy", true],
    ["tun", false],
    ["tun", true],
  ] as const)(
    "boots and restarts a saved Direct default in %s (accepted file: %s)",
    (mode, acceptedFile) => {
      const directory = mkdtempSync(join(tmpdir(), "submerge-bootstrap-direct-"));
      const path = join(directory, "config.yaml");
      const databasePath = join(directory, "test.db");
      try {
        const db = createDb(databasePath);
        let packagesGroup: string;
        let previous: string;
        try {
          migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
          ensureDefaultChannel(db);
          ensureDirectChannel(db);
          initializeNetworkSettings(db);
          writeNetworkSettings(db, { mode, localResolvers: [] });
          setDefaultRoute(db, "direct");
          setSetting(db, "mihomoSecret", "secure-test-secret");
          const packages = createChannel(db, {
            name: "Packages",
            policy: DEFAULT_SPEED_POLICY,
            matcher: { ...emptyChannelMatcher(), domains: ["docker.io", "npmjs.org"] },
          });
          packagesGroup = channelGroupName(packages);
          previous = buildMultiConfig(
            collectActiveRoutingInputs(db).inputs,
            "secure-test-secret",
            undefined,
            undefined,
            readNetworkProfile(db),
            readGatewayRuntimeSettings(db),
          );
          if (acceptedFile) writeFileSync(path, previous);
        } finally {
          db.$client.close();
        }
        const bootstrap = () =>
          execFileSync(
            process.execPath,
            [
              "--import",
              "tsx",
              "--conditions=development",
              new URL("./network-bootstrap.ts", import.meta.url).pathname,
            ],
            {
              env: {
                ...process.env,
                DB_PATH: databasePath,
                MIHOMO_CONFIG_PATH: path,
                ADMIN_PASSWORD: "bootstrap-test-admin",
                MIHOMO_SECRET: "secure-test-secret",
              },
              stdio: "pipe",
            },
          );
        bootstrap();
        const content = readFileSync(path, "utf8");
        const config = yaml.load(content) as {
          rules: string[];
          tun: { enable: boolean };
          "proxy-groups": Array<{ name: string; proxies: string[] }>;
        };
        expect(config.rules.at(-1)).toBe("MATCH,DIRECT");
        expect(config.rules).toContain(`DOMAIN-SUFFIX,docker.io,${packagesGroup}`);
        expect(
          config["proxy-groups"].find((group) => group.name === packagesGroup)?.proxies,
        ).toEqual(["REJECT"]);
        expect(config.tun.enable).toBe(mode === "tun");
        if (acceptedFile) expect(content).toBe(previous);
        bootstrap();
        expect(readFileSync(path, "utf8")).toBe(content);
        const reopened = createDb(databasePath);
        try {
          expect(readDefaultChannel(reopened).defaultRoute).toBe("direct");
        } finally {
          reopened.$client.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );
  it("blocks an accepted active TUN file without admin even after desired mode changed to Proxy", () => {
    const directory = mkdtempSync(join(tmpdir(), "submerge-bootstrap-accepted-tun-"));
    const path = join(directory, "config.yaml");
    const content =
      'mode: rule\nsecret: preserved-strong-secret\ndns: {enable: true, enhanced-mode: fake-ip}\ntun: {enable: true}\nproxy-groups: [{proxies: [REJECT]}]\nrules: ["MATCH,REJECT"]\n';
    try {
      writeFileSync(path, content);
      expect(() =>
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--conditions=development",
            new URL("./network-bootstrap.ts", import.meta.url).pathname,
          ],
          {
            env: {
              ...process.env,
              DB_PATH: join(directory, "test.db"),
              MIHOMO_CONFIG_PATH: path,
              ADMIN_PASSWORD: "",
              MIHOMO_SECRET: "preserved-strong-secret",
            },
            stdio: "pipe",
          },
        ),
      ).toThrow();
      expect(readFileSync(path, "utf8")).toBe(content);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("prepares ordinary localhost Proxy with no admin, secret or JSON and reuses its credential", () => {
    const directory = mkdtempSync(join(tmpdir(), "submerge-default-bootstrap-"));
    const path = join(directory, "config.yaml");
    const bootstrap = (secret = "") =>
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--conditions=development",
          new URL("./network-bootstrap.ts", import.meta.url).pathname,
        ],
        {
          env: {
            ...process.env,
            DB_PATH: join(directory, "test.db"),
            MIHOMO_CONFIG_PATH: path,
            ADMIN_PASSWORD: "",
            MIHOMO_SECRET: secret,
          },
          encoding: "utf8",
        },
      );
    try {
      bootstrap();
      const content = readFileSync(path, "utf8");
      expect(() => assertSafeGatewayBootstrap(content)).not.toThrow();
      const config = yaml.load(content) as { secret: string; tun: { enable: boolean } };
      expect(config.secret).toMatch(/^[a-f0-9]{64}$/u);
      expect(config.tun.enable).toBe(false);
      bootstrap("changed-environment-secret");
      expect(readFileSync(path, "utf8")).toBe(content);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("upgrades the managed legacy Proxy file while retaining its manual credential", () => {
    const directory = mkdtempSync(join(tmpdir(), "submerge-legacy-bootstrap-"));
    const path = join(directory, "config.yaml");
    try {
      writeFileSync(path, 'mode: rule\nsecret: poc\nrules: ["MATCH,DIRECT"]\n');
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--conditions=development",
          new URL("./network-bootstrap.ts", import.meta.url).pathname,
        ],
        {
          env: {
            ...process.env,
            DB_PATH: join(directory, "test.db"),
            MIHOMO_CONFIG_PATH: path,
            ADMIN_PASSWORD: "",
            MIHOMO_SECRET: "poc",
          },
          encoding: "utf8",
        },
      );
      const content = readFileSync(path, "utf8");
      expect(() => assertSafeGatewayBootstrap(content)).not.toThrow();
      expect(content).not.toContain("MATCH,DIRECT");
      expect(content).toContain("secret: poc");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("boots a fresh prepared deployment in Proxy without guessing local DNS or allowing DIRECT fallback", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-cli-setup-"));
    const path = join(directory, "config.yaml");
    try {
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--conditions=development",
          new URL("./network-bootstrap.ts", import.meta.url).pathname,
        ],
        {
          env: {
            ...process.env,
            DB_PATH: join(directory, "test.db"),
            MIHOMO_CONFIG_PATH: path,
            ADMIN_PASSWORD: "gateway-cli-test-password",
            MIHOMO_SECRET: "gateway-cli-test-secret",
          },
          encoding: "utf8",
        },
      );
      const content = readFileSync(path, "utf8");
      expect(() => assertSafeGatewayBootstrap(content)).not.toThrow();
      expect(content).toContain("enable: false");
      expect(content).not.toContain("MATCH,DIRECT");
      expect(content).not.toContain("nameserver: system");
      const db = createDb(join(directory, "test.db"));
      expect(readNetworkProfile(db)).toEqual({ profile: "proxy" });
      db.$client.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("refuses to boot a preserved proxy-mode or all-DIRECT config as gateway", () => {
    expect(() => assertSafeGatewayBootstrap("mode: rule\nrules: [MATCH,DIRECT]\n")).toThrow();
    const config = `mode: rule\nsecret: secure-test-secret\ndns: {enable: true, enhanced-mode: fake-ip}\ntun: {enable: true}\nproxy-groups: [{proxies: [REJECT]}]\nrules: ["MATCH,REJECT"]\n`;
    expect(() => assertSafeGatewayBootstrap(config)).not.toThrow();
    expect(() => assertSafeGatewayBootstrap(config.replace("[REJECT]", "[DIRECT]"))).toThrow();
  });
  it("allows only the intended terminal Direct catch-all while VPN groups remain closed", () => {
    const config =
      'mode: rule\nsecret: secure-test-secret\ndns: {enable: true, enhanced-mode: fake-ip}\ntun: {enable: true}\nproxy-groups: [{proxies: [REJECT]}]\nrules: ["DOMAIN-SUFFIX,docker.io,AUTO", "MATCH,DIRECT"]\n';
    expect(() => assertSafeGatewayBootstrap(config, "direct")).not.toThrow();
    expect(() => assertSafeGatewayBootstrap(config, "proxy")).toThrow();
    expect(() =>
      assertSafeGatewayBootstrap(config.replace("[REJECT]", "[DIRECT]"), "direct"),
    ).toThrow();
    expect(() =>
      assertSafeGatewayBootstrap(
        config.replace('"DOMAIN-SUFFIX', '"MATCH,DIRECT", "DOMAIN-SUFFIX'),
        "direct",
      ),
    ).toThrow();
  });
});
