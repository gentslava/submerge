import type { Channel, ChannelPoolMember, Proxy as ProxyConfig } from "@submerge/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { channelPool, sources } from "../../db/schema.js";

// mihomo group name a channel's policy targets: the Default channel keeps the
// existing "AUTO" group (Phase 1/2 config is unchanged); every other channel gets
// its own group, namespaced by id so it can't collide with AUTO or another channel.
export function groupNameFor(channel: Channel): string {
  return channel.isDefault ? "AUTO" : `ch-${channel.id}`;
}

export function getPool(db: Db, channelId: string): ChannelPoolMember[] {
  const rows = db.select().from(channelPool).where(eq(channelPool.channelId, channelId)).all();
  return rows.map((row) => ({ kind: row.kind as ChannelPoolMember["kind"], ref: row.ref }));
}

// Replace-all: the pool has no independent identity per member, so the simplest
// correct update is delete-then-reinsert inside one transaction. De-dupe by
// (kind, ref) first — the table's unique index would otherwise reject a repeated
// pair when the same set is submitted twice from the UI.
export function setPool(db: Db, channelId: string, members: ChannelPoolMember[]): void {
  const seen = new Set<string>();
  const deduped: ChannelPoolMember[] = [];
  for (const member of members) {
    const key = `${member.kind}:${member.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(member);
  }
  db.transaction((tx) => {
    tx.delete(channelPool).where(eq(channelPool.channelId, channelId)).run();
    for (const member of deduped) {
      tx.insert(channelPool).values({ channelId, kind: member.kind, ref: member.ref }).run();
    }
  });
}

// Resolve a channel's pool to the concrete proxies it may route through. An empty
// pool means "no restriction" — the channel behaves like Default today and gets
// every enabled proxy. Otherwise, union the pool members: every `source` member
// contributes the proxies that source produced, then every `node` member
// contributes its matching proxy/proxies by name. Refs that resolve to nothing are
// skipped (best-effort — a stale source/node ref must never break config
// generation). Processing runs in two fixed passes (sources, then nodes) rather
// than the pool's storage order — `channel_pool` has no sequence column, and its
// composite unique index means row order from `getPool` isn't guaranteed to match
// insertion order.
export function resolveChannelProxies(
  db: Db,
  channel: Channel,
  allProxies: ProxyConfig[],
): ProxyConfig[] {
  const pool = getPool(db, channel.id);
  if (pool.length === 0) return allProxies;

  const result: ProxyConfig[] = [];
  const seenKeys = new Set<string>();
  const add = (proxy: ProxyConfig): void => {
    const key = `${proxy.server}:${proxy.port}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    result.push(proxy);
  };

  for (const member of pool) {
    if (member.kind !== "source") continue;
    const sourceId = Number(member.ref);
    if (!Number.isFinite(sourceId)) continue;
    const row = db.select().from(sources).where(eq(sources.id, sourceId)).get();
    if (!row) continue;
    for (const proxy of row.proxies) add(proxy);
  }
  for (const member of pool) {
    if (member.kind !== "node") continue;
    for (const proxy of allProxies) {
      if (proxy.name === member.ref) add(proxy);
    }
  }
  return result;
}
