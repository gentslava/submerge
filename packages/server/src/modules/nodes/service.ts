import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type NodeItem,
  type NodeMember,
  type NodeView,
  type Proxy as ProxyConfig,
  PSEUDO_NODE_SET,
} from "@submerge/shared";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import type { MihomoProxy, ProxiesResponse } from "../../clients/mihomo.js";
import {
  getDelay,
  getProxies,
  historyForUrl,
  reloadConfig,
  selectProxy,
} from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { excludedNodes, sources } from "../../db/schema.js";
import { log } from "../../log.js";
import { groupNameFor, resolveChannelProxies } from "../channels/pool.js";
import { resolveMatcherDomains } from "../channels/presets.js";
import { listChannels, policyProbe, readDefaultPolicy } from "../channels/service.js";
import { getSetting } from "../settings/service.js";
import { groupProxies } from "./config.js";
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

// The global deny-list of excluded node names (see excluded_nodes).
export function getExcludedSet(db: Db): Set<string> {
  return new Set(
    db
      .select()
      .from(excludedNodes)
      .all()
      .map((r) => r.name),
  );
}

export function setExcluded(db: Db, name: string, excluded: boolean): void {
  if (excluded) db.insert(excludedNodes).values({ name }).onConflictDoNothing().run();
  else db.delete(excludedNodes).where(eq(excludedNodes.name, name)).run();
}

export interface ApplyResult {
  nodes: number;
  // false = the config was persisted (DB + file) but the engine reload failed —
  // e.g. mihomo is down. It applies on the engine's next successful reload, so
  // callers must report "saved, engine pending", never a hard failure.
  applied: boolean;
}

// Read the config currently on disk, or null if it doesn't exist / can't be read.
// Used to skip a needless reload when the freshly generated config is byte-identical.
function readExistingConfig(configPath: string): string | null {
  try {
    return readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
}

// Generate the config from current sources, write it, and reload mihomo.
//
// `force` bypasses the "skip reload when unchanged" guard: a mihomo reload is
// DESTRUCTIVE (the engine rebuilds every proxy/group and loses its in-memory delay
// history — blanking the latency charts), so when the generated config is byte-identical
// to what's already on disk we skip the write + reload entirely and let mihomo keep its
// history. Config generation is deterministic (the byte-identity gate in config.test.ts),
// so identical inputs → identical bytes → a safe skip. `force` is for engine-reconnect
// recovery (onReconnect): a restarted mihomo may have lost our config even though the DB
// didn't change, so we must push it regardless of the on-disk match.
export async function applyConfig(
  db: Db,
  configPath: string = env.MIHOMO_CONFIG_PATH,
  targetPath: string = env.MIHOMO_CONFIG_TARGET,
  opts: { force?: boolean } = {},
): Promise<ApplyResult> {
  const allProxies = collectProxies(db);
  // Global deny-list: excluded names are dropped from the whole config — never
  // defined, pinged, routed, or in PROXY. `keep` filters both the inventory and each
  // channel's resolved pool (a source-ref pool can otherwise re-introduce them).
  const excluded = getExcludedSet(db);
  const keep = (ps: ProxyConfig[]): ProxyConfig[] => ps.filter((p) => !excluded.has(p.name));
  const inventory = keep(allProxies);
  // fs/permission errors (e.g. EACCES) propagate to the caller (→ tRPC 500).
  mkdirSync(dirname(configPath), { recursive: true });
  // The config's `secret:` is the editable panel secret (seeded from env on first run):
  // the panel owns mihomo's config, so editing the secret rotates the engine too. The
  // settings router re-points the client in a `finally`, so a failed reload can't lock out.
  //
  // Write atomically (temp file + rename) so mihomo never reads a half-written config on
  // reload: an in-place writeFileSync truncates first, and mihomo can catch that empty
  // window — especially across a slow bind mount — and reject the reload with HTTP 400.
  // A disabled non-default channel is dropped from routing entirely — no group,
  // no DOMAIN-SUFFIX rules — until re-enabled. The Default is the catch-all and
  // stays active regardless of its own `enabled` flag.
  const inputs: ChannelConfigInput[] = listChannels(db)
    .filter((ch) => ch.isDefault || ch.enabled)
    .map((ch) => {
      const pool = keep(resolveChannelProxies(db, ch, allProxies));
      const base = {
        id: ch.id,
        groupName: groupNameFor(ch),
        isDefault: ch.isDefault,
        policy: ch.policy,
        domains: resolveMatcherDomains(ch.matcher),
        keywords: ch.matcher.keywords,
        ruleProviders: ch.matcher.ruleProviders,
        geosite: ch.matcher.geosite,
        geoip: ch.matcher.geoip,
      };
      // The Default channel DEFINES the whole (non-excluded) inventory — every node is
      // written to the config, pinged by the prober, and manually selectable via PROXY
      // — while its AUTO group RACES only the pool. Other channels define + race their
      // pool. Excluded nodes are already filtered out of both `inventory` and `pool`.
      return ch.isDefault
        ? { ...base, proxies: inventory, race: pool }
        : { ...base, proxies: pool };
    });
  const content = buildMultiConfig(inputs, readMihomoSecret(db));
  // Unchanged config → skip the write + the destructive reload so mihomo keeps its
  // delay history (the charts don't blank on every no-op apply — rename, re-saved
  // setting, redundant re-apply). Genuine changes (policy, pool, sources) differ and
  // still reload. `force` (reconnect recovery) always pushes.
  if (!opts.force && readExistingConfig(configPath) === content) {
    return { nodes: inventory.length, applied: true };
  }
  const tmpPath = `${configPath}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, configPath);
  // The reload is the only network step — its failure must not read as "not saved":
  // the DB row and the config file are already updated. fs errors above still throw.
  try {
    await reloadConfig(targetPath);
  } catch (err) {
    log.warn({ err }, "config written but mihomo reload failed — applies on next reload");
    return { nodes: inventory.length, applied: false };
  }
  return { nodes: inventory.length, applied: true };
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
// transport/security from the stored configs (mihomo's /proxies omits them). `testUrl`
// is the active policy's test URL: mihomo keeps a per-URL history in `extra[testUrl]`,
// which is the series AUTO actually decides on — we report that, not the shared
// `history` (last probe by any URL, e.g. a different channel's youtube/t.me check).
export function toNodeView(
  { proxies }: ProxiesResponse,
  meta?: Map<string, ProxyMeta>,
  testUrl?: string,
): NodeView {
  // The delay series to surface for a node: the per-URL history for the active
  // policy when mihomo has one, else the shared history (fallback — a fresh node
  // or one right after a reload has no per-URL entry yet).
  const delaysOf = (info: MihomoProxy | undefined): number[] =>
    historyForUrl(info, testUrl).map((h) => h.delay);
  // A recorded measurement wins, INCLUDING a timeout (0) → UI shows "таймаут";
  // null ("— ms") means genuinely unmeasured (empty history / after a reload).
  const lastDelay = (ds: number[]): number | null =>
    ds.length ? (ds[ds.length - 1] as number) : null;

  const group = proxies.PROXY;
  if (!group?.all) return { now: null, autoNow: null, all: [] };
  const all: NodeItem[] = group.all.map((name) => {
    const info = proxies[name];
    // A collapsed url-test group: a non-pseudo proxy that carries `all` (its members).
    if (info?.all && !PSEUDO_NODE_SET.has(name)) {
      const active = info.now ? proxies[info.now] : undefined;
      const aDelays = delaysOf(active);
      const members: NodeMember[] = info.all.map((m) => {
        const mDelays = delaysOf(proxies[m]);
        return {
          name: m,
          delay: lastDelay(mDelays),
          history: mDelays,
          active: m === info.now,
        };
      });
      return {
        name,
        type: info.type,
        delay: lastDelay(aDelays),
        history: aDelays,
        members,
      };
    }
    // Keep every measurement, including timeouts (mihomo records 0) — the chart
    // renders them as failure spikes so node stability is visible, not hidden.
    const history = delaysOf(info);
    const item: NodeItem = {
      name,
      type: info?.type ?? "unknown",
      delay: lastDelay(history),
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

// Append DB-inventory nodes absent from the live /proxies view as idle rows. The
// inventory (enabled sources' proxies) is the source of truth for WHICH nodes exist;
// /proxies only reflects what's currently in the engine config, so a channel pool that
// excludes some nodes would otherwise make them vanish from the UI — and, being gone
// from the list, they could never be re-added (the pool-picker trap). Live nodes keep
// their /proxies data untouched; a DB-only node shows idle (delay null) until it
// re-enters the config. Same-name proxies are collapsed by groupProxies exactly as the
// config generator does, so an appended group's name matches its eventual engine name.
export function mergeDbInventory(
  view: NodeView,
  dbProxies: ProxyConfig[],
  meta: Map<string, ProxyMeta>,
  excluded: Set<string> = new Set(),
): NodeView {
  const present = new Set(view.all.map((n) => n.name));
  const extra: NodeItem[] = [];
  for (const entry of groupProxies(dbProxies)) {
    const name = entry.kind === "single" ? entry.proxy.name : entry.base;
    if (present.has(name)) continue;
    // Excluded nodes are dropped from the config, so they're always DB-only here —
    // mark them so the UI can grey them + offer to re-include.
    const isExcluded = excluded.has(name);
    if (entry.kind === "group") {
      const members: NodeMember[] = entry.members.map((m) => ({
        name: m.name,
        delay: null,
        history: [],
        active: false,
      }));
      const item: NodeItem = {
        name,
        type: entry.members[0]?.type ?? "unknown",
        delay: null,
        history: [],
        members,
      };
      if (isExcluded) item.excluded = true;
      extra.push(item);
      continue;
    }
    const p = entry.proxy;
    const item: NodeItem = { name, type: p.type, delay: null, history: [] };
    if (typeof p.udp === "boolean") item.udp = p.udp;
    const pm = meta.get(name);
    if (pm) {
      if (pm.network) item.network = pm.network;
      item.security = pm.security;
    }
    if (isExcluded) item.excluded = true;
    extra.push(item);
  }
  return { ...view, all: [...view.all, ...extra] };
}

// Normalize the mihomo PROXY select group into the UI-facing NodeView, joining
// transport/security from the DB's proxy configs for the node badges, then union the
// full DB inventory so pooled-out nodes stay visible (mergeDbInventory).
export async function listNodes(db: Db): Promise<NodeView> {
  const dbProxies = collectProxies(db);
  const meta = proxyMeta(dbProxies);
  // Report each node's latency for the URL the active (Default) policy decides on,
  // not whatever probe last landed in mihomo's shared history.
  const { url: testUrl } = policyProbe(readDefaultPolicy(db));
  const view = mergeDbInventory(
    toNodeView(await getProxies(), meta, testUrl),
    dbProxies,
    meta,
    getExcludedSet(db),
  );
  return view;
}

export async function testDelay(name: string, url?: string): Promise<number | null> {
  try {
    const { delay } = await getDelay(name, url);
    return delay > 0 ? delay : null;
  } catch {
    return null; // timeout / unreachable node → no delay
  }
}

export async function selectNode(db: Db, group: string, name: string): Promise<void> {
  if (group !== "PROXY") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Группа недоступна для выбора" });
  }
  if (name !== "AUTO" && name !== "DIRECT") {
    const selectable = new Set(
      groupProxies(collectProxies(db)).map((entry) =>
        entry.kind === "single" ? entry.proxy.name : entry.base,
      ),
    );
    if (!selectable.has(name) || getExcludedSet(db).has(name)) {
      throw new TRPCError({ code: "CONFLICT", message: "Узел недоступен для выбора" });
    }
  }
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
