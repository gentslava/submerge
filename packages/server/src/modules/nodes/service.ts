import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NodeItem, NodeMember, NodeView, Proxy as ProxyConfig } from "@submerge/shared";
import { asc, eq } from "drizzle-orm";
import type { ProxiesResponse } from "../../clients/mihomo.js";
import { getDelay, getProxies, reloadConfig, selectProxy } from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import { readDefaultPolicy } from "../channels/service.js";
import { getSetting } from "../settings/service.js";
import { buildConfig } from "./config.js";

// The mihomo API secret — a Settings value wins over the env default (env only seeds it
// on first run). Used BOTH as the panel's client credential AND as the `secret:` written
// into the generated config, so editing it in Settings rotates the engine.
export function readMihomoSecret(db: Db): string {
  return getSetting(db, "mihomoSecret") || env.MIHOMO_SECRET;
}

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
  // fs/permission errors (e.g. EACCES) propagate to the caller (→ tRPC 500).
  mkdirSync(dirname(configPath), { recursive: true });
  // The config's `secret:` is the editable panel secret (seeded from env on first run):
  // the panel owns mihomo's config, so editing the secret rotates the engine too. The
  // settings router re-points the client in a `finally`, so a failed reload can't lock out.
  //
  // Write atomically (temp file + rename) so mihomo never reads a half-written config on
  // reload: an in-place writeFileSync truncates first, and mihomo can catch that empty
  // window — especially across a slow bind mount — and reject the reload with HTTP 400.
  const content = buildConfig(proxies, readDefaultPolicy(db), readMihomoSecret(db));
  const tmpPath = `${configPath}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, configPath);
  await reloadConfig(targetPath);
  return { nodes: proxies.length };
}

const PSEUDO_GROUPS = new Set(["AUTO", "PROXY", "DIRECT", "REJECT", "GLOBAL"]);

// Pure normalization: map a ProxiesResponse to the UI-facing NodeView.
export function toNodeView({ proxies }: ProxiesResponse): NodeView {
  const group = proxies.PROXY;
  if (!group?.all) return { now: null, autoNow: null, all: [] };
  const all: NodeItem[] = group.all.map((name) => {
    const info = proxies[name];
    // A collapsed url-test group: a non-pseudo proxy that carries `all` (its members).
    if (info?.all && !PSEUDO_GROUPS.has(name)) {
      const active = info.now ? proxies[info.now] : undefined;
      const aLast = active?.history.at(-1);
      const members: NodeMember[] = info.all.map((m) => {
        const mInfo = proxies[m];
        const mLast = mInfo?.history.at(-1);
        return {
          name: m,
          delay: mLast && mLast.delay > 0 ? mLast.delay : null,
          history: (mInfo?.history ?? []).map((h) => h.delay),
          active: m === info.now,
        };
      });
      return {
        name,
        type: info.type,
        delay: aLast && aLast.delay > 0 ? aLast.delay : null,
        history: (active?.history ?? []).map((h) => h.delay),
        members,
      };
    }
    const last = info?.history.at(-1);
    // Keep every measurement, including timeouts (mihomo records 0) — the chart
    // renders them as failure spikes so node stability is visible, not hidden.
    const history = (info?.history ?? []).map((h) => h.delay);
    const item: NodeItem = {
      name,
      type: info?.type ?? "unknown",
      delay: last && last.delay > 0 ? last.delay : null,
      history,
    };
    if (info?.udp !== undefined) item.udp = info.udp;
    return item;
  });
  // The AUTO url-test group reports the member it currently routes through via `now`.
  return { now: group.now ?? null, autoNow: proxies.AUTO?.now ?? null, all };
}

// Normalize the mihomo PROXY select group into the UI-facing NodeView.
export async function listNodes(): Promise<NodeView> {
  return toNodeView(await getProxies());
}

export async function testDelay(name: string, url?: string): Promise<number | null> {
  try {
    const { delay } = await getDelay(name, url);
    return delay > 0 ? delay : null;
  } catch {
    return null; // timeout / unreachable node → no delay
  }
}

export async function selectNode(group: string, name: string): Promise<void> {
  await selectProxy(group, name);
}

// A one-shot reachability check (for the Settings "Проверить" button + polling).
export async function checkHealth(): Promise<boolean> {
  try {
    await getProxies();
    return true;
  } catch {
    return false;
  }
}
