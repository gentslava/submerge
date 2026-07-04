// Generate a multi-channel mihomo config.yaml. The single-default case delegates
// here from buildConfig (config.ts) and MUST reproduce the legacy output
// byte-for-byte — the default channel owns the canonical, unprefixed names.
import { type ChannelPolicy, type Proxy as ProxyConfig, PSEUDO_NODE_SET } from "@submerge/shared";
import * as yaml from "js-yaml";
import { env } from "../../config/env.js";
import { dedupeNames, groupProxies, type UrlTestTuning, urlTestTuning } from "./config.js";

export interface ChannelConfigInput {
  id: string;
  groupName: string; // "AUTO" for the default channel, "ch-<id>" otherwise (groupNameFor)
  isDefault: boolean;
  policy: ChannelPolicy;
  domains: string[]; // matcher.domains (presets expand in 3b)
  proxies: ProxyConfig[]; // resolved pool for this channel
}

// A channel's top-level member is either a shared proxy (referenced by its index
// into the global proxy list, so the final post-dedupe name resolves) or a
// channel-scoped collapsed subgroup (referenced by its unique group name).
type TopLevelRef = { kind: "proxy"; flatIndex: number } | { kind: "subgroup"; name: string };

interface SubGroupSpec {
  name: string;
  memberFlatIndices: number[];
  tuning: UrlTestTuning;
}

interface ChannelBuild {
  channel: ChannelConfigInput;
  topLevel: TopLevelRef[];
}

const endpointKey = (p: ProxyConfig): string => `${p.server}:${p.port}`;

// A collapsed subgroup name must be globally unique. The default channel keeps
// the bare base name (byte-identity); every other channel is namespaced by its
// group name so two channels collapsing the same base can't collide.
function allocateSubGroupName(
  used: Set<string>,
  channel: ChannelConfigInput,
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

function buildRules(
  nonDefault: ChannelConfigInput[],
  noProxies: boolean,
  defaultGroupName: string,
): string[] {
  // With no exit nodes anywhere there is nothing to route — everything is DIRECT.
  if (noProxies) return ["MATCH,DIRECT"];
  const rules: string[] = [];
  for (const channel of nonDefault) {
    for (const domain of channel.domains) {
      rules.push(`DOMAIN-SUFFIX,${domain},${channel.groupName}`);
    }
  }
  // Default-only stays on the legacy PROXY catch-all (so config.test.ts holds);
  // once other channels exist the catch-all is the default channel's own group.
  rules.push(nonDefault.length === 0 ? "MATCH,PROXY" : `MATCH,${defaultGroupName}`);
  return rules;
}

export function buildMultiConfig(
  channels: ChannelConfigInput[],
  secret: string = env.MIHOMO_SECRET,
): string {
  const defaultChannel = channels.find((c) => c.isDefault);
  const nonDefault = channels.filter((c) => !c.isDefault);
  // Default first: it claims its endpoints and names before anyone else, keeping
  // the single-default output identical to the legacy generator.
  const ordered = defaultChannel ? [defaultChannel, ...nonDefault] : [...nonDefault];

  const flat: ProxyConfig[] = []; // global proxy definitions, pre-dedupe
  const endpointToIndex = new Map<string, number>();
  // One namespace for all group names (mihomo requires them unique). Seed with
  // the reserved names and every channel's own group name.
  const usedSubGroupNames = new Set<string>(PSEUDO_NODE_SET);
  for (const c of channels) usedSubGroupNames.add(c.groupName);

  const builds = new Map<string, ChannelBuild>();
  const allSubGroups: SubGroupSpec[] = [];

  for (const channel of ordered) {
    const tuning = urlTestTuning(channel.policy);
    // Only endpoints defined by EARLIER channels may be shared. Within a single
    // channel, two differently-named nodes on the same server:port stay separate
    // (exactly as the legacy generator did) — critical for byte-identity.
    const priorEndpoints = new Set(endpointToIndex.keys());
    const topLevel: TopLevelRef[] = [];

    const claim = (proxy: ProxyConfig, name: string): number => {
      const key = endpointKey(proxy);
      if (priorEndpoints.has(key)) return endpointToIndex.get(key) as number;
      const index = flat.length;
      flat.push({ ...proxy, name });
      if (!endpointToIndex.has(key)) endpointToIndex.set(key, index);
      return index;
    };

    for (const entry of groupProxies(channel.proxies)) {
      if (entry.kind === "single") {
        topLevel.push({ kind: "proxy", flatIndex: claim(entry.proxy, entry.proxy.name) });
        continue;
      }
      const name = allocateSubGroupName(usedSubGroupNames, channel, entry.base);
      const memberFlatIndices = entry.members.map((m, i) => claim(m, `${name} #${i + 1}`));
      allSubGroups.push({ name, memberFlatIndices, tuning });
      topLevel.push({ kind: "subgroup", name });
    }

    builds.set(channel.id, { channel, topLevel });
  }

  const unique = dedupeNames(flat);
  const nameAt = (index: number): string => (unique[index] as ProxyConfig).name;
  const memberNames = (build: ChannelBuild): string[] =>
    build.topLevel.map((ref) => (ref.kind === "proxy" ? nameAt(ref.flatIndex) : ref.name));

  const groupFor = (build: ChannelBuild): Record<string, unknown> => {
    const names = memberNames(build);
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

  const proxyMembers = [
    ...(defaultChannel ? [defaultChannel.groupName] : []),
    ...defaultTopLevelNames,
    ...nonDefault.map((c) => c.groupName),
    "DIRECT",
  ];

  const channelGroups: Record<string, unknown>[] = [];
  if (defaultBuild) channelGroups.push(groupFor(defaultBuild));
  for (const c of nonDefault) channelGroups.push(groupFor(builds.get(c.id) as ChannelBuild));

  const subGroupObjects = allSubGroups.map((spec) => ({
    name: spec.name,
    type: "url-test",
    url: spec.tuning.url,
    interval: spec.tuning.interval,
    tolerance: spec.tuning.tolerance,
    lazy: spec.tuning.lazy,
    proxies: spec.memberFlatIndices.map(nameAt),
  }));

  const cfg = {
    "mixed-port": 7890,
    "allow-lan": true,
    "bind-address": "*",
    mode: "rule",
    "log-level": "info",
    ipv6: false,
    "external-controller": "0.0.0.0:9090",
    secret,
    proxies: unique,
    "proxy-groups": [
      { name: "PROXY", type: "select", proxies: proxyMembers },
      ...channelGroups,
      ...subGroupObjects,
    ],
    rules: buildRules(nonDefault, unique.length === 0, defaultGroupName),
  };
  return yaml.dump(cfg, { lineWidth: -1 });
}
