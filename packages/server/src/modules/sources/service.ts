import type { AddSourceInput, Source } from "@submerge/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import { applyConfig } from "../nodes/service.js";
import { getOrCreateHwid } from "../settings/service.js";
import { ingestSource } from "./ingest.js";
import { extractSubUrl } from "./parse.js";

// One-shot backfill of sub_url for rows added before the column existed, so they
// participate in dedup without waiting for a refresh. Only the network-free kinds:
// sub/deep-links resolve synchronously via extractSubUrl. happ needs a decode, so
// those rows backfill on their next refresh instead. Idempotent — call on boot.
export function backfillSubUrls(db: Db): void {
  const rows = db
    .select()
    .from(sources)
    .where(and(isNull(sources.subUrl), eq(sources.kind, "sub")))
    .all();
  for (const row of rows) {
    const url = extractSubUrl(row.value);
    if (url) db.update(sources).set({ subUrl: url }).where(eq(sources.id, row.id)).run();
  }
}

// Map a DB row to the shared Source shape (proxies already decoded by Drizzle json mode).
function toSource(row: typeof sources.$inferSelect): Source {
  return {
    id: row.id,
    // kind is always written as a valid SourceKind by ingestSource
    kind: row.kind as Source["kind"],
    value: row.value,
    label: row.label,
    hwid: row.hwid,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    proxies: row.proxies,
    meta: row.meta ?? null,
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
): Promise<{ source: Source; skipped: string[]; applied: boolean }> {
  const value = input.value.trim();
  // Reject an already-added source (same value) up front — before any decode/network
  // work — so the same subscription can't be added twice.
  const existing = db.select().from(sources).where(eq(sources.value, value)).get();
  if (existing) throw new Error("Источник уже добавлен");
  const hwid = input.hwid ? getOrCreateHwid(db, hwidFile) : "";
  const result = await ingestSource(value, input.hwid, hwid);
  // Second dedup gate, post-ingest: the raw value can differ for the SAME
  // subscription (happ crypt5 ciphertexts are non-deterministic; deep-links wrap
  // the same URL) — compare by the resolved sub URL.
  if (result.subUrl) {
    const same = db.select().from(sources).where(eq(sources.subUrl, result.subUrl)).get();
    if (same) throw new Error(`Источник уже добавлен — та же подписка, что «${same.label}»`);
  }
  const maxRow = db
    .select({ max: sql<number>`coalesce(max(${sources.sortOrder}), -1)` })
    .from(sources)
    .get();
  const sortOrder = (maxRow?.max ?? -1) + 1;
  const row = db
    .insert(sources)
    .values({
      kind: result.kind,
      value,
      subUrl: result.subUrl,
      label: result.label,
      hwid: input.hwid,
      sortOrder,
      proxies: result.proxies,
      meta: result.meta,
    })
    .returning()
    .get();
  const { applied } = await applyConfig(db, configPath);
  return { source: toSource(row), skipped: result.skipped, applied };
}

export async function removeSource(
  db: Db,
  id: number,
  configPath: string = env.MIHOMO_CONFIG_PATH,
): Promise<{ applied: boolean }> {
  // idempotent: deleting a missing id is a no-op (no throw), unlike toggle/refresh
  db.delete(sources).where(eq(sources.id, id)).run();
  const { applied } = await applyConfig(db, configPath);
  return { applied };
}

export async function refreshSource(
  db: Db,
  id: number,
  configPath: string = env.MIHOMO_CONFIG_PATH,
  hwidFile: string = env.HWID_FILE,
): Promise<{ source: Source; applied: boolean }> {
  const row = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!row) throw new Error(`source ${id} not found`);
  const hwid = row.hwid ? getOrCreateHwid(db, hwidFile) : "";
  const result = await ingestSource(row.value, row.hwid, hwid);
  const updated = db
    .update(sources)
    .set({
      label: result.label,
      // Backfills pre-migration rows: their sub URL becomes known on first refresh.
      subUrl: result.subUrl,
      proxies: result.proxies,
      meta: result.meta,
      updatedAt: sql`(current_timestamp)`,
    })
    .where(eq(sources.id, id))
    .returning()
    .get();
  const { applied } = await applyConfig(db, configPath);
  return { source: toSource(updated), applied };
}

export async function toggleSource(
  db: Db,
  id: number,
  configPath: string = env.MIHOMO_CONFIG_PATH,
): Promise<{ source: Source; applied: boolean }> {
  const row = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!row) throw new Error(`source ${id} not found`);
  const updated = db
    .update(sources)
    .set({ enabled: !row.enabled })
    .where(eq(sources.id, id))
    .returning()
    .get();
  const { applied } = await applyConfig(db, configPath);
  return { source: toSource(updated), applied };
}

export async function reorderSources(
  db: Db,
  ids: number[],
  configPath: string = env.MIHOMO_CONFIG_PATH,
): Promise<{ applied: boolean }> {
  db.transaction((tx) => {
    ids.forEach((id, index) => {
      tx.update(sources).set({ sortOrder: index }).where(eq(sources.id, id)).run();
    });
  });
  const { applied } = await applyConfig(db, configPath);
  return { applied };
}
