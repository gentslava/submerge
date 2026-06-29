import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NodeItem, NodeView, Proxy as ProxyConfig } from "@submerge/shared";
import { asc, eq } from "drizzle-orm";
import { getDelay, getProxies, reloadConfig, selectProxy } from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import { buildConfig } from "./config.js";

// Gather proxy snapshots from enabled sources, ordered by sortOrder then id.
export function collectProxies(db: Db): ProxyConfig[] {
  const rows = db
    .select()
    .from(sources)
    .where(eq(sources.enabled, true))
    .orderBy(asc(sources.sortOrder), asc(sources.id))
    .all();
  return rows.flatMap((r) => r.proxies);
}

export interface ApplyResult {
  nodes: number;
}

// Generate the config from current sources, write it, and reload mihomo.
export async function applyConfig(
  db: Db,
  configPath: string = env.MIHOMO_CONFIG_PATH,
  targetPath: string = env.MIHOMO_CONFIG_TARGET,
): Promise<ApplyResult> {
  const proxies = collectProxies(db);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, buildConfig(proxies), "utf8");
  await reloadConfig(targetPath);
  return { nodes: proxies.length };
}

// Normalize the mihomo PROXY select group into the UI-facing NodeView.
export async function listNodes(): Promise<NodeView> {
  const { proxies } = await getProxies();
  const group = proxies.PROXY;
  if (!group?.all) return { now: null, all: [] };
  const all: NodeItem[] = group.all.map((name) => {
    const info = proxies[name];
    const last = info?.history.at(-1);
    const item: NodeItem = {
      name,
      type: info?.type ?? "unknown",
      delay: last && last.delay > 0 ? last.delay : null,
    };
    if (info?.udp !== undefined) item.udp = info.udp;
    return item;
  });
  return { now: group.now ?? null, all };
}

export async function testDelay(name: string): Promise<number | null> {
  try {
    const { delay } = await getDelay(name);
    return delay > 0 ? delay : null;
  } catch {
    return null; // timeout / unreachable node → no delay
  }
}

export async function selectNode(group: string, name: string): Promise<void> {
  await selectProxy(group, name);
}
