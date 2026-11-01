import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, expect, it, vi } from "vitest";
import { queryDnsResolution } from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import { createDb } from "../../db/client.js";
import { applyConfig } from "../nodes/service.js";
import { NetworkActivationError } from "./readiness.js";
import { configureGateway } from "./service.js";
import {
  initializeNetworkSettings,
  readNetworkSettings,
  writeNetworkSettings,
} from "./settings.js";

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

it("reports the failed network check when switching mode without exposing raw causes", async () => {
  const db = fixture();
  vi.mocked(applyConfig).mockImplementationOnce(async (_db, _path, _target, options) => {
    options?.stageConfigMutation?.();
    throw new Error("network activation failed", {
      cause: new NetworkActivationError("udp", { cause: new Error("private-controller-token") }),
    });
  });
  const error = await configureGateway(db, { mode: "tun", localResolvers: [] }).catch(
    (error: unknown) => error,
  );
  expect((error as Error).message).toContain("Не удалось включить TUN");
  expect((error as Error).message).toContain("DNS UDP самого Mihomo");
  expect((error as Error).message).not.toContain("private-controller-token");
  expect(readNetworkSettings(db)).toEqual({ mode: "proxy", localResolvers: [] });
  db.$client.close();
});

it.each([
  {
    mode: "tun",
    reason: "tunDisabled",
    message: "Не удалось включить TUN. После загрузки конфига Mihomo сообщил, что TUN выключен.",
  },
  {
    mode: "proxy",
    reason: "tunEnabled",
    message:
      "Не удалось переключиться на прокси. После загрузки конфига Mihomo сообщил, что TUN всё ещё включён.",
  },
  {
    mode: "tun",
    reason: "tunUnknown",
    message:
      "Не удалось включить TUN. API Mihomo не вернул состояние TUN. Проверить переключение не удалось.",
  },
  {
    mode: "proxy",
    reason: "tunUnknown",
    message:
      "Не удалось переключиться на прокси. API Mihomo не вернул состояние TUN. Проверить переключение не удалось.",
  },
] as const)(
  "reports $reason when switching to $mode and restores the saved mode",
  async ({ mode, reason, message }) => {
    const db = fixture();
    const previous = {
      mode: mode === "tun" ? ("proxy" as const) : ("tun" as const),
      localResolvers: [],
    };
    writeNetworkSettings(db, previous);
    vi.mocked(applyConfig).mockImplementationOnce(async (_db, _path, _target, options) => {
      options?.stageConfigMutation?.();
      throw new Error("activation failed", { cause: new NetworkActivationError(reason) });
    });
    await expect(configureGateway(db, { mode, localResolvers: [] })).rejects.toThrow(message);
    expect(readNetworkSettings(db)).toEqual(previous);
    db.$client.close();
  },
);
