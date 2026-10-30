import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { initializeNetworkSettings } from "./modules/gateway/settings.js";
import { readMihomoBootstrapSecret } from "./modules/settings/secret-rotation.js";
import { setSetting } from "./modules/settings/service.js";

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

describe("application credential startup", () => {
  it.each([
    { name: "manual environment seed", prepared: true, seed: "abc", saved: "", pending: false },
    { name: "saved manual credential", prepared: true, seed: "", saved: "abc", pending: false },
    { name: "empty prepared installation", prepared: true, seed: "", saved: "", pending: false },
    {
      name: "empty installation without Compose init",
      prepared: false,
      seed: "",
      saved: "",
      pending: false,
    },
    {
      name: "interrupted legacy blank reset",
      prepared: false,
      seed: "",
      saved: "abc",
      pending: true,
    },
  ])(
    "starts with $name",
    async ({ prepared, seed, saved, pending }) => {
      const directory = mkdtempSync(join(tmpdir(), "submerge-startup-secret-"));
      const databasePath = join(directory, "test.db");
      const db = createDb(databasePath);
      migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
      if (prepared) initializeNetworkSettings(db);
      if (saved) setSetting(db, "mihomoSecret", saved);
      if (pending)
        setSetting(
          db,
          "internal.mihomoSecretRotation",
          JSON.stringify({
            id: "00000000-0000-4000-8000-000000000001",
            version: 2,
            nextEffective: "",
            nextStored: "",
            previousEffective: saved,
          }),
        );
      db.$client.close();
      const port = await unusedPort();
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--conditions=development",
          new URL("./index.ts", import.meta.url).pathname,
        ],
        {
          env: {
            ...process.env,
            DB_PATH: databasePath,
            MIHOMO_CONFIG_PATH: join(directory, "config.yaml"),
            HWID_FILE: join(directory, "hwid.txt"),
            PORT: String(port),
            HOST: "127.0.0.1",
            MIHOMO_SECRET: seed,
            ADMIN_PASSWORD: "",
            COOKIE_SECURE: "false",
            MIHOMO_API: "http://127.0.0.1:9",
            HAPP_DECODER_URL: "http://127.0.0.1:9",
            DOMAIN_RULES_MODE: "report",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        let ready = false;
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          if (child.exitCode !== null) throw new Error(`Application exited: ${output}`);
          try {
            const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
              signal: AbortSignal.timeout(250),
            });
            if (response.ok) {
              ready = true;
              break;
            }
          } catch {
            /* Wait for the child listener. */
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(ready, output).toBe(true);
        const opened = createDb(databasePath);
        try {
          const secret = readMihomoBootstrapSecret(opened);
          if (!pending && (saved || seed)) expect(secret).toBe(saved || seed);
          else expect(secret).toMatch(/^[a-f0-9]{64}$/u);
        } finally {
          opened.$client.close();
        }
      } finally {
        child.kill("SIGTERM");
        const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
        await exited;
        clearTimeout(kill);
        rmSync(directory, { recursive: true, force: true });
      }
    },
    15000,
  );
});
