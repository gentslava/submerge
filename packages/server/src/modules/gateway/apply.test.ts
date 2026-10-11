import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkProfileSchema } from "@submerge/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { createDb } from "../../db/client.js";
import { ensureDefaultChannel } from "../channels/service.js";
import { applyConfig } from "../nodes/service.js";
import { beginMihomoSecretRotation } from "../settings/secret-rotation.js";
import { getSetting, setSetting } from "../settings/service.js";
import { assertGatewayNetworkActivated } from "./readiness.js";
import { gatewayApplyState, readGatewayPreferences, writeNetworkProfile } from "./settings.js";

vi.mock("./readiness.js", () => ({ assertGatewayNetworkActivated: vi.fn(async () => undefined) }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

const previousPassword = env.ADMIN_PASSWORD;
const previousListsPath = env.GATEWAY_LISTS_PATH;
afterEach(() => {
  env.ADMIN_PASSWORD = previousPassword;
  env.GATEWAY_LISTS_PATH = previousListsPath;
  vi.unstubAllGlobals();
});
function fixture() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  ensureDefaultChannel(db);
  writeNetworkProfile(
    db,
    networkProfileSchema.parse({
      profile: "gateway",
      localResolvers: ["192.168.1.1"],
      ruGeosite: [],
      ruGeoip: [],
    }),
  );
  setSetting(db, "mihomoSecret", "gateway-secure-secret");
  env.ADMIN_PASSWORD = "gateway-secure-password";
  const path = join(mkdtempSync(join(tmpdir(), "gateway-apply-")), "config.yaml");
  writeFileSync(path, "previous valid config");
  return { db, path };
}

describe("gateway apply", () => {
  it.each([Buffer.from("invalid"), "bad\u0000encoding"])(
    "never generates legacy Proxy fallback from corrupt retained TUN settings %j",
    async (value) => {
      const { db, path } = fixture();
      writeNetworkProfile(db, { profile: "proxy" });
      db.$client
        .prepare("UPDATE settings SET value = ? WHERE key = ?")
        .run(value, "internal.gatewayPreferences");
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(applyConfig(db, path)).rejects.toThrow("Invalid persisted TUN preferences");
      expect(fetch).not.toHaveBeenCalled();
      expect(readFileSync(path, "utf8")).toBe("previous valid config");
    },
  );
  it("validates Proxy capture while retaining shared TUN routing and preferences", async () => {
    const { db, path } = fixture();
    const preferences = readGatewayPreferences(db);
    writeNetworkProfile(db, { profile: "proxy" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await expect(applyConfig(db, path)).resolves.toMatchObject({ applied: true });
    expect(assertGatewayNetworkActivated).toHaveBeenCalledWith(preferences, undefined, false);
    expect(readGatewayPreferences(db)).toEqual(preferences);
    expect(readFileSync(path, "utf8")).toContain("enable: false");
    expect(readFileSync(path, "utf8")).not.toContain("MATCH,DIRECT");
  });
  it("waits for asynchronous native file-provider initialization after reload", async () => {
    const { db, path } = fixture();
    env.GATEWAY_LISTS_PATH = mkdtempSync(join(tmpdir(), "gateway-pending-list-"));
    writeFileSync(join(env.GATEWAY_LISTS_PATH, "n.txt"), "+.docs.google.test\n");
    writeNetworkProfile(
      db,
      networkProfileSchema.parse({
        profile: "gateway",
        localResolvers: ["192.168.1.1"],
        ruGeosite: [],
        ruGeoip: [],
        privateLists: [{ name: "n", file: "n.txt", target: "notblocked" }],
      }),
    );
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/providers/rules")
          ? new Response(
              JSON.stringify({
                providers: {
                  "gateway-n": {
                    name: "gateway-n",
                    type: "Rule",
                    behavior: "Domain",
                    format: "Text",
                    vehicleType: "File",
                    ruleCount: ++reads < 3 ? 0 : 1,
                  },
                },
              }),
            )
          : new Response(null, { status: 204 }),
      ),
    );
    await expect(applyConfig(db, path)).resolves.toMatchObject({ applied: true });
    expect(reads).toBe(3);
  });
  it("preserves the file and rolls back when a 204 reload did not create TUN", async () => {
    const { db, path } = fixture();
    const payloads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)).payload);
        return new Response(null, { status: 204 });
      }),
    );
    vi.mocked(assertGatewayNetworkActivated).mockRejectedValueOnce(new Error("missing TUN"));
    await expect(applyConfig(db, path)).rejects.toThrow("network activation failed");
    expect(readFileSync(path, "utf8")).toBe("previous valid config");
    expect(payloads.at(-1)).toBe("previous valid config");
    expect(gatewayApplyState(db)).toBe("failed");
  });
  it("rejects incomplete providers and restores the previous engine payload", async () => {
    const { db, path } = fixture();
    env.GATEWAY_LISTS_PATH = mkdtempSync(join(tmpdir(), "gateway-partial-list-"));
    writeFileSync(
      join(env.GATEWAY_LISTS_PATH, "proxy.txt"),
      "DOMAIN,forced.ru\nINVALID-RULE,ignored.ru\n",
    );
    writeNetworkProfile(
      db,
      networkProfileSchema.parse({
        profile: "gateway",
        localResolvers: ["192.168.1.1"],
        ruGeosite: [],
        ruGeoip: [],
        privateLists: [
          { name: "proxy", file: "proxy.txt", target: "proxy", behavior: "classical" },
        ],
      }),
    );
    const payloads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/providers/rules"))
          return new Response(
            JSON.stringify({
              providers: {
                "gateway-proxy": {
                  name: "gateway-proxy",
                  type: "Rule",
                  behavior: "Classical",
                  format: "Text",
                  vehicleType: "File",
                  ruleCount: 1,
                },
              },
            }),
          );
        payloads.push(JSON.parse(String(init?.body)).payload);
        return new Response(null, { status: 204 });
      }),
    );
    await expect(applyConfig(db, path)).rejects.toThrow("provider activation failed");
    expect(readFileSync(path, "utf8")).toBe("previous valid config");
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toBe("previous valid config");
    expect(gatewayApplyState(db)).toBe("failed");
  });
  it("keeps recovery credentials if publishing an accepted payload fails", async () => {
    const { db, path } = fixture();
    beginMihomoSecretRotation(db, "next-gateway-secure-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/version")
          ? new Response(JSON.stringify({ version: "v-test" }))
          : new Response(null, { status: 204 }),
      ),
    );
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("rename denied");
    });
    await expect(applyConfig(db, path)).rejects.toThrow("rename denied");
    expect(readFileSync(path, "utf8")).toBe("previous valid config");
    expect(getSetting(db, "mihomoSecret")).toBe("gateway-secure-secret");
    expect(getSetting(db, "internal.mihomoSecretRotation")).toBeDefined();
  });
  it("retains both credentials when a reload response is lost before file publication", async () => {
    const { db, path } = fixture();
    const attempt = beginMihomoSecretRotation(db, "next-gateway-secure-secret");
    let newSecretActive = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("Authorization");
        if (url.includes("/version"))
          return new Response(JSON.stringify({ version: "v-test" }), {
            status: (
              newSecretActive
                ? auth?.includes("next-gateway")
                : !auth?.includes("next-gateway")
            )
              ? 200
              : 401,
          });
        if (auth?.includes("next-gateway") && !newSecretActive)
          return new Response(null, { status: 401 });
        newSecretActive = true;
        throw new Error("reload response lost");
      }),
    );
    await expect(applyConfig(db, path)).rejects.toThrow("gateway");
    expect(readFileSync(path, "utf8")).toBe("previous valid config");
    expect(getSetting(db, "mihomoSecret")).toBe(attempt.rotation.previousEffective);
    expect(getSetting(db, "internal.mihomoSecretRotation")).toBeDefined();
  });

  it("publishes an accepted rotated config while retaining recovery until engine restart", async () => {
    const { db, path } = fixture();
    beginMihomoSecretRotation(db, "next-gateway-secure-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("Authorization");
        if (auth?.includes("next-gateway")) return new Response(null, { status: 401 });
        if (url.includes("/version")) return new Response(JSON.stringify({ version: "v-test" }));
        return new Response(null, { status: 204 });
      }),
    );
    await expect(applyConfig(db, path)).rejects.toThrow("restart Mihomo");
    expect(readFileSync(path, "utf8")).toContain("secret: next-gateway-secure-secret");
    expect(getSetting(db, "mihomoSecret")).toBe("gateway-secure-secret");
    expect(getSetting(db, "internal.mihomoSecretRotation")).toBeDefined();
  });
  it("submits candidate payload before publishing it to disk", async () => {
    const { db, path } = fixture();
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(readFileSync(path, "utf8")).toBe("previous valid config");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        path: "",
        payload: expect.stringContaining("fake-ip"),
      });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetch);
    expect(await applyConfig(db, path, "/engine/config.yaml")).toMatchObject({ applied: true });
    expect(readFileSync(path, "utf8")).toContain("fake-ip");
    expect(gatewayApplyState(db)).toBe("applied");
  });

  it("preserves the last file and throws explicitly on rejected configuration", async () => {
    const { db, path } = fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"message":"bad tun"}', { status: 400 })),
    );
    await expect(applyConfig(db, path, "/engine/config.yaml")).rejects.toThrow("gateway");
    expect(readFileSync(path, "utf8")).toBe("previous valid config");
    expect(gatewayApplyState(db)).toBe("failed");
  });

  it("refuses an unsecured gateway before calling Mihomo", async () => {
    const { db, path } = fixture();
    env.ADMIN_PASSWORD = "";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(applyConfig(db, path)).rejects.toThrow("ADMIN_PASSWORD");
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe("previous valid config");
  });
});
