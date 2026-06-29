import type { AddSourceInput, Source } from "@submerge/shared";
import { asc, eq, sql } from "drizzle-orm";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import { applyConfig } from "../nodes/service.js";
import { getOrCreateHwid } from "../settings/service.js";
import { ingestSource } from "./ingest.js";

// Map a DB row to the shared Source shape (proxies already decoded by Drizzle json mode).
function toSource(row: typeof sources.$inferSelect): Source {
  return {
    id: row.id,
    kind: row.kind as Source["kind"],
    value: row.value,
    label: row.label,
    hwid: row.hwid,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    proxies: row.proxies,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

export async function listSources(db: Db): Promise<Source[]> {
  const rows = db.select().from(sources).orderBy(asc(sources.sortOrder), asc(sources.id)).all();
  return rows.map(toSource);
}

export async function addSource(
  db: Db,
  input: AddSourceInput,
  configPath: string = env.MIHOMO_CONFIG_PATH,
  hwidFile: string = env.HWID_FILE,
): Promise<Source> {
  const hwid = input.hwid ? getOrCreateHwid(db, hwidFile) : "";
  const result = await ingestSource(input.value, input.hwid, hwid);
  const maxRow = db
    .select({ max: sql<number>`coalesce(max(${sources.sortOrder}), -1)` })
    .from(sources)
    .get();
  const sortOrder = (maxRow?.max ?? -1) + 1;
  const row = db
    .insert(sources)
    .values({
      kind: result.kind,
      value: input.value,
      label: result.label,
      hwid: input.hwid,
      sortOrder,
      proxies: result.proxies,
    })
    .returning()
    .get();
  await applyConfig(db, configPath);
  return toSource(row);
}

export async function removeSource(
  db: Db,
  id: number,
  configPath: string = env.MIHOMO_CONFIG_PATH,
): Promise<void> {
  db.delete(sources).where(eq(sources.id, id)).run();
  await applyConfig(db, configPath);
}

export async function refreshSource(
  db: Db,
  id: number,
  configPath: string = env.MIHOMO_CONFIG_PATH,
  hwidFile: string = env.HWID_FILE,
): Promise<Source> {
  const row = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!row) throw new Error(`source ${id} not found`);
  const hwid = row.hwid ? getOrCreateHwid(db, hwidFile) : "";
  const result = await ingestSource(row.value, row.hwid, hwid);
  const updated = db
    .update(sources)
    .set({ label: result.label, proxies: result.proxies, updatedAt: sql`(current_timestamp)` })
    .where(eq(sources.id, id))
    .returning()
    .get();
  await applyConfig(db, configPath);
  return toSource(updated);
}

export async function toggleSource(
  db: Db,
  id: number,
  configPath: string = env.MIHOMO_CONFIG_PATH,
): Promise<Source> {
  const row = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!row) throw new Error(`source ${id} not found`);
  const updated = db
    .update(sources)
    .set({ enabled: !row.enabled })
    .where(eq(sources.id, id))
    .returning()
    .get();
  await applyConfig(db, configPath);
  return toSource(updated);
}

export async function reorderSources(
  db: Db,
  ids: number[],
  configPath: string = env.MIHOMO_CONFIG_PATH,
): Promise<void> {
  db.transaction((tx) => {
    ids.forEach((id, index) => {
      tx.update(sources).set({ sortOrder: index }).where(eq(sources.id, id)).run();
    });
  });
  await applyConfig(db, configPath);
}
