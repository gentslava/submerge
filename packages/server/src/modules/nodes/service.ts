import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type NodeItem,
  type NodeMember,
  type NodeView,
  type Proxy as ProxyConfig,
  PSEUDO_NODE_SET,
} from "@submerge/shared";
import { asc, eq } from "drizzle-orm";
import type { ProxiesResponse } from "../../clients/mihomo.js";
import { getDelay, getProxies, reloadConfig, selectProxy } from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import { log } from "../../log.js";
import { groupNameFor, resolveChannelProxies } from "../channels/pool.js";
import { listChannels } from "../channels/service.js";
import { getSetting } from "../settings/service.js";
import type { ChannelConfigInput } from "./multiConfig.js";
import { buildMultiConfig } from "./multiConfig.js";

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
  // false = the config was persisted (DB + file) but the engine reload failed —
  // e.g. mihomo is down. It applies on the engine's next successful reload, so
  // callers must report "saved, engine pending", never a hard failure.
  applied: boolean;
}

// Generate the config from current sources, write it, and reload mihomo.
export async function applyConfig(
  db: Db,
  configPath: string = env.MIHOMO_CONFIG_PATH,
  targetPath: string = env.MIHOMO_CONFIG_TARGET,
): Promise<ApplyResult> {
  const allProxies = collectProxies(db);
  // fs/permission errors (e.g. EACCES) propagate to the caller (→ tRPC 500).
  mkdirSync(dirname(configPath), { recursive: true });
  // The config's `secret:` is the editable panel secret (seeded from env on first run):
  // the panel owns mihomo's config, so editing the secret rotates the engine too. The
  // settings router re-points the client in a `finally`, so a failed reload can't lock out.
  //
  // Write atomically (temp file + rename) so mihomo never reads a half-written config on
  // reload: an in-place writeFileSync truncates first, and mihomo can catch that empty
  // window — especially across a slow bind mount — and reject the reload with HTTP 400.
  const inputs: ChannelConfigInput[] = listChannels(db).map((ch) => ({
    id: ch.id,
    groupName: groupNameFor(ch),
    isDefault: ch.isDefault,
    policy: ch.policy,
    domains: ch.matcher.domains,
    proxies: resolveChannelProxies(db, ch, allProxies),
  }));
  const content = buildMultiConfig(inputs, readMihomoSecret(db));
  const tmpPath = `${configPath}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, configPath);
  // The reload is the only network step — its failure must not read as "not saved":
  // the DB row and the config file are already updated. fs errors above still throw.
  try {
    await reloadConfig(targetPath);
  } catch (err) {
    log.warn({ err }, "config written but mihomo reload failed — applies on next reload");
    return { nodes: allProxies.length, applied: false };
  }
  return { nodes: allProxies.length, applied: true };
}

// Transport + security of a node, keyed by name. mihomo's /proxies doesn't expose
// these, so we join them from the stored ProxyConfig (the source of truth) for the
// node's second badge — "Reality" / "WS" / "TCP" — instead of the uniform "UDP" flag.
export interface ProxyMeta {
  network?: string;
  security: "reality" | "tls" | "none" | "amneziawg";
}

// Derive a name → { network, security } lookup from stored proxy configs. First
// entry wins for duplicate names (same-named servers get collapsed into one group).
export function proxyMeta(proxies: ProxyConfig[]): Map<string, ProxyMeta> {
  const map = new Map<string, ProxyMeta>();
  for (const p of proxies) {
    if (map.has(p.name)) continue;
    const network = typeof p.network === "string" ? p.network : undefined;
    const security = p["amnezia-wg-option"]
      ? "amneziawg"
      : p["reality-opts"]
        ? "reality"
        : p.tls === true
          ? "tls"
          : "none";
    map.set(p.name, network !== undefined ? { network, security } : { security });
  }
  return map;
}

// Pure normalization: map a ProxiesResponse to the UI-facing NodeView. `meta` joins
// transport/security from the stored configs (mihomo's /proxies omits them).
export function toNodeView({ proxies }: ProxiesResponse, meta?: Map<string, ProxyMeta>): NodeView {
  const group = proxies.PROXY;
  if (!group?.all) return { now: null, autoNow: null, all: [] };
  const all: NodeItem[] = group.all.map((name) => {
    const info = proxies[name];
    // A collapsed url-test group: a non-pseudo proxy that carries `all` (its members).
    if (info?.all && !PSEUDO_NODE_SET.has(name)) {
      const active = info.now ? proxies[info.now] : undefined;
      const aLast = active?.history.at(-1);
      const members: NodeMember[] = info.all.map((m) => {
        const mInfo = proxies[m];
        const mLast = mInfo?.history.at(-1);
        return {
          name: m,
          // A recorded measurement wins, INCLUDING a timeout (0) — the UI renders 0
          // as "таймаут", distinct from null ("— ms" = never measured / after reload).
          delay: mLast ? mLast.delay : null,
          history: (mInfo?.history ?? []).map((h) => h.delay),
          active: m === info.now,
        };
      });
      return {
        name,
        type: info.type,
        delay: aLast ? aLast.delay : null,
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
      // A recorded measurement wins, INCLUDING a timeout (0) → UI shows "таймаут";
      // null ("— ms") means genuinely unmeasured (empty history / after a reload).
      delay: last ? last.delay : null,
      history,
    };
    if (info?.udp !== undefined) item.udp = info.udp;
    const pm = meta?.get(name);
    if (pm) {
      if (pm.network) item.network = pm.network;
      item.security = pm.security;
    }
    return item;
  });
  // The AUTO url-test group reports the member it currently routes through via `now`.
  return { now: group.now ?? null, autoNow: proxies.AUTO?.now ?? null, all };
}

// Normalize the mihomo PROXY select group into the UI-facing NodeView, joining
// transport/security from the DB's proxy configs for the node badges.
export async function listNodes(db: Db): Promise<NodeView> {
  return toNodeView(await getProxies(), proxyMeta(collectProxies(db)));
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
