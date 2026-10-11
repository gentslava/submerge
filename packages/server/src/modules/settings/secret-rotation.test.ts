import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { createDb } from "../../db/client.js";
import {
  beginMihomoSecretRotation,
  confirmPendingMihomoSecretRotation,
  getMihomoSecretRotationPersistenceState,
  prepareMihomoSecretForBootstrap,
  prepareMihomoSecretForConfig,
  restorePendingMihomoSecretRotation,
  rollbackMihomoSecretRotation,
} from "./secret-rotation.js";
import { getSetting, getSettingsView, setSetting } from "./service.js";

const mihomoClient = vi.hoisted(() => ({
  probe: vi.fn<(secret: string) => Promise<boolean>>(),
  set: vi.fn<(secret: string) => void>(),
  setRecovery:
    vi.fn<(primary: string, fallback: string, onPrimaryAuthenticated?: () => boolean) => void>(),
}));

vi.mock("../../clients/mihomo.js", () => ({
  probeMihomoCredential: mihomoClient.probe,
  setMihomoSecret: mihomoClient.set,
  setMihomoSecretRecovery: mihomoClient.setRecovery,
}));

function freshDb() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mihomo secret rotation journal", () => {
  it("keeps the automatic confirmed credential when resetting a deployment with no explicit seed", () => {
    const db = freshDb();
    const previousSecret = env.MIHOMO_SECRET;
    const previousDeployment = env.GATEWAY_DEPLOYMENT;
    try {
      env.MIHOMO_SECRET = "";
      env.GATEWAY_DEPLOYMENT = true;
      setSetting(db, "mihomoSecret", "automatically-confirmed-secret");
      expect(beginMihomoSecretRotation(db, "").rotation.nextEffective).toBe(
        "automatically-confirmed-secret",
      );
    } finally {
      env.MIHOMO_SECRET = previousSecret;
      env.GATEWAY_DEPLOYMENT = previousDeployment;
    }
  });
  it("automatically upgrades weak bootstrap auth with one durable candidate and retains the old recovery credential", async () => {
    const db = freshDb();
    setSetting(db, "mihomoSecret", "poc");
    const secret = prepareMihomoSecretForBootstrap(db);
    expect(secret).toMatch(/^[a-f0-9]{64}$/u);
    expect(getSetting(db, "mihomoSecret")).toBe("poc");
    expect(mihomoClient.setRecovery).toHaveBeenLastCalledWith(secret, "poc");
    expect(prepareMihomoSecretForBootstrap(db)).toBe(secret);
    mihomoClient.probe.mockResolvedValue(true);
    expect(await confirmPendingMihomoSecretRotation(db)).toBe(true);
    expect(getSetting(db, "mihomoSecret")).toBe(secret);
    expect(prepareMihomoSecretForBootstrap(db)).toBe(secret);
  });
  it("preserves an existing strong confirmed credential during deployment bootstrap", () => {
    const db = freshDb();
    setSetting(db, "mihomoSecret", "existing-confirmed-strong-secret");
    expect(prepareMihomoSecretForBootstrap(db)).toBe("existing-confirmed-strong-secret");
    expect(getSetting(db, "internal.mihomoSecretRotation")).toBeUndefined();
  });
  it.each(["gateway", "proxy", "prepared-proxy"])(
    "captures a TUN deployment blank reset in %s before later environment changes",
    async (mode) => {
      const db = freshDb();
      const previous = env.MIHOMO_SECRET;
      const previousDeployment = env.GATEWAY_DEPLOYMENT;
      try {
        setSetting(
          db,
          "networkProfile",
          JSON.stringify({ profile: "gateway", localResolvers: ["192.168.1.1"] }),
        );
        setSetting(db, "mihomoSecret", "old-gateway-confirmed-secret");
        if (mode === "proxy") {
          setSetting(
            db,
            "internal.gatewayPreferences",
            JSON.stringify({ profile: "gateway", localResolvers: ["192.168.1.1"] }),
          );
          setSetting(db, "networkProfile", JSON.stringify({ profile: "proxy" }));
        }
        if (mode === "prepared-proxy") {
          env.GATEWAY_DEPLOYMENT = true;
          setSetting(db, "networkProfile", JSON.stringify({ profile: "proxy" }));
          expect(getSetting(db, "internal.gatewayPreferences")).toBeUndefined();
        }
        env.MIHOMO_SECRET = "gateway-env-reset-secret";
        const attempt = beginMihomoSecretRotation(db, "");
        mihomoClient.probe.mockResolvedValue(true);
        expect(await confirmPendingMihomoSecretRotation(db)).toBe(true);
        expect(getSetting(db, "mihomoSecret")).toBe("gateway-env-reset-secret");
        expect(getMihomoSecretRotationPersistenceState(db, attempt)).toBe("committed");
        env.MIHOMO_SECRET = "changed-after-reset-secret";
        restorePendingMihomoSecretRotation(db);
        expect(mihomoClient.set).toHaveBeenLastCalledWith("gateway-env-reset-secret");
      } finally {
        env.MIHOMO_SECRET = previous;
        env.GATEWAY_DEPLOYMENT = previousDeployment;
      }
    },
  );
  it("keeps the confirmed secret until the new credential is proved", async () => {
    const db = freshDb();
    setSetting(db, "mihomoSecret", "old-secret");
    const attempt = beginMihomoSecretRotation(db, "new-secret");

    expect(getSetting(db, "mihomoSecret")).toBe("old-secret");
    expect(getSetting(db, "internal.mihomoSecretRotation")).toBeDefined();
    expect(getSettingsView(db)).not.toHaveProperty("internal.mihomoSecretRotation");
    expect(mihomoClient.setRecovery).toHaveBeenCalledWith("new-secret", "old-secret");

    mihomoClient.probe.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(prepareMihomoSecretForConfig(db)).resolves.toEqual({
      pending: true,
      rollbackSafe: true,
      secret: "new-secret",
    });
    expect(getSetting(db, "mihomoSecret")).toBe("old-secret");

    mihomoClient.probe.mockResolvedValueOnce(true);
    await expect(confirmPendingMihomoSecretRotation(db)).resolves.toBe(true);
    expect(getSetting(db, "mihomoSecret")).toBe("new-secret");
    expect(getSetting(db, "internal.mihomoSecretRotation")).toBeUndefined();
    expect(mihomoClient.set).toHaveBeenCalledWith("new-secret");
    expect(attempt.rotation.nextStored).toBe("new-secret");
  });

  it("keeps an accepted crash recovery pending until durable config is confirmed", async () => {
    const db = freshDb();
    setSetting(db, "mihomoSecret", "old-secret");
    beginMihomoSecretRotation(db, "new-secret");
    mihomoClient.setRecovery.mockClear();

    expect(restorePendingMihomoSecretRotation(db)).toBe(true);
    expect(mihomoClient.setRecovery).toHaveBeenCalledWith("new-secret", "old-secret");
    mihomoClient.probe.mockResolvedValueOnce(true);
    await expect(prepareMihomoSecretForConfig(db)).resolves.toEqual({
      pending: true,
      rollbackSafe: false,
      secret: "new-secret",
    });

    expect(getSetting(db, "mihomoSecret")).toBe("old-secret");
    expect(getSetting(db, "internal.mihomoSecretRotation")).toBeDefined();

    mihomoClient.probe.mockResolvedValueOnce(true);
    await expect(confirmPendingMihomoSecretRotation(db)).resolves.toBe(true);
    expect(getSetting(db, "mihomoSecret")).toBe("new-secret");
  });

  it("rolls back a staged journal before config activation", () => {
    const db = freshDb();
    setSetting(db, "mihomoSecret", "old-secret");
    const attempt = beginMihomoSecretRotation(db, "new-secret");

    rollbackMihomoSecretRotation(db, attempt);

    expect(getSetting(db, "mihomoSecret")).toBe("old-secret");
    expect(getSetting(db, "internal.mihomoSecretRotation")).toBeUndefined();
    expect(mihomoClient.set).toHaveBeenLastCalledWith("old-secret");
  });

  it("does not erase a resumed ambiguous journal when a retry fails before activation", () => {
    const db = freshDb();
    setSetting(db, "mihomoSecret", "old-secret");
    const first = beginMihomoSecretRotation(db, "new-secret");
    const journal = getSetting(db, "internal.mihomoSecretRotation");

    const resumed = beginMihomoSecretRotation(db, "new-secret");
    rollbackMihomoSecretRotation(db, resumed);

    expect(first.created).toBe(true);
    expect(resumed.created).toBe(false);
    expect(getSetting(db, "internal.mihomoSecretRotation")).toBe(journal);
    expect(getSetting(db, "mihomoSecret")).toBe("old-secret");
    expect(mihomoClient.set).not.toHaveBeenCalled();
  });

  it("does not restore the old client after the rotation was already finalized", async () => {
    const db = freshDb();
    setSetting(db, "mihomoSecret", "old-secret");
    const attempt = beginMihomoSecretRotation(db, "new-secret");
    mihomoClient.probe.mockResolvedValueOnce(true);
    await expect(confirmPendingMihomoSecretRotation(db)).resolves.toBe(true);
    mihomoClient.set.mockClear();

    rollbackMihomoSecretRotation(db, attempt);

    expect(getSetting(db, "mihomoSecret")).toBe("new-secret");
    expect(getSetting(db, "internal.mihomoSecretRotation")).toBeUndefined();
    expect(mihomoClient.set).toHaveBeenCalledTimes(1);
    expect(mihomoClient.set).toHaveBeenCalledWith("new-secret");
  });

  it("restores the effective credential snapshots even when the environment changes", () => {
    const db = freshDb();
    setSetting(db, "mihomoSecret", "old-secret");
    const originalEnvSecret = env.MIHOMO_SECRET;
    try {
      env.MIHOMO_SECRET = "env-secret-at-start";
      const attempt = beginMihomoSecretRotation(db, "");
      expect(attempt.rotation).toMatchObject({
        nextEffective: "env-secret-at-start",
        nextStored: "",
        previousEffective: "old-secret",
      });

      env.MIHOMO_SECRET = "env-secret-after-restart";
      mihomoClient.setRecovery.mockClear();
      expect(restorePendingMihomoSecretRotation(db)).toBe(true);
      expect(mihomoClient.setRecovery).toHaveBeenCalledWith("env-secret-at-start", "old-secret");
    } finally {
      env.MIHOMO_SECRET = originalEnvSecret;
    }
  });

  it("fails closed when neither pending nor confirmed credentials authenticate", async () => {
    const db = freshDb();
    setSetting(db, "mihomoSecret", "old-secret");
    beginMihomoSecretRotation(db, "new-secret");
    mihomoClient.probe.mockResolvedValue(false);

    await expect(prepareMihomoSecretForConfig(db)).rejects.toThrow(
      "mihomo secret rotation recovery is blocked",
    );
    expect(getSetting(db, "mihomoSecret")).toBe("old-secret");
    expect(getSetting(db, "internal.mihomoSecretRotation")).toBeDefined();
  });

  it("distinguishes pending, committed, and absent mutation outcomes", async () => {
    const db = freshDb();
    setSetting(db, "mihomoSecret", "old-secret");
    const attempt = beginMihomoSecretRotation(db, "new-secret");
    expect(getMihomoSecretRotationPersistenceState(db, attempt)).toBe("pending");

    mihomoClient.probe.mockResolvedValueOnce(true);
    await confirmPendingMihomoSecretRotation(db);
    expect(getMihomoSecretRotationPersistenceState(db, attempt)).toBe("committed");

    const rolledBack = beginMihomoSecretRotation(db, "another-secret");
    rollbackMihomoSecretRotation(db, rolledBack);
    expect(getMihomoSecretRotationPersistenceState(db, rolledBack)).toBe("absent");
  });
});
