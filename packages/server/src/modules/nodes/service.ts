import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
import { operationalLog } from "../../log.js";
import { groupNameFor, resolveChannelProxies } from "../channels/pool.js";
import { resolveMatcherDomains } from "../channels/presets.js";
import { listChannels, policyProbe, readDefaultPolicy } from "../channels/service.js";
import { getDomainIntelligenceSettingsView } from "../domain-intelligence/service.js";
import { assertGatewayNetworkActivated } from "../gateway/readiness.js";
import {
  assertGatewaySecurity,
  assertIndependentLocalDns,
  gatewayApplyState,
  readGatewayRuntimeSettings,
  readNetworkProfile,
  recordGatewayApply,
  seedGatewayMihomoSecret,
  validatePrivateLists,
  waitForPrivateProvidersLoaded,
} from "../gateway/settings.js";
import {
  confirmPendingMihomoSecretRotation,
  prepareMihomoSecretForConfig,
} from "../settings/secret-rotation.js";
import { getOrCreateInternalSecret, getSetting } from "../settings/service.js";
import { groupProxies } from "./config.js";
import {
  beginConfigApply,
  type ConfigApplyAttempt,
  finishConfigApply,
  recordConfigApplyCandidate,
} from "./config-apply-journal.js";
import type {
  ChannelConfigInput,
  DomainValidationListenerInput,
  ManagedDomainRulesProviderInput,
  ProxyChannelConfigInput,
} from "./multiConfig.js";
import { buildMultiConfig, buildMultiConfigDocument } from "./multiConfig.js";

const DOMAIN_VALIDATION_PASSWORD_KEY = "internal.domainValidationProxyPassword";

export interface ConfigApplyState {
  revision: number;
  inProgress: boolean;
}

let configApplyRevision = 0;
let activeConfigApplies = 0;

export function readConfigApplyState(): ConfigApplyState {
  return { revision: configApplyRevision, inProgress: activeConfigApplies > 0 };
}

function domainValidationTarget(
  inputs: readonly ChannelConfigInput[],
  targetChannelId: string,
): ProxyChannelConfigInput | null {
  return (
    inputs.find(
      (input): input is ProxyChannelConfigInput =>
        input.target === "proxy" && input.id === targetChannelId,
    ) ?? null
  );
}

function domainValidationListener(
  db: Db,
  inputs: readonly ChannelConfigInput[],
): DomainValidationListenerInput | undefined {
  const view = getDomainIntelligenceSettingsView(db);
  if (view.configurationState !== "ready" || !view.settings.enabled) return undefined;
  const target = domainValidationTarget(inputs, view.settings.customTargetChannelId);
  if (!target || (target.race ?? target.proxies).length === 0) return undefined;
  return {
    listen: env.DOMAIN_VALIDATION_LISTEN,
    port: env.DOMAIN_VALIDATION_PORT,
    password: getOrCreateInternalSecret(db, DOMAIN_VALIDATION_PASSWORD_KEY),
    targetGroupName: target.groupName,
  };
}

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
  // false = desired settings and a pending config were persisted, but activation
  // failed. The accepted file is retained; the common apply retries on recovery, so
  // callers must report "saved, engine pending", never a hard failure.
  applied: boolean;
  // true only when this call received a successful Mihomo reload response.
  // A byte-identical file skips reload and therefore cannot prove activation
  // after an earlier reload failure.
  activationVerified: boolean;
}

type ConfigApplyCoordinator = (
  apply: (managedDomainRules?: ManagedDomainRulesProviderInput) => Promise<ApplyResult>,
) => Promise<ApplyResult>;
let configApplyCoordinator: ConfigApplyCoordinator | null = null;

export type ForcedConfigApply = (input: {
  force: true;
  managedDomainRules?: ManagedDomainRulesProviderInput;
}) => Promise<ApplyResult>;

interface ConfigApplyOwnerBinding {
  configPath?: string;
  db: Db;
  targetPath?: string;
}

interface ConfigApplyOwnerComposition<T> {
  coordinator: ConfigApplyCoordinator;
  owner: T;
}

export function registerConfigApplyCoordinator(coordinator: ConfigApplyCoordinator): () => void {
  if (configApplyCoordinator) throw new Error("config apply coordinator is already registered");
  configApplyCoordinator = coordinator;
  return () => {
    if (configApplyCoordinator === coordinator) configApplyCoordinator = null;
  };
}

export function registerConfigApplyOwner<T>(
  binding: ConfigApplyOwnerBinding,
  compose: (applyDirect: ForcedConfigApply) => ConfigApplyOwnerComposition<T>,
): { owner: T; unregister: () => void } {
  if (configApplyCoordinator) throw new Error("config apply coordinator is already registered");
  const configPath = binding.configPath ?? env.MIHOMO_CONFIG_PATH;
  const targetPath = binding.targetPath ?? env.MIHOMO_CONFIG_TARGET;
  const applyDirect: ForcedConfigApply = (input) =>
    applyConfigNow(binding.db, configPath, targetPath, input);
  const composition = compose(applyDirect);
  return {
    owner: composition.owner,
    unregister: registerConfigApplyCoordinator(composition.coordinator),
  };
}

export interface ActiveRoutingInputs {
  inputs: ChannelConfigInput[];
  inventory: ProxyConfig[];
}

// One canonical projection of persisted channels into the exact inputs used by
// config generation. Domain coverage reads this same projection so it cannot
// drift from the rules Mihomo actually receives.
export function collectActiveRoutingInputs(
  db: Db,
  includeDisabledChannelId?: string,
): ActiveRoutingInputs {
  const allProxies = collectProxies(db);
  const excluded = getExcludedSet(db);
  const keep = (proxies: ProxyConfig[]): ProxyConfig[] =>
    proxies.filter((proxy) => !excluded.has(proxy.name));
  const inventory = keep(allProxies);
  const inputs: ChannelConfigInput[] = listChannels(db)
    .filter(
      (channel) =>
        (channel.target === "proxy" && channel.isDefault) ||
        channel.enabled ||
        channel.id === includeDisabledChannelId,
    )
    .map((channel): ChannelConfigInput => {
      const base = {
        target: channel.target,
        id: channel.id,
        isDefault: channel.isDefault,
        domains: resolveMatcherDomains(channel.matcher),
        keywords: channel.matcher.keywords,
        ruleProviders: channel.matcher.ruleProviders,
        geosite: channel.matcher.geosite,
        geoip: channel.matcher.geoip,
        cidrs: channel.matcher.cidrs,
      };
      if (channel.target === "direct") {
        return {
          ...base,
          target: "direct",
          id: "direct",
          isDefault: false,
          directPresets: channel.directPresets,
        };
      }
      const pool = keep(resolveChannelProxies(db, channel, allProxies));
      const proxyBase = {
        ...base,
        target: "proxy" as const,
        groupName: groupNameFor(channel),
        policy: channel.policy,
        defaultRoute: channel.defaultRoute,
      };
      return channel.isDefault
        ? { ...proxyBase, proxies: inventory, race: pool }
        : { ...proxyBase, proxies: pool };
    });
  return { inputs, inventory };
}

// Read-only preview of the exact pool targets config generation assigns. A
// disabled channel is projected as enabled for editing, without a DB write.
export function getPolicyNodeNames(db: Db, channelId: string): string[] {
  const { inputs } = collectActiveRoutingInputs(db, channelId);
  const document = buildMultiConfigDocument(inputs, "");
  return document.nodeNamesByChannel.get(channelId) ?? [];
}

export function readDomainValidationProxyPassword(db: Db): string | null {
  return getSetting(db, DOMAIN_VALIDATION_PASSWORD_KEY) || null;
}

export function hasDomainValidationRoute(db: Db): boolean {
  const view = getDomainIntelligenceSettingsView(db);
  if (view.configurationState !== "ready" || !view.settings.enabled) return false;
  const target = domainValidationTarget(
    collectActiveRoutingInputs(db).inputs,
    view.settings.customTargetChannelId,
  );
  return target !== null && (target.race ?? target.proxies).length > 0;
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
interface ConfigApplyOptions {
  afterConfigActivationAttempt?: (
    result: Pick<ApplyResult, "applied" | "activationVerified">,
  ) => void;
  force?: boolean;
  stageConfigMutation?: () => () => void;
  rollbackOnFailure?: boolean;
}

type RawConfigApplyOptions = ConfigApplyOptions & {
  managedDomainRules?: ManagedDomainRulesProviderInput;
};
let configApplyTail: Promise<unknown> = Promise.resolve();

export async function applyConfig(
  db: Db,
  configPath: string = env.MIHOMO_CONFIG_PATH,
  targetPath: string = env.MIHOMO_CONFIG_TARGET,
  opts: ConfigApplyOptions = {},
): Promise<ApplyResult> {
  const apply = (managedDomainRules?: ManagedDomainRulesProviderInput) =>
    applyConfigNow(db, configPath, targetPath, {
      ...(opts.afterConfigActivationAttempt === undefined
        ? {}
        : { afterConfigActivationAttempt: opts.afterConfigActivationAttempt }),
      ...(opts.force === undefined ? {} : { force: opts.force }),
      ...(managedDomainRules === undefined ? {} : { managedDomainRules }),
      ...(opts.stageConfigMutation === undefined
        ? {}
        : { stageConfigMutation: opts.stageConfigMutation }),
      ...(opts.rollbackOnFailure === undefined
        ? {}
        : { rollbackOnFailure: opts.rollbackOnFailure }),
    });
  return configApplyCoordinator ? configApplyCoordinator(apply) : apply();
}

function applyConfigNow(
  db: Db,
  configPath: string,
  targetPath: string,
  opts: RawConfigApplyOptions = {},
): Promise<ApplyResult> {
  const operation = configApplyTail.then(() =>
    applyConfigSerialized(db, configPath, targetPath, opts),
  );
  configApplyTail = operation.catch(() => {});
  return operation;
}

async function applyConfigSerialized(
  db: Db,
  configPath: string,
  targetPath: string,
  opts: RawConfigApplyOptions = {},
): Promise<ApplyResult> {
  // fs/permission errors (e.g. EACCES) propagate to the caller (→ tRPC 500).
  mkdirSync(dirname(configPath), { recursive: true });
  // The config's `secret:` is the editable panel secret (seeded from env on first run):
  // the panel owns mihomo's config, so editing the secret rotates the engine too. The
  // settings router stages that mutation in this serialized apply and re-points the
  // client only after a no-op/reload activation attempt; pre-reload failures roll it back.
  //
  // Write atomically (temp file + rename) so mihomo never reads a half-written config on
  // reload: an in-place writeFileSync truncates first, and mihomo can catch that empty
  // window — especially across a slow bind mount — and reject the reload with HTTP 400.
  // A disabled non-default channel is dropped from routing entirely — no group,
  // no DOMAIN-SUFFIX rules — until re-enabled. The Default is the catch-all and
  // stays active regardless of its own `enabled` flag.
  let rollbackConfigMutation: (() => void) | undefined;
  let attempt: ConfigApplyAttempt | undefined;
  let activationAttempted = false;
  let rollbackSafe = true;
  let gateway = false;
  const tmpPath = `${configPath}.tmp`;
  const pendingPath = `${configPath}.pending`;
  configApplyRevision += 1;
  activeConfigApplies += 1;
  try {
    const staged = db.transaction(
      () => ({
        attempt: beginConfigApply(db, configPath),
        rollback: opts.stageConfigMutation?.(),
      }),
      { behavior: "immediate" },
    );
    attempt = staged.attempt;
    rollbackConfigMutation = staged.rollback;
    const { inputs, inventory } = collectActiveRoutingInputs(db);
    const networkProfile = readNetworkProfile(db);
    const preferences = readGatewayRuntimeSettings(db);
    let privateListCounts: Record<string, number> = {};
    gateway = preferences !== undefined;
    const secretPreparation = await prepareMihomoSecretForConfig(db);
    rollbackSafe = secretPreparation.rollbackSafe;
    if (preferences) {
      if (networkProfile.profile === "gateway") assertGatewaySecurity(secretPreparation.secret);
      else if (!secretPreparation.secret)
        throw new Error("Prepared deployment requires an engine secret");
      assertIndependentLocalDns(preferences);
      privateListCounts = validatePrivateLists(preferences);
      if (!secretPreparation.pending) seedGatewayMihomoSecret(db, secretPreparation.secret);
    }
    const content = buildMultiConfig(
      inputs,
      secretPreparation.secret,
      domainValidationListener(db, inputs),
      opts.managedDomainRules,
      networkProfile,
      preferences,
    );
    // Unchanged config → skip the write + the destructive reload so mihomo keeps its
    // delay history (the charts don't blank on every no-op apply — rename, re-saved
    // setting, redundant re-apply). Genuine changes (policy, pool, sources) differ and
    // still reload. `force` (reconnect recovery) always pushes.
    if (
      !opts.force &&
      !attempt.previousJournal &&
      (!gateway || gatewayApplyState(db) === "applied") &&
      readExistingConfig(configPath) === content
    ) {
      activationAttempted = true;
      const pendingSecretConfirmed =
        !secretPreparation.pending || (await confirmPendingMihomoSecretRotation(db));
      if (pendingSecretConfirmed) {
        opts.afterConfigActivationAttempt?.({ applied: true, activationVerified: false });
        rmSync(pendingPath, { force: true });
        finishConfigApply(db, attempt);
        return { nodes: inventory.length, applied: true, activationVerified: false };
      }
      // Bytes alone are insufficient during a rotation: a previous attempt may
      // have written the new file but failed before Mihomo accepted it. Continue
      // through the reload path until the new credential authenticates.
    }
    recordConfigApplyCandidate(db, configPath, content);
    writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, pendingPath);
    // Every mode sends the durable candidate inline, retaining the accepted file
    // until reload and readiness succeed. A lost response leaves replayable intent.
    try {
      // Once the request is sent, a lost response cannot prove whether Mihomo
      // accepted the new secret. Keep the durable rotation journal in that
      // ambiguous state; recovery probes both credentials on the next apply.
      activationAttempted = true;
      await reloadConfig(targetPath, content);
    } catch (err) {
      operationalLog(
        opts.rollbackOnFailure
          ? "default-route-activation-failed"
          : gateway
            ? "gateway-config-reload-failed"
            : "config-reload-failed",
        {},
        err,
      );
      opts.afterConfigActivationAttempt?.({ applied: false, activationVerified: false });
      if (gateway || opts.rollbackOnFailure)
        throw new Error("gateway configuration activation failed; previous config file preserved", {
          cause: err,
        });
      return { nodes: inventory.length, applied: false, activationVerified: false };
    }
    if (preferences) {
      let phase = "provider";
      try {
        if (preferences.privateLists.length > 0)
          await waitForPrivateProvidersLoaded(preferences, privateListCounts);
        phase = "network";
        await assertGatewayNetworkActivated(
          preferences,
          undefined,
          networkProfile.profile === "gateway",
        );
      } catch (error) {
        const previous = readExistingConfig(configPath);
        if (previous) {
          try {
            await reloadConfig(targetPath, previous);
          } catch {
            /* readiness remains failed */
          }
        }
        opts.afterConfigActivationAttempt?.({ applied: false, activationVerified: false });
        throw new Error(`gateway ${phase} activation failed; previous config file preserved`, {
          cause: error,
        });
      }
    }
    // Keep both credentials until the accepted payload is also durable. Mihomo
    // may retain the old controller credential until process restart.
    renameSync(pendingPath, configPath);
    const pendingSecretConfirmed = await confirmPendingMihomoSecretRotation(db);
    if (secretPreparation.pending && !pendingSecretConfirmed) {
      opts.afterConfigActivationAttempt?.({ applied: false, activationVerified: false });
      if (gateway || opts.rollbackOnFailure)
        throw new Error("gateway secret activation is pending; restart Mihomo to confirm it");
      return { nodes: inventory.length, applied: false, activationVerified: false };
    }
    if (gateway) {
      recordGatewayApply(db, "applied");
    }
    opts.afterConfigActivationAttempt?.({ applied: true, activationVerified: true });
    finishConfigApply(db, attempt);
    return { nodes: inventory.length, applied: true, activationVerified: true };
  } catch (error) {
    if (gateway) recordGatewayApply(db, "failed");
    if (attempt && opts.rollbackOnFailure && activationAttempted) {
      // Keep route changes and their recovery inside the serialized apply. A lost
      // reload response is ambiguous, so restore the durable file and attempt to
      // restore the engine too before another configuration can be applied.
      const previousContent = attempt.previousContent;
      if (previousContent != null) {
        writeFileSync(tmpPath, previousContent, { encoding: "utf8", mode: 0o600 });
        renameSync(tmpPath, configPath);
        try {
          await reloadConfig(targetPath, previousContent);
        } catch (restoreError) {
          operationalLog("default-route-restore-failed", {}, restoreError);
        }
      } else {
        rmSync(configPath, { force: true });
      }
    }
    if (
      attempt &&
      (opts.rollbackOnFailure || (!activationAttempted && rollbackSafe && rollbackConfigMutation))
    ) {
      const rollbackAttempt = attempt;
      db.transaction(() => {
        rollbackConfigMutation?.();
        finishConfigApply(db, rollbackAttempt, true);
      });
      rmSync(pendingPath, { force: true });
    }
    throw error;
  } finally {
    activeConfigApplies -= 1;
    configApplyRevision += 1;
    rmSync(tmpPath, { force: true });
  }
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
  const historyOf = (info: MihomoProxy | undefined) => historyForUrl(info, testUrl);
  const delaysOf = (info: MihomoProxy | undefined): number[] => historyOf(info).map((h) => h.delay);
  const timestampFields = (info: MihomoProxy | undefined) => {
    if (testUrl === undefined) return {};
    const history = historyOf(info);
    return history.length > 0 ? { historyTimestamps: history.map((entry) => entry.time) } : {};
  };
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
        ...timestampFields(active),
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
      ...timestampFields(info),
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

export async function testDelay(name: string, url?: string): Promise<number> {
  try {
    const { delay } = await getDelay(name, url);
    return delay;
  } catch {
    return 0; // timeout / unreachable node; the UI renders 0 as timeout immediately
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
