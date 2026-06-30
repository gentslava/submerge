import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { settings } from "../../db/schema.js";

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value;
}

export function getAllSettings(db: Db): Record<string, string> {
  const rows = db.select().from(settings).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// The UI-facing settings: stored DB values plus env-derived read-only fields
// (mihomo secret from env, HWID ensured) that aren't plain settings rows.
export function getSettingsView(db: Db): Record<string, string> {
  return {
    ...getAllSettings(db),
    hwid: getOrCreateHwid(db),
    mihomoSecret: getSetting(db, "mihomoSecret") || env.MIHOMO_SECRET,
  };
}

export function setSetting(db: Db, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

// Stable per-instance HWID (ADR-0002). Prefer DB, then the mirror file, else
// generate. Always persist to DB and mirror to the file (best-effort) so the
// happ-decoder sidecar — which reads HWID_FILE unchanged — uses the same value.
export function getOrCreateHwid(db: Db, file: string = env.HWID_FILE): string {
  const existing = getSetting(db, "hwid");
  if (existing) {
    mirrorHwid(file, existing);
    return existing;
  }
  let hwid = "";
  if (existsSync(file)) {
    try {
      hwid = readFileSync(file, "utf8").trim();
    } catch {
      /* unreadable; fall through to generate */
    }
  }
  if (!hwid) hwid = randomBytes(16).toString("hex");
  setSetting(db, "hwid", hwid);
  mirrorHwid(file, hwid);
  return hwid;
}

function mirrorHwid(file: string, hwid: string): void {
  try {
    writeFileSync(file, hwid);
  } catch {
    /* file path not writable (e.g. local dev without /mihomo) — DB is source of truth */
  }
}
