import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { readNetworkProfile } from "./modules/gateway/settings.js";
import { assertSafeGatewayBootstrap } from "./network-bootstrap.js";

describe("automatic network bootstrap", () => {
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
});
