// Generate a multi-channel mihomo config.yaml. The default channel owns the
// canonical, unprefixed proxy and group names.
import { createHash } from "node:crypto";
import {
  type ChannelPolicy,
  cidrVersion,
  type DirectPresetSettings,
  PROBE_GROUP,
  type Proxy as ProxyConfig,
  PSEUDO_NODE_SET,
  type RuleProviderFormat,
  type RuleProviderRef,
  ruleProviderFormat,
  SPEED_TEST_HOST,
} from "@submerge/shared";
import * as yaml from "js-yaml";
import { env } from "../../config/env.js";
import { sameProxy } from "../../lib/proxy-identity.js";
import { dedupeNames, groupProxies, type UrlTestTuning, urlTestTuning } from "./config.js";

interface MatcherConfigInput {
  id: string;
  isDefault: boolean;
  domains: string[];
  keywords?: string[];
  ruleProviders?: RuleProviderRef[];
  geosite?: string[];
  geoip?: string[];
  cidrs: string[];
}

export interface ProxyChannelConfigInput extends MatcherConfigInput {
  target: "proxy";
  groupName: string; // "AUTO" for the default channel, "ch-<id>" otherwise (groupNameFor)
  policy: ChannelPolicy;
  // The proxies this channel DEFINES + contributes to PROXY. The default channel is
  // fed the full inventory here so every node is defined + pinged + manually
  // selectable; other channels get their pool.
  proxies: ProxyConfig[];
  // The subset this channel's group actually RACES (empty pool = all). When omitted,
  // the group races everything in `proxies` (back-compat / byte-identity). Lets the
  // default define the whole inventory in `proxies` while AUTO races only the pool.
  race?: ProxyConfig[];
}

export interface DirectChannelConfigInput extends MatcherConfigInput {
  target: "direct";
  id: "direct";
  isDefault: false;
  directPresets: DirectPresetSettings;
}

export type ChannelConfigInput = ProxyChannelConfigInput | DirectChannelConfigInput;

// A channel's top-level member is either a shared proxy (referenced by its index
// into the global proxy list, so the final post-dedupe name resolves) or a
// channel-scoped collapsed subgroup (referenced by its unique group name). Each
// carries `raceName` — the ORIGINAL node name (a single's `name`, a subgroup's
// collapsed base) — so a channel's `race` subset (resolved by name in the pool,
// see resolveChannelProxies) matches back by the same key, not by endpoint (two
// distinct nodes can share a server:port).
type TopLevelRef =
  | { kind: "proxy"; flatIndex: number; raceName: string }
  | { kind: "subgroup"; name: string; raceName: string };

interface SubGroupSpec {
  name: string;
  memberFlatIndices: number[];
  tuning: UrlTestTuning;
}

interface ChannelBuild {
  channel: ProxyChannelConfigInput;
  topLevel: TopLevelRef[];
}

// A collapsed subgroup name must be globally unique. The default channel keeps
// the bare base name (byte-identity); every other channel is namespaced by its
// group name so two channels collapsing the same base can't collide.
function allocateSubGroupName(
  used: Set<string>,
  channel: ProxyChannelConfigInput,
  base: string,
): string {
  const candidate = channel.isDefault ? base : `${channel.groupName}::${base}`;
  let name = candidate;
  if (used.has(name)) {
    let n = 2;
    while (used.has(`${candidate}-${n}`)) n++;
    name = `${candidate}-${n}`;
  }
  used.add(name);
  return name;
}

// Raw proxy names that will land in the flat proxy list untouched by subgroup
// collapsing — a channel's own "single" entry, UNLESS its exact proxy was already
// claimed by an earlier channel (then it's a shared reference that keeps
// whichever name the earlier claim gave it, contributing no new flat entry —
// see `claim()` below). Mirrors the real proxy-claiming order (`channels`
// here must already be in the same Default-first order as the main loop) so
// this precomputation agrees with what the main loop will actually produce.
// A collapsed group never contributes its base name to `flat` either way —
// only its `${name} #n` member names do.
//
// Seeding the subgroup-name allocator with this set keeps proxy names and
// group/subgroup names in one joint namespace: mihomo rejects a proxy sharing
// a name with a proxy-group, so a collapsed subgroup must never claim a name
// some channel's bare proxy will use.
function collectSingleProxyNames(orderedChannels: ProxyChannelConfigInput[]): Set<string> {
  const names = new Set<string>();
  const claimed: ProxyConfig[] = [];
  const remember = (proxy: ProxyConfig): void => {
    if (!claimed.some((candidate) => sameProxy(candidate, proxy))) claimed.push(proxy);
  };
  for (const channel of orderedChannels) {
    for (const entry of groupProxies(channel.proxies)) {
      if (entry.kind === "single") {
        if (!claimed.some((candidate) => sameProxy(candidate, entry.proxy))) {
          names.add(entry.proxy.name);
        }
        remember(entry.proxy);
        continue;
      }
      for (const member of entry.members) remember(member);
    }
  }
  return names;
}

// File extension mihomo expects for a rule-provider's local cache, by format.
const PROVIDER_EXT: Record<RuleProviderFormat, string> = {
  yaml: "yaml",
  text: "list",
  mrs: "mrs",
};

// A rule-provider's stable internal name, derived from its identity (url +
// behavior; the format is a function of the url). Two channels referencing the
// same list collapse to one definition and one name. The `rp-` prefix + hex
// digest keeps it out of the (separate) proxy/proxy-group namespace by construction.
function ruleProviderName(ref: RuleProviderRef): string {
  const key = `${ref.url}|${ref.behavior}`;
  return `rp-${createHash("sha1").update(key).digest("hex").slice(0, 8)}`;
}

// Collect every distinct rule-provider referenced by the non-default channels
// into the top-level `rule-providers:` map. The `format` is derived from the URL
// extension (mihomo trusts the declared format). mihomo (not submerge) fetches
// each list — `proxy: DIRECT` so the fetch never loops through the tunnel it
// configures — and caches it under the mihomo Home Dir (`./providers/...`, gitignored).
function buildRuleProviders(nonDefault: ChannelConfigInput[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const channel of nonDefault) {
    for (const ref of channel.ruleProviders ?? []) {
      const name = ruleProviderName(ref);
      if (out[name]) continue; // identical (url,behavior) → one def
      const format = ruleProviderFormat(ref.url);
      out[name] = {
        type: "http",
        url: ref.url,
        behavior: ref.behavior,
        format,
        interval: 86400, // daily auto-update
        proxy: "DIRECT",
        path: `./providers/${name}.${PROVIDER_EXT[format]}`,
        "size-limit": 0,
      };
    }
  }
  return out;
}

// The top-level geodata block, emitted only when some channel actually uses a
// GEOSITE/GEOIP rule — a geo-free config stays free of the (multi-MB) geo DB
// download. mihomo (the container) fetches geoip.dat/geosite.dat from these URLs
// on first geo use; needs egress + a writable Home Dir (see deploy notes).
function geoTopLevel(nonDefault: ChannelConfigInput[]): Record<string, unknown> | null {
  const used = nonDefault.some((c) => (c.geosite?.length ?? 0) > 0 || (c.geoip?.length ?? 0) > 0);
  if (!used) return null;
  const base = "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release";
  // geodata-mode makes mihomo use the .dat GEOIP data, so no mmdb URL is needed.
  return {
    "geodata-mode": true,
    "geo-auto-update": true,
    "geo-update-interval": 168, // hours (weekly)
    "geox-url": {
      geoip: `${base}/geoip.dat`,
      geosite: `${base}/geosite.dat`,
    },
  };
}

// The single rule that routes the speed-test host through the hidden PROBE group,
// placed above all channel rules. None when there are no nodes to test.
function probeRules(noProxies: boolean): string[] {
  return noProxies ? [] : [`DOMAIN,${SPEED_TEST_HOST},${PROBE_GROUP}`];
}

const DIRECT_LOCAL_DOMAINS = ["localhost", "local", "lan", "home.arpa"] as const;
const REAL_IP_DNS_SERVERS = ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"] as const;
const DIRECT_PRIVATE_CIDRS = [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
] as const;

function appendCidrRule(rules: string[], rawCidr: string, target: string): void {
  const cidr = rawCidr.trim();
  const version = cidrVersion(cidr);
  if (version === null) return;
  // Intentionally no no-resolve: resolved hostnames must be eligible to match.
  rules.push(`${version === 4 ? "IP-CIDR" : "IP-CIDR6"},${cidr},${target}`);
}

function buildRules(
  nonDefault: ChannelConfigInput[],
  noProxies: boolean,
  defaultGroupName: string,
  nonDefaultProxyCount: number,
): string[] {
  // With no exit nodes anywhere there is nothing to route — everything is DIRECT.
  if (noProxies) return ["MATCH,DIRECT"];
  const rules: string[] = [];
  // Per channel, in priority order: keyword, domain-suffix, then rule-set — all
  // point at the channel's own group, so intra-channel order is irrelevant;
  // cross-channel precedence is the channel order (= priority).
  for (const channel of nonDefault) {
    const target = channel.target === "direct" ? "DIRECT" : channel.groupName;
    if (channel.target === "direct") {
      if (channel.directPresets.localDomains) {
        for (const domain of DIRECT_LOCAL_DOMAINS) {
          rules.push(`DOMAIN-SUFFIX,${domain},DIRECT`);
        }
      }
      if (channel.directPresets.privateNetworks) {
        for (const cidr of DIRECT_PRIVATE_CIDRS) appendCidrRule(rules, cidr, "DIRECT");
      }
    }
    for (const keyword of channel.keywords ?? []) {
      rules.push(`DOMAIN-KEYWORD,${keyword},${target}`);
    }
    for (const domain of channel.domains) {
      rules.push(`DOMAIN-SUFFIX,${domain},${target}`);
    }
    for (const ref of channel.ruleProviders ?? []) {
      rules.push(`RULE-SET,${ruleProviderName(ref)},${target}`);
    }
    for (const category of channel.geosite ?? []) {
      rules.push(`GEOSITE,${category},${target}`);
    }
    for (const code of channel.geoip ?? []) {
      // no-resolve: match on the connection's destination IP without a DNS lookup.
      rules.push(`GEOIP,${code},${target},no-resolve`);
    }
    for (const rawCidr of channel.cidrs) {
      appendCidrRule(rules, rawCidr, target);
    }
  }
  // Default-only stays on the legacy PROXY catch-all (so config.test.ts holds);
  // once other channels exist the catch-all is the default channel's own group.
  rules.push(nonDefaultProxyCount === 0 ? "MATCH,PROXY" : `MATCH,${defaultGroupName}`);
  return rules;
}

export function buildMultiConfig(
  channels: ChannelConfigInput[],
  secret: string = env.MIHOMO_SECRET,
): string {
  const proxyChannels = channels.filter(
    (channel): channel is ProxyChannelConfigInput => channel.target === "proxy",
  );
  const defaultChannel = proxyChannels.find((c) => c.isDefault);
  const nonDefault = channels.filter((c) => !c.isDefault);
  const nonDefaultProxy = proxyChannels.filter((c) => !c.isDefault);
  // Default first: it claims its endpoints and names before anyone else.
  const ordered = defaultChannel ? [defaultChannel, ...nonDefaultProxy] : [...nonDefaultProxy];

  const flat: ProxyConfig[] = []; // global proxy definitions, pre-dedupe
  const claimed: Array<{ proxy: ProxyConfig; flatIndex: number }> = [];
  // One namespace for all group names (mihomo requires them unique). Seed with
  // the reserved names, every channel's own group name, and every channel's
  // bare proxy names — the joint-uniqueness guard (see collectSingleProxyNames).
  const usedSubGroupNames = new Set<string>(PSEUDO_NODE_SET);
  for (const c of proxyChannels) usedSubGroupNames.add(c.groupName);
  for (const name of collectSingleProxyNames(ordered)) usedSubGroupNames.add(name);

  const builds = new Map<string, ChannelBuild>();
  const allSubGroups: SubGroupSpec[] = [];

  for (const channel of ordered) {
    const tuning = urlTestTuning(channel.policy);
    const topLevel: TopLevelRef[] = [];

    const claim = (proxy: ProxyConfig, name: string): number => {
      const existing = claimed.find((candidate) => sameProxy(candidate.proxy, proxy));
      if (existing) return existing.flatIndex;
      const index = flat.length;
      flat.push({ ...proxy, name });
      claimed.push({ proxy, flatIndex: index });
      return index;
    };

    for (const entry of groupProxies(channel.proxies)) {
      if (entry.kind === "single") {
        topLevel.push({
          kind: "proxy",
          flatIndex: claim(entry.proxy, entry.proxy.name),
          raceName: entry.proxy.name,
        });
        continue;
      }
      const name = allocateSubGroupName(usedSubGroupNames, channel, entry.base);
      const memberFlatIndices = entry.members.map((m, i) => claim(m, `${name} #${i + 1}`));
      allSubGroups.push({ name, memberFlatIndices, tuning });
      topLevel.push({ kind: "subgroup", name, raceName: entry.base });
    }

    builds.set(channel.id, { channel, topLevel });
  }

  // Reverse direction of the same guard: a proxy must never be assigned a name
  // already claimed by a proxy-group. Reserve PSEUDO + channel group names +
  // every allocated subgroup name (now final) before deduping proxy names.
  const reservedGroupNames = new Set<string>(PSEUDO_NODE_SET);
  for (const c of proxyChannels) reservedGroupNames.add(c.groupName);
  for (const spec of allSubGroups) reservedGroupNames.add(spec.name);

  const unique = dedupeNames(flat, reservedGroupNames);
  const nameAt = (index: number): string => (unique[index] as ProxyConfig).name;
  // All of a channel's top-level names — used for PROXY (the manual selector lists
  // every node the default channel DEFINES, i.e. the whole inventory).
  const memberNames = (build: ChannelBuild): string[] =>
    build.topLevel.map((ref) => (ref.kind === "proxy" ? nameAt(ref.flatIndex) : ref.name));

  // The names the channel's group RACES: its `race` subset, or all of `proxies` when
  // `race` is absent (byte-identity). Matched back to top-level entries by original
  // node name — the same key the pool used (resolveChannelProxies) — so two nodes on
  // one server:port stay independently poolable. A collapsed subgroup is all-or-nothing
  // (its members share the base name), so it races whole when any member is pooled.
  const raceNames = (build: ChannelBuild): string[] => {
    const race = build.channel.race;
    if (!race) return memberNames(build);
    const raceSet = new Set(race.map((p) => p.name));
    return build.topLevel
      .filter((ref) => raceSet.has(ref.raceName))
      .map((ref) => (ref.kind === "proxy" ? nameAt(ref.flatIndex) : ref.name));
  };

  const groupFor = (build: ChannelBuild): Record<string, unknown> => {
    const names = raceNames(build);
    const members = names.length ? names : ["DIRECT"];
    if (build.channel.policy.kind === "speed") {
      const t = urlTestTuning(build.channel.policy);
      return {
        name: build.channel.groupName,
        type: "url-test",
        url: t.url,
        interval: t.interval,
        tolerance: t.tolerance,
        lazy: t.lazy,
        proxies: members,
      };
    }
    // sticky / manual: a dumb selector the server controller pins (Phase 2).
    return { name: build.channel.groupName, type: "select", proxies: members };
  };

  const defaultBuild = defaultChannel ? (builds.get(defaultChannel.id) as ChannelBuild) : undefined;
  const defaultTopLevelNames = defaultBuild ? memberNames(defaultBuild) : [];
  const defaultGroupName = defaultChannel?.groupName ?? "PROXY";

  // PROXY is mihomo's manual-override selector, surfaced on the web Nodes
  // screen as the list of selectable exit nodes. Non-default channel groups
  // (ch-<id>) are routing groups reached via their own DOMAIN-SUFFIX rules,
  // not through PROXY — they must never be listed here as if they were nodes.
  const proxyMembers = [
    ...(defaultChannel ? [defaultChannel.groupName] : []),
    ...defaultTopLevelNames,
    "DIRECT",
  ];

  const channelGroups: Record<string, unknown>[] = [];
  if (defaultBuild) channelGroups.push(groupFor(defaultBuild));
  for (const c of nonDefaultProxy) channelGroups.push(groupFor(builds.get(c.id) as ChannelBuild));

  // Hidden speed-test group (Phase 4c): all inventory + REJECT, defaulting to REJECT
  // (first member). The test host is thus unreachable during normal use — NOT routed
  // direct (which would leak the real IP for that host) — and the server flips PROBE
  // to a node only for the duration of a measurement, restoring REJECT after. Present
  // only when there are nodes to test. (defaultTopLevelNames = the Default channel's
  // top-level names; the UI only offers the test on singleton nodes, which are in it.)
  const probeGroup: Record<string, unknown>[] =
    unique.length === 0
      ? []
      : [{ name: PROBE_GROUP, type: "select", proxies: ["REJECT", ...defaultTopLevelNames] }];

  const subGroupObjects = allSubGroups.map((spec) => ({
    name: spec.name,
    type: "url-test",
    url: spec.tuning.url,
    interval: spec.tuning.interval,
    tolerance: spec.tuning.tolerance,
    lazy: spec.tuning.lazy,
    proxies: spec.memberFlatIndices.map(nameAt),
  }));

  // With no exit nodes the config is all-DIRECT (buildRules short-circuits and
  // emits no RULE-SET lines), so defined providers would be dead weight — skip them.
  const noProxies = unique.length === 0;
  const ruleProviders = noProxies ? {} : buildRuleProviders(nonDefault);
  const hasProviders = Object.keys(ruleProviders).length > 0;
  const geo = noProxies ? null : geoTopLevel(nonDefault);

  const cfg = {
    "mixed-port": 7890,
    "allow-lan": true,
    "bind-address": "*",
    mode: "rule",
    "log-level": "info",
    ipv6: false,
    "external-controller": "0.0.0.0:9090",
    secret,
    // Keep the host resolver for LAN/split DNS, but reject fake IPs owned by
    // another mihomo instance. Native DIRECT needs a real destination or a
    // router → fake-IP → submerge loop is possible.
    dns: {
      enable: true,
      ipv6: false,
      "enhanced-mode": "redir-host",
      nameserver: ["system"],
      fallback: [...REAL_IP_DNS_SERVERS],
      "fallback-lazy-query": true,
      "fallback-filter": {
        geoip: false,
        ipcidr: ["198.18.0.0/15"],
      },
    },
    // Geodata keys (only present when a channel uses a GEOSITE/GEOIP rule).
    ...(geo ?? {}),
    proxies: unique,
    // Only present when a channel actually references an external list — a
    // A provider-free config stays free of this key.
    ...(hasProviders ? { "rule-providers": ruleProviders } : {}),
    "proxy-groups": [
      { name: "PROXY", type: "select", proxies: proxyMembers },
      ...channelGroups,
      ...subGroupObjects,
      ...probeGroup,
    ],
    rules: probeRules(noProxies).concat(
      buildRules(nonDefault, noProxies, defaultGroupName, nonDefaultProxy.length),
    ),
  };
  return yaml.dump(cfg, { lineWidth: -1 });
}
