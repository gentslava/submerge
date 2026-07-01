# Node Collapse (url-test groups) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse subscription nodes that share an identical name into one `url-test` proxy-group ("one node over N servers") so mihomo auto-selects the fastest member and the "Прочие" bucket empties.

**Architecture:** Server-side. `buildConfig` groups raw proxies (pre-dedupe) by exact name; a name with ≥2 distinct `server:port` becomes a `url-test` proxy-group whose members are renamed `«<base> #k»`; singletons stay flat. `PROXY`/`AUTO` reference the top-level entries (singletons + group names). The server's `toNodeView` attaches each group's members to its `NodeItem` (delay = active member); the web renders a group row as expandable, view-only members.

**Tech Stack:** Node 24, strict TypeScript (ESM, `verbatimModuleSyntax`), Zod 4, Vitest, React 19 + Testing Library, js-yaml, mihomo (Clash) REST API.

**Spec:** [docs/specs/2026-07-01-node-collapse-design.md](../specs/2026-07-01-node-collapse-design.md)

## Global Constraints

- Strict TS: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESM, `verbatimModuleSyntax`. Type-only imports use `import type`.
- Formatting/linting — **Biome** (not ESLint/Prettier). Verify lint via the raw binary: `./node_modules/.bin/biome ci packages/` (the `pnpm lint` wrapper can mask the exit code).
- Responses from mihomo MUST stay Zod-parsed at the client boundary (`clients/mihomo.ts`). Do not add new unparsed reads.
- Code, comments, commit messages — **English**. UI-facing strings — **Russian**.
- Pre-commit gates, green: `pnpm lint && pnpm typecheck && pnpm test`.
- Conventional commits; end the body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- v1 is **group-only** (members view-only). Do NOT implement per-member pinning.

---

### Task 1: Verify mihomo supports nested url-test (source-driven, no code)

**Files:** none (records a decision that gates Task 4's `AUTO.proxies`).

**Interfaces:**
- Produces: a decision — `AUTO_REFERENCES = "groups" | "flat"`. Default `"groups"` (AUTO lists the collapsed group names). Fallback `"flat"` (AUTO lists the individual member/singleton proxy names) if mihomo rejects a `url-test` group that contains other `url-test` groups.

- [ ] **Step 1: Check the docs**

Use Context7: `resolve-library-id` "mihomo" (or "clash-meta"), then `query-docs` with "can a url-test proxy-group reference other proxy-groups (nested groups)?". Confirm whether a `url-test` group may contain other proxy-groups.

- [ ] **Step 2: Empirical fallback if docs are inconclusive**

On `home.server`, hand-write a minimal config with `AUTO` (url-test) referencing a nested `url-test` group, drop it in a scratch path, and reload via the mihomo API — check it loads without error:

```bash
ssh home.server 'C=compose-quantify-auxiliary-driver-aqpf1w-mihomo-1; sudo docker exec "$C" sh -c "wget -qO- --header=\"Authorization: Bearer poc\" http://127.0.0.1:9090/version"'
```

(Use a throwaway config; do NOT overwrite the live one.)

- [ ] **Step 3: Record the decision**

Note `AUTO_REFERENCES` in the task tracker. If `"flat"`, Task 4 sets `AUTO.proxies` to `unique.map((p) => p.name)` instead of `topLevelNames`, and adjusts the Task 4 test accordingly.

---

### Task 2: Shared — `NodeMember` schema + `NodeItem.members`

**Files:**
- Modify: `packages/shared/src/schemas.ts:50-60`
- Test: `packages/shared/src/schemas.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - `nodeMemberSchema` / `type NodeMember = { name: string; delay: number | null; history: number[]; active: boolean }`
  - `NodeItem` gains optional `members?: NodeMember[]`.

- [ ] **Step 1: Write the failing test**

Create/append `packages/shared/src/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nodeItemSchema } from "./schemas.js";

describe("nodeItemSchema.members", () => {
  it("accepts a node without members", () => {
    const n = nodeItemSchema.parse({ name: "A", type: "vless", delay: 47 });
    expect(n.members).toBeUndefined();
  });
  it("parses a collapsed group's members", () => {
    const n = nodeItemSchema.parse({
      name: "G",
      type: "URLTest",
      delay: 40,
      members: [{ name: "G #1", delay: 40, active: true }],
    });
    expect(n.members).toEqual([{ name: "G #1", delay: 40, history: [], active: true }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @submerge/shared test -- schemas.test`
Expected: FAIL — `members` stripped / `nodeMemberSchema` not defined.

- [ ] **Step 3: Implement the schema change**

In `packages/shared/src/schemas.ts`, before `nodeItemSchema`, add:

```ts
// A member server inside a collapsed url-test node (view-only in v1).
export const nodeMemberSchema = z.object({
  name: z.string(),
  delay: z.number().nullable(),
  history: z.array(z.number()).default([]),
  active: z.boolean(), // true = the group's currently-routed member (`now`)
});
export type NodeMember = z.infer<typeof nodeMemberSchema>;
```

Then add to `nodeItemSchema` (after `history`):

```ts
  // Present only for a collapsed group node: its member servers.
  members: z.array(nodeMemberSchema).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @submerge/shared test -- schemas.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/schemas.test.ts
git commit -m "feat(shared): add NodeMember and NodeItem.members for collapsed groups"
```

---

### Task 3: Server — `groupProxies` (pure grouping)

**Files:**
- Modify: `packages/server/src/modules/nodes/config.ts`
- Test: `packages/server/src/modules/nodes/config.test.ts`

**Interfaces:**
- Consumes: `type Proxy as ProxyConfig` from `@submerge/shared` (`{ name, type, server, port, uuid? }`).
- Produces:
  ```ts
  export type TopLevelEntry =
    | { kind: "single"; proxy: ProxyConfig }
    | { kind: "group"; base: string; members: ProxyConfig[] };
  export function groupProxies(proxies: ProxyConfig[]): TopLevelEntry[];
  ```

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/modules/nodes/config.test.ts`:

```ts
import { groupProxies } from "./config.js";

const px = (name: string, server = "ex.com", port = 443): ProxyConfig => ({
  name, type: "vless", server, port, uuid: "u",
});

describe("groupProxies", () => {
  it("keeps unique names as singles, order preserved", () => {
    const r = groupProxies([px("A"), px("B")]);
    expect(r).toEqual([
      { kind: "single", proxy: px("A") },
      { kind: "single", proxy: px("B") },
    ]);
  });
  it("collapses same-name distinct endpoints into a group", () => {
    const r = groupProxies([px("A", "1.1.1.1"), px("A", "2.2.2.2")]);
    expect(r).toEqual([
      { kind: "group", base: "A", members: [px("A", "1.1.1.1"), px("A", "2.2.2.2")] },
    ]);
  });
  it("drops a true duplicate (same server:port); leftover single stays single", () => {
    const r = groupProxies([px("A", "1.1.1.1"), px("A", "1.1.1.1")]);
    expect(r).toEqual([{ kind: "single", proxy: px("A", "1.1.1.1") }]);
  });
  it("places a group at the position of its first member", () => {
    const r = groupProxies([px("A", "1.1.1.1"), px("B"), px("A", "2.2.2.2")]);
    expect(r.map((e) => (e.kind === "group" ? e.base : e.proxy.name))).toEqual(["A", "B"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @submerge/server test -- config.test`
Expected: FAIL — `groupProxies` is not exported.

- [ ] **Step 3: Implement `groupProxies`**

In `packages/server/src/modules/nodes/config.ts`, after the imports, add:

```ts
export type TopLevelEntry =
  | { kind: "single"; proxy: ProxyConfig }
  | { kind: "group"; base: string; members: ProxyConfig[] };

// Group raw proxies by exact name (pre-dedupe). Within a same-name set, drop
// true duplicates sharing a server:port. A name with ≥2 distinct endpoints
// becomes a collapsed group; otherwise it stays a single proxy. Order follows
// each name's first appearance.
export function groupProxies(proxies: ProxyConfig[]): TopLevelEntry[] {
  const order: string[] = [];
  const byName = new Map<string, ProxyConfig[]>();
  for (const p of proxies) {
    const bucket = byName.get(p.name);
    if (!bucket) {
      byName.set(p.name, [p]);
      order.push(p.name);
    } else if (!bucket.some((q) => q.server === p.server && q.port === p.port)) {
      bucket.push(p);
    }
  }
  return order.map((name) => {
    const members = byName.get(name) as ProxyConfig[];
    return members.length > 1
      ? { kind: "group" as const, base: name, members }
      : { kind: "single" as const, proxy: members[0] as ProxyConfig };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @submerge/server test -- config.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/nodes/config.ts packages/server/src/modules/nodes/config.test.ts
git commit -m "feat(server): add groupProxies to collapse same-named proxies"
```

---

### Task 4: Server — `buildConfig` emits url-test subgroups

**Files:**
- Modify: `packages/server/src/modules/nodes/config.ts:52-88` (`buildConfig`)
- Test: `packages/server/src/modules/nodes/config.test.ts`

**Interfaces:**
- Consumes: `groupProxies`, `dedupeNames`, `AutoConfig`.
- Produces: `buildConfig` output where collapsed groups appear as `url-test` proxy-groups after `PROXY`/`AUTO`; `PROXY.proxies = ["AUTO", ...topLevelNames, "DIRECT"]`; `AUTO.proxies = topLevelNames` (or flat member names if Task 1 → `"flat"`).

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/modules/nodes/config.test.ts`:

```ts
describe("buildConfig collapses same-named nodes", () => {
  it("emits a url-test subgroup and references it from PROXY/AUTO", () => {
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(
      buildConfig([px("A", "1.1.1.1"), px("A", "2.2.2.2"), px("B")]),
    ) as Record<string, any>;
    const groups = cfg["proxy-groups"];
    expect(groups[0].proxies).toEqual(["AUTO", "A", "B", "DIRECT"]);
    expect(groups[1].name).toBe("AUTO");
    expect(groups[1].proxies).toEqual(["A", "B"]);
    const sub = groups.find((g: any) => g.name === "A");
    expect(sub.type).toBe("url-test");
    expect(sub.proxies).toEqual(["A #1", "A #2"]);
    // real servers carry the member names, base name is a group only
    expect(cfg.proxies.map((p: any) => p.name)).toEqual(["A #1", "A #2", "B"]);
  });
  it("renames a group that collides with a reserved name", () => {
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(
      buildConfig([px("AUTO", "1.1.1.1"), px("AUTO", "2.2.2.2")]),
    ) as Record<string, any>;
    const names = cfg["proxy-groups"].map((g: any) => g.name);
    expect(names).toContain("AUTO-2"); // the collapsed provider group, guarded
    expect(names[1]).toBe("AUTO"); // the system AUTO group is untouched
  });
});
```

> If Task 1 decided `AUTO_REFERENCES = "flat"`, change the first test's `groups[1].proxies` to `["A #1", "A #2", "B"]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @submerge/server test -- config.test`
Expected: FAIL — current `buildConfig` emits no subgroup, `proxies` still holds `A`/`A-2`.

- [ ] **Step 3: Rewrite `buildConfig`**

Replace the body of `buildConfig` in `config.ts` with:

```ts
const RESERVED_GROUP_NAMES = ["AUTO", "PROXY", "DIRECT", "REJECT", "GLOBAL"];

export function buildConfig(
  proxies: ProxyConfig[],
  auto: AutoConfig = AUTO_DEFAULTS,
  secret: string = env.MIHOMO_SECRET,
): string {
  const entries = groupProxies(proxies);
  const usedGroupNames = new Set<string>(RESERVED_GROUP_NAMES);
  const topLevelNames: string[] = [];
  const flat: ProxyConfig[] = [];
  const subGroups: Record<string, unknown>[] = [];

  for (const e of entries) {
    if (e.kind === "single") {
      topLevelNames.push(e.proxy.name);
      flat.push(e.proxy);
      continue;
    }
    let gname = e.base;
    if (usedGroupNames.has(gname)) {
      let n = 2;
      while (usedGroupNames.has(`${e.base}-${n}`)) n++;
      gname = `${e.base}-${n}`;
    }
    usedGroupNames.add(gname);
    const memberNames = e.members.map((_, i) => `${gname} #${i + 1}`);
    e.members.forEach((m, i) => flat.push({ ...m, name: memberNames[i] as string }));
    subGroups.push({
      name: gname,
      type: "url-test",
      url: auto.url,
      interval: auto.interval,
      tolerance: auto.tolerance,
      lazy: !auto.switchOnTimeout,
      proxies: memberNames,
    });
    topLevelNames.push(gname);
  }

  const unique = dedupeNames(flat);
  const autoGroup: Record<string, unknown> = {
    name: "AUTO",
    type: auto.strategy,
    url: auto.url,
    interval: auto.interval,
    lazy: !auto.switchOnTimeout,
    proxies: topLevelNames.length ? topLevelNames : ["DIRECT"],
  };
  if (auto.strategy === "url-test") autoGroup.tolerance = auto.tolerance;
  if (auto.strategy === "load-balance") autoGroup.strategy = "round-robin";

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
      { name: "PROXY", type: "select", proxies: ["AUTO", ...topLevelNames, "DIRECT"] },
      autoGroup,
      ...subGroups,
    ],
    rules: [topLevelNames.length ? "MATCH,PROXY" : "MATCH,DIRECT"],
  };
  return yaml.dump(cfg, { lineWidth: -1 });
}
```

> If Task 1 → `"flat"`: set `autoGroup.proxies` to `unique.length ? unique.map((p) => p.name) : ["DIRECT"]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @submerge/server test -- config.test`
Expected: PASS (including the pre-existing `buildConfig` tests — the no-duplicate path is unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/nodes/config.ts packages/server/src/modules/nodes/config.test.ts
git commit -m "feat(server): emit url-test subgroups for collapsed same-named nodes"
```

---

### Task 5: Server — `toNodeView` attaches members to group nodes

**Files:**
- Modify: `packages/server/src/modules/nodes/service.ts:77-98` (`toNodeView`)
- Test: `packages/server/src/modules/nodes/service.test.ts`

**Interfaces:**
- Consumes: `ProxiesResponse` (mihomo proxy: `{ name, type, now?, all?, udp?, history }`), `NodeItem`, `NodeMember`.
- Produces: `toNodeView` sets `members` + `delay`/`history` (= active member) on any non-pseudo `PROXY.all` entry that carries `all`.

- [ ] **Step 1: Write the failing test**

Append to the `listNodes` describe in `service.test.ts`:

```ts
it("attaches members and the active member's delay for a collapsed group", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      json({
        proxies: {
          PROXY: { name: "PROXY", type: "Selector", now: "G", all: ["G", "S"], history: [] },
          G: { name: "G", type: "URLTest", now: "G #2", all: ["G #1", "G #2"], history: [] },
          "G #1": { name: "G #1", type: "vless", history: [{ time: "t", delay: 90 }] },
          "G #2": { name: "G #2", type: "vless", history: [{ time: "t", delay: 40 }] },
          S: { name: "S", type: "vless", history: [{ time: "t", delay: 55 }] },
        },
      }),
    ),
  );
  const view = await listNodes();
  const g = view.all.find((n) => n.name === "G");
  expect(g?.delay).toBe(40); // active member G #2
  expect(g?.members).toEqual([
    { name: "G #1", delay: 90, history: [90], active: false },
    { name: "G #2", delay: 40, history: [40], active: true },
  ]);
  // a singleton is unchanged (no members)
  expect(view.all.find((n) => n.name === "S")?.members).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @submerge/server test -- service.test`
Expected: FAIL — `G` currently has no `members` and `delay` is `null` (G has empty history).

- [ ] **Step 3: Implement**

In `service.ts`, add `NodeMember` to the shared import and a pseudo set, then branch in `toNodeView`:

```ts
import type { NodeItem, NodeMember, NodeView, Proxy as ProxyConfig } from "@submerge/shared";
```

Add near the top of the file:

```ts
const PSEUDO_GROUPS = new Set(["AUTO", "PROXY", "DIRECT", "REJECT", "GLOBAL"]);
```

Replace the `group.all.map(...)` body in `toNodeView` with:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @submerge/server test -- service.test`
Expected: PASS (the existing `listNodes` cases still pass — plain nodes have no `all`).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/nodes/service.ts packages/server/src/modules/nodes/service.test.ts
git commit -m "feat(server): expose collapsed group members via toNodeView"
```

---

### Task 6: Web — `NodeRow` renders expandable, view-only members

**Files:**
- Modify: `packages/web/src/features/nodes/NodeRow.tsx`
- Test: `packages/web/src/features/nodes/NodeRow.test.tsx`

**Interfaces:**
- Consumes: `NodeItem` (now with optional `members`), `nodeView` helpers (`dotColors`, `latencyClass`, `latencyLabel`, `latencyTextColors`, `typeBadges`).
- Produces: a group row (when `item.members` is non-empty) with an expand chevron before the status dot and, when expanded, member sub-rows (name + ping + active dot), no select/ping controls on members. Selection stays `onSelect()` on the group (wired via `group: "PROXY"` in `NodesScreen`, unchanged).

- [ ] **Step 1: Write the failing test**

Append to `packages/web/src/features/nodes/NodeRow.test.tsx`:

```ts
it("expands a collapsed group to show view-only members", () => {
  const item: NodeItem = {
    name: "G",
    type: "URLTest",
    delay: 40,
    history: [],
    members: [
      { name: "G #1", delay: 90, history: [], active: false },
      { name: "G #2", delay: 40, history: [], active: true },
    ],
  };
  render(<NodeRow {...base} item={item} />);

  // group row shows the active member's ping and can still be selected as a whole
  expect(screen.getByText("40 ms")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Выбрать" })).toBeInTheDocument();

  // members hidden until expanded
  expect(screen.queryByText("G #2 · активен")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Показать серверы G" }));
  expect(screen.getByText("G #2 · активен")).toBeInTheDocument();
  expect(screen.getByText("90 ms")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @submerge/web test -- NodeRow`
Expected: FAIL — no "Показать серверы G" toggle exists.

- [ ] **Step 3: Implement the expandable row**

Rewrite `NodeRow.tsx` to wrap the row in a fragment, add the chevron inside the node cell, and render members below when expanded:

```tsx
import type { NodeItem } from "@submerge/shared";
import { Check, ChevronDown, Loader2, Zap } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { dotColors, latencyClass, latencyLabel, latencyTextColors, typeBadges } from "./nodeView";

interface NodeRowProps {
  item: NodeItem;
  isActive: boolean;
  pinging?: boolean;
  onSelect(): void;
  onPing(): void;
}

export function NodeRow({ item, isActive, pinging = false, onSelect, onPing }: NodeRowProps) {
  const lClass = latencyClass(item.delay);
  const sub = typeBadges(item).join(" · ");
  const members = item.members ?? [];
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-4 border-b border-border-subtle px-4 py-[13px] last:border-b-0",
          isActive && "bg-accent-bg",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {members.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
              aria-label={`Показать серверы ${item.name}`}
              className="-ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:text-text-primary"
            >
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", !expanded && "-rotate-90")}
                aria-hidden="true"
              />
            </button>
          )}
          <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", dotColors[lClass])} />
          <div className="flex min-w-0 flex-col gap-[3px]">
            <span className="truncate text-sm font-semibold text-text-primary">{item.name}</span>
            {sub !== "" && <span className="truncate text-xs text-text-tertiary">{sub}</span>}
          </div>
        </div>

        <div className="flex w-24 shrink-0 items-center justify-end">
          {pinging ? (
            <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" aria-label="Опрос…" />
          ) : (
            <span className={cn("font-mono text-sm font-medium", latencyTextColors[lClass])}>
              {latencyLabel(item.delay)}
            </span>
          )}
        </div>

        <div className="flex w-12 shrink-0 justify-center">
          <button
            type="button"
            onClick={onPing}
            disabled={pinging}
            aria-label={`Пинговать ${item.name}`}
            className="flex h-10 w-10 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-50"
          >
            <Zap className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
        </div>

        <div className="flex w-[120px] shrink-0 justify-end">
          {isActive ? (
            <Button variant="primary" size="sm" disabled className="w-[112px] disabled:opacity-100">
              <Check className="h-4 w-4" aria-hidden="true" />
              Активен
            </Button>
          ) : (
            <Button variant="secondary" size="sm" className="w-[112px]" onClick={onSelect}>
              Выбрать
            </Button>
          )}
        </div>
      </div>

      {expanded &&
        members.map((m) => (
          <div
            key={m.name}
            className="flex items-center gap-4 border-b border-border-subtle bg-elevated px-4 py-2.5 pl-11 last:border-b-0"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span
                aria-hidden="true"
                className={cn("h-2 w-2 shrink-0 rounded-full", dotColors[latencyClass(m.delay)])}
              />
              <span className="truncate text-sm text-text-secondary">
                {m.active ? `${m.name} · активен` : m.name}
              </span>
            </div>
            <div className="flex w-24 shrink-0 items-center justify-end">
              <span className={cn("font-mono text-sm", latencyTextColors[latencyClass(m.delay)])}>
                {latencyLabel(m.delay)}
              </span>
            </div>
            <span aria-hidden="true" className="w-12 shrink-0" />
            <span aria-hidden="true" className="w-[120px] shrink-0" />
          </div>
        ))}
    </>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @submerge/web test -- NodeRow`
Expected: PASS (existing NodeRow tests still pass — plain items render no chevron).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/features/nodes/NodeRow.tsx packages/web/src/features/nodes/NodeRow.test.tsx
git commit -m "feat(web): expandable view-only members for collapsed group nodes"
```

---

### Task 7: Full gates + visual check + memory note

**Files:**
- Modify: `/Users/gentslava/.claude/projects/-Users-gentslava-Developer-submerge/memory/phase4-followups.md` and its `MEMORY.md` pointer (mark the dedup follow-up resolved).

- [ ] **Step 1: Run the full gates**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`
Expected: all green.

- [ ] **Step 2: Visual verification (design gate)**

Per AGENTS, render the Узлы screen at 1440×1024 dark, expand a collapsed group, and confirm: single rows are visually unchanged (chevron only on group rows), member sub-rows read as secondary/indented, ping column stays aligned. Use the running app or `pnpm -F @submerge/web dev` + browser MCP.

- [ ] **Step 3: Update the dedup memory note**

Edit `memory/phase4-followups.md`: note the dedup/"Прочие" follow-up is resolved by same-name url-test collapse (spec `docs/specs/2026-07-01-node-collapse-design.md`). Update the one-line pointer in `MEMORY.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: node-collapse plan"
```

(The memory files live outside the repo; save them with the Write tool, no git.)

- [ ] **Step 5: Deploy**

Ship via the normal path — push to `master`, CI builds the `submerge` image, then redeploy the stack (the config regenerates on next `applyConfig`, i.e. when sources change or the server restarts). Note: existing manual node selections may reset once (see spec "Known limitation").

---

## Self-Review

**Spec coverage:**
- Grouping key / true-dup collapse → Task 3. ✓
- url-test subgroup emission + reserved guard + PROXY/AUTO refs → Task 4. ✓
- Nested-url-test verify → Task 1 (gates Task 4). ✓
- Data contract (`members`) → Task 2; `toNodeView` (delay = active) → Task 5. ✓
- UI expandable view-only members, group ping = active → Task 6. ✓
- ⚡/live polling on group names → no code change (uses `PROXY.all` names); noted in spec §5, exercised by existing paths. ✓
- Backward-compat no-op → asserted by the pre-existing `buildConfig` tests kept green in Task 4. ✓
- Known limitation (selection reset) → Task 7 Step 5. ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code. ✓

**Type consistency:** `TopLevelEntry`/`groupProxies` (Task 3) consumed by `buildConfig` (Task 4); `NodeMember` (Task 2) consumed by `toNodeView` (Task 5) and `NodeRow` (Task 6); member name format `«<base> #k»` consistent across Tasks 4/5/6; selection via `group: "PROXY"` unchanged. ✓
