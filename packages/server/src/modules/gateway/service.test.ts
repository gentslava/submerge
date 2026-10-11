import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, expect, it, vi } from "vitest";
import { queryDnsResolution } from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import { createDb } from "../../db/client.js";
import { applyConfig } from "../nodes/service.js";
import { configureGateway } from "./service.js";
import { initializeNetworkSettings, readNetworkSettings } from "./settings.js";

vi.mock("../../clients/mihomo.js", async (original) => ({
  ...(await original<typeof import("../../clients/mihomo.js")>()),
  queryDnsResolution: vi.fn(async () => true),
}));
vi.mock("../nodes/service.js", () => ({
  applyConfig: vi.fn(async (_db, _path, _target, options) => {
    options.stageConfigMutation?.();
    return { applied: true };
  }),
  collectActiveRoutingInputs: vi.fn(),
}));
const password = env.ADMIN_PASSWORD;
afterEach(() => {
  env.ADMIN_PASSWORD = password;
  vi.clearAllMocks();
});
function fixture() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  initializeNetworkSettings(db);
  env.ADMIN_PASSWORD = "existing-admin-password";
  return db;
}
it("enables TUN without a home resolver", async () => {
  const db = fixture();
  await configureGateway(db, { mode: "tun", localResolvers: [] });
  expect(readNetworkSettings(db).mode).toBe("tun");
  expect(queryDnsResolution).not.toHaveBeenCalled();
  db.$client.close();
});
it("restores the previous mode after engine rejection", async () => {
  const db = fixture();
  vi.mocked(applyConfig).mockImplementationOnce(async (_db, _path, _target, options) => {
    options?.stageConfigMutation?.();
    throw new Error("engine rejected config");
  });
  await expect(configureGateway(db, { mode: "tun", localResolvers: [] })).rejects.toThrow(
    "Не удалось включить TUN",
  );
  expect(readNetworkSettings(db)).toEqual({ mode: "proxy", localResolvers: [] });
  db.$client.close();
});
it("does not save an unreachable or looping home DNS", async () => {
  const db = fixture();
  vi.mocked(queryDnsResolution).mockResolvedValueOnce(false);
  await expect(
    configureGateway(db, { mode: "proxy", localResolvers: ["192.168.1.1"] }),
  ).rejects.toThrow("Не удалось сохранить DNS");
  expect(readNetworkSettings(db).localResolvers).toEqual([]);
  db.$client.close();
});
