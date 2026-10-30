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

vi.mock("../../clients/mihomo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../clients/mihomo.js")>()),
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
  it.each(["abc ", "abc\t", "abc\n", "abc\u0001", "abc\u007f", "abc\u0000"])(
    "rejects a new unrepresentable credential before journaling (%j)",
    (secret) => {
      const db = freshDb();
      setSetting(db, "mihomoSecret", "previous-key");
      expect(() => beginMihomoSecretRotation(db, secret)).toThrow();
      expect(getSetting(db, "mihomoSecret")).toBe("previous-key");
      expect(getSetting(db, "internal.mihomoSecretRotation")).toBeUndefined();
      expect(mihomoClient.setRecovery).not.toHaveBeenCalled();
    },
  );
  it.each(["a", "abc", "密码", "café", "🔑", " abc", "\tabc"])(
    "keeps an HTTP-representable manual credential unchanged (%j)",
    (secret) => {
      const db = freshDb();
      setSetting(db, "mihomoSecret", "previous-key");
      const attempt = beginMihomoSecretRotation(db, secret);
      expect(attempt.rotation).toMatchObject({ nextStored: secret, nextEffective: secret });
      expect(mihomoClient.setRecovery).toHaveBeenCalledWith(secret, "previous-key");
    },
  );
  it.each(["abc ", "abc\t", "abc\n", "abc\u0001", "abc\u007f", "abc\u0000"])(
    "does not adopt an unusable first-install environment seed (%j)",
    (secret) => {
      const db = freshDb();
      const previous = env.MIHOMO_SECRET;
      try {
        env.MIHOMO_SECRET = secret;
        expect(() => prepareMihomoSecretForBootstrap(db)).toThrow();
        expect(getSetting(db, "mihomoSecret")).toBeUndefined();
        expect(getSetting(db, "internal.mihomoSecretRotation")).toBeUndefined();
        expect(mihomoClient.setRecovery).not.toHaveBeenCalled();
        env.MIHOMO_SECRET = "abc";
        expect(prepareMihomoSecretForBootstrap(db)).toBe("abc");
      } finally {
        env.MIHOMO_SECRET = previous;
      }
    },
  );
  it.each(["abc ", "abc\t", "abc\n", "abc\u0001", "abc\u007f"])(
    "resumes an existing pending journal without new-admission validation (%j)",
    (secret) => {
      const db = freshDb();
      const journal = JSON.stringify({
        id: "00000000-0000-4000-8000-000000000001",
        version: 2,
        nextEffective: secret,
        nextStored: secret,
        previousEffective: "previous-key",
      });
      setSetting(db, "mihomoSecret", "previous-key");
      setSetting(db, "internal.mihomoSecretRotation", journal);
      expect(prepareMihomoSecretForBootstrap(db)).toBe(secret);
      expect(beginMihomoSecretRotation(db, secret).created).toBe(false);
      expect(getSetting(db, "internal.mihomoSecretRotation")).toBe(journal);
      expect(mihomoClient.setRecovery).toHaveBeenLastCalledWith(secret, "previous-key");
    },
  );
  it("does not validate an unused environment seed or an existing confirmed credential", () => {
    const db = freshDb();
    const previous = env.MIHOMO_SECRET;
    try {
      env.MIHOMO_SECRET = "unused seed ";
      setSetting(db, "mihomoSecret", "existing confirmed ");
      expect(prepareMihomoSecretForBootstrap(db)).toBe("existing confirmed ");
      expect(getSetting(db, "internal.mihomoSecretRotation")).toBeUndefined();
    } finally {
      env.MIHOMO_SECRET = previous;
    }
  });
  it("keeps the automatic confirmed credential when resetting a deployment with no explicit seed", () => {
    const db = freshDb();
    const previousSecret = env.MIHOMO_SECRET;
    try {
      env.MIHOMO_SECRET = "";
      setSetting(
        db,
        "internal.networkSettings",
        JSON.stringify({ mode: "proxy", localResolvers: [] }),
      );
      setSetting(db, "mihomoSecret", "automatically-confirmed-secret");
      expect(beginMihomoSecretRotation(db, "").rotation.nextEffective).toBe(
        "automatically-confirmed-secret",
      );
    } finally {
      env.MIHOMO_SECRET = previousSecret;
    }
  });
  it("generates missing bootstrap auth with one durable candidate and retains recovery", async () => {
    const db = freshDb();
    const previous = env.MIHOMO_SECRET;
    env.MIHOMO_SECRET = "";
    try {
      const secret = prepareMihomoSecretForBootstrap(db);
      expect(secret).toMatch(/^[a-f0-9]{64}$/u);
      expect(getSetting(db, "mihomoSecret")).toBeUndefined();
      expect(mihomoClient.setRecovery).toHaveBeenLastCalledWith(secret, "");
      expect(prepareMihomoSecretForBootstrap(db)).toBe(secret);
      mihomoClient.probe.mockResolvedValue(true);
      expect(await confirmPendingMihomoSecretRotation(db)).toBe(true);
      expect(getSetting(db, "mihomoSecret")).toBe(secret);
      expect(prepareMihomoSecretForBootstrap(db)).toBe(secret);
    } finally {
      env.MIHOMO_SECRET = previous;
    }
  });
  it.each(["a", "abc", "fifteen-letters!"])(
    "preserves the short confirmed credential %s",
    (secret) => {
      const db = freshDb();
      setSetting(db, "mihomoSecret", secret);
      expect(prepareMihomoSecretForBootstrap(db)).toBe(secret);
      expect(getSetting(db, "internal.mihomoSecretRotation")).toBeUndefined();
    },
  );
  it("retains a short pending rotation through bootstrap and successful activation", async () => {
    const db = freshDb();
    setSetting(db, "mihomoSecret", "previous-key");
    beginMihomoSecretRotation(db, "abc");
    expect(prepareMihomoSecretForBootstrap(db)).toBe("abc");
    expect(getSetting(db, "mihomoSecret")).toBe("previous-key");
    mihomoClient.probe.mockResolvedValue(true);
    expect(await confirmPendingMihomoSecretRotation(db)).toBe(true);
    expect(getSetting(db, "mihomoSecret")).toBe("abc");
    expect(prepareMihomoSecretForBootstrap(db)).toBe("abc");
  });
  it.each(["abc", ""])(
    "recovers a legacy blank reset when the engine accepts %j",
    async (engineSecret) => {
      const db = freshDb();
      setSetting(db, "mihomoSecret", "abc");
      setSetting(
        db,
        "internal.mihomoSecretRotation",
        JSON.stringify({
          id: "00000000-0000-4000-8000-000000000001",
          version: 2,
          nextEffective: "",
          nextStored: "",
          previousEffective: "abc",
        }),
      );
      const secret = prepareMihomoSecretForBootstrap(db);
      expect(secret).toMatch(/^[a-f0-9]{64}$/u);
      expect(prepareMihomoSecretForBootstrap(db)).toBe(secret);
      expect(mihomoClient.setRecovery).toHaveBeenLastCalledWith(secret, "abc");
      mihomoClient.probe.mockImplementation(
        async (candidate) => !engineSecret || candidate === engineSecret,
      );
      await expect(prepareMihomoSecretForConfig(db)).resolves.toMatchObject({
        pending: true,
        secret,
        rollbackSafe: Boolean(engineSecret),
      });
      mihomoClient.probe.mockResolvedValue(true);
      expect(await confirmPendingMihomoSecretRotation(db)).toBe(true);
      expect(getSetting(db, "mihomoSecret")).toBe(secret);
    },
  );
  it("persists the captured seed of a legacy blank reset before later environment edits", async () => {
    const db = freshDb();
    const previous = env.MIHOMO_SECRET;
    try {
      env.MIHOMO_SECRET = "changed-before-restart";
      setSetting(db, "mihomoSecret", "previous-key");
      setSetting(
        db,
        "internal.mihomoSecretRotation",
        JSON.stringify({
          id: "00000000-0000-4000-8000-000000000001",
          version: 2,
          nextEffective: "abc",
          nextStored: "",
          previousEffective: "previous-key",
        }),
      );
      expect(prepareMihomoSecretForBootstrap(db)).toBe("abc");
      expect(mihomoClient.setRecovery).toHaveBeenLastCalledWith("abc", "previous-key");
      mihomoClient.probe.mockResolvedValue(true);
      expect(await confirmPendingMihomoSecretRotation(db)).toBe(true);
      expect(getSetting(db, "internal.mihomoSecretRotation")).toBeUndefined();
      expect(getSetting(db, "mihomoSecret")).toBe("abc");
      env.MIHOMO_SECRET = "changed-after-confirmation";
      expect(prepareMihomoSecretForBootstrap(db)).toBe("abc");
    } finally {
      env.MIHOMO_SECRET = previous;
    }
  });
  it("uses a short explicit environment seed for a blank reset", () => {
    const db = freshDb();
    const previous = env.MIHOMO_SECRET;
    try {
      env.MIHOMO_SECRET = "abc";
      setSetting(db, "mihomoSecret", "previous-confirmed-key");
      expect(beginMihomoSecretRotation(db, "").rotation).toMatchObject({
        nextEffective: "abc",
        nextStored: "abc",
        previousEffective: "previous-confirmed-key",
      });
    } finally {
      env.MIHOMO_SECRET = previous;
    }
  });
  it("generates a credential for a blank reset without any seed or confirmed key", () => {
    const db = freshDb();
    const previous = env.MIHOMO_SECRET;
    try {
      env.MIHOMO_SECRET = "";
      const attempt = beginMihomoSecretRotation(db, "");
      expect(attempt.rotation.nextEffective).toMatch(/^[a-f0-9]{64}$/u);
      expect(attempt.rotation.nextStored).toBe(attempt.rotation.nextEffective);
    } finally {
      env.MIHOMO_SECRET = previous;
    }
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
          setSetting(
            db,
            "internal.networkSettings",
            JSON.stringify({ mode: "proxy", localResolvers: [] }),
          );
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
        nextStored: "env-secret-at-start",
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
