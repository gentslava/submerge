# submerge v2 — Phase 2: Ingest (sources / nodes / settings + clients)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the proven PoC ingest logic (`combine/parse.js`, `combine/generate.js`, `combine/server.js`) into `packages/server` as typed, tested modules (`sources`, `nodes`, `settings`) behind isolated, Zod-validated clients (`mihomo`, `happDecoder`), exposed via tRPC routers.

**Architecture:** Pure parsers (`detectKind`, `extractSubUrl`, `parseVless`, `parseProxiesFromText`) and config generation (`buildConfig`) are side-effect-free and unit-tested directly. All I/O to mihomo/happ-decoder goes through `clients/*` (timeouts + Zod `.parse()` on every response). A module = thin `router.ts` (validation + dispatch) + `service.ts` (logic + Drizzle directly). Services take `db` as a parameter; clients use global `fetch` so service tests mock `fetch` once and exercise client + service together. No DI container, no repositories.

**Tech Stack:** Node 24 LTS, strict TypeScript, tRPC v11, Drizzle ORM + better-sqlite3 (`:memory:` in tests), Zod 4, js-yaml, Vitest.

---

## File structure (created/modified in Phase 2)

```
packages/
├─ shared/src/
│  └─ schemas.ts                     # MODIFY: + NodeView, tRPC IO schemas
├─ server/src/
│  ├─ config/env.ts                  # MODIFY: + MIHOMO_CONFIG_PATH/TARGET, HWID_FILE
│  ├─ clients/
│  │  ├─ mihomo.ts                    # NEW: Clash REST API client (proxies/delay/select/reload) + Zod
│  │  ├─ mihomo.test.ts               # NEW
│  │  ├─ happDecoder.ts               # NEW: POST /decode {link,hwid} + Zod
│  │  └─ happDecoder.test.ts          # NEW
│  ├─ modules/
│  │  ├─ sources/
│  │  │  ├─ parse.ts                  # NEW: pure parsers (ported from combine/parse.js)
│  │  │  ├─ parse.test.ts             # NEW
│  │  │  ├─ ingest.ts                 # NEW: fetchSubscription / ingestHapp / ingestSource
│  │  │  ├─ ingest.test.ts            # NEW
│  │  │  ├─ service.ts                # NEW: list/add/remove/refresh/toggle/reorder (Drizzle)
│  │  │  ├─ service.test.ts           # NEW
│  │  │  └─ router.ts                 # NEW: tRPC sources router
│  │  ├─ nodes/
│  │  │  ├─ config.ts                 # NEW: buildConfig + name dedup (ported from generate.js)
│  │  │  ├─ config.test.ts            # NEW
│  │  │  ├─ service.ts                # NEW: collectProxies/applyConfig/list/delay/select
│  │  │  ├─ service.test.ts           # NEW
│  │  │  └─ router.ts                 # NEW: tRPC nodes router
│  │  └─ settings/
│  │     ├─ service.ts                # NEW: get/getAll/set + getOrCreateHwid
│  │     ├─ service.test.ts           # NEW
│  │     └─ router.ts                 # NEW: tRPC settings router
│  └─ trpc/router.ts                  # MODIFY: mount sources/nodes/settings routers
```

> The PoC (`combine/`, `mihomo/`, `happ-decoder/`, root `docker-compose.yml`) stays untouched — it is the behavioral reference. happ-decoder and mihomo run unchanged; we only add a typed client for them.

---

## Notes for implementers (read before Task 1)

- **Check current APIs via Context7 MCP** before coding: Zod 4 (`z.looseObject`, `z.record`, `z.coerce`, `.default`), tRPC v11 (`router`, `publicProcedure.input().query/mutation`, `createCallerFactory`), Drizzle sqlite-core (`eq`, `asc`, `max`, `.returning()`, `.run()/.all()/.get()`), `js-yaml` (`load`, `dump`). Versions are latest-major; signatures may differ from memory.
- **Run commands from `packages/server`** unless noted. `pnpm vitest run <file>` runs a single test file.
- **`js-yaml` is a new dependency** for `@submerge/server` (Task 1 adds it). The PoC used it in `combine/`.
- **Behavioral reference, do not diverge silently:** `combine/parse.js` (parsers), `combine/generate.js` (config), `combine/server.js` (orchestration: `allProxies` dedup, `reload`, HWID bootstrap IIFE).
- **Every external response is `.parse()`d** (AGENTS.md hard rule) — see `clients/*`.
- **HWID flow (ADR-0002):** per-source flag, off by default. For https subscriptions the server adds `X-Hwid` + `X-Device-Os` itself; for `happ://` it only passes the `hwid` boolean to happ-decoder, which injects the header via mitmproxy. The HWID value is one stable string per instance, stored in `settings` and mirrored to `env.HWID_FILE` so happ-decoder (which reads that file, unchanged) and the server agree on it.

---

### Task 1: Contract groundwork — env + shared schemas

**Files:**
- Modify: `packages/server/src/config/env.ts`
- Modify: `packages/server/src/config/env.test.ts`
- Modify: `packages/server/package.json` (add `js-yaml` + `@types/js-yaml`)
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/schemas.test.ts`

- [ ] **Step 1: Add new env fields with a failing test**

Append to `packages/server/src/config/env.test.ts` (inside the existing `describe("parseEnv", ...)`):

```ts
  it("provides mihomo config + hwid file defaults", () => {
    const env = parseEnv({});
    expect(env.MIHOMO_CONFIG_PATH).toBe("/mihomo/config.yaml");
    expect(env.MIHOMO_CONFIG_TARGET).toBe("/root/.config/mihomo/config.yaml");
    expect(env.HWID_FILE).toBe("/mihomo/hwid.txt");
  });
  it("overrides config path from the environment", () => {
    expect(parseEnv({ MIHOMO_CONFIG_PATH: "/tmp/c.yaml" }).MIHOMO_CONFIG_PATH).toBe("/tmp/c.yaml");
  });
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `cd packages/server && pnpm vitest run src/config/env.test.ts`
Expected: FAIL — `MIHOMO_CONFIG_PATH` is `undefined`.

- [ ] **Step 3: Extend the env schema**

In `packages/server/src/config/env.ts`, add three fields to the `z.object({ ... })` (keep existing fields as-is):

```ts
  // Where the server writes the generated mihomo config (shared volume in compose).
  MIHOMO_CONFIG_PATH: z.string().default("/mihomo/config.yaml"),
  // Path as mihomo sees it, sent in the reload body (PUT /configs).
  MIHOMO_CONFIG_TARGET: z.string().default("/root/.config/mihomo/config.yaml"),
  // Stable HWID is mirrored here so happ-decoder (unchanged) and the server agree.
  HWID_FILE: z.string().default("/mihomo/hwid.txt"),
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `cd packages/server && pnpm vitest run src/config/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `js-yaml` dependency**

In `packages/server/package.json`, add to `dependencies`: `"js-yaml": "latest"`, and to `devDependencies`: `"@types/js-yaml": "latest"`. Then run `cd ~/Developer/submerge && pnpm install`.
Expected: `pnpm-lock.yaml` updated, no errors.

- [ ] **Step 6: Add shared schemas with a failing test**

Append to `packages/shared/src/schemas.test.ts`:

```ts
import { nodeViewSchema, selectNodeInput, reorderInput } from "./schemas.js";

describe("phase2 schemas", () => {
  it("validates a node view", () => {
    const v = nodeViewSchema.parse({ now: "n1", all: [{ name: "n1", type: "vless", delay: 42 }] });
    expect(v.all[0]?.delay).toBe(42);
  });
  it("allows a null delay (unreachable / untested)", () => {
    const v = nodeViewSchema.parse({ now: null, all: [{ name: "n1", type: "vless", delay: null }] });
    expect(v.all[0]?.delay).toBeNull();
  });
  it("validates select + reorder inputs", () => {
    expect(selectNodeInput.parse({ group: "PROXY", name: "n1" }).group).toBe("PROXY");
    expect(reorderInput.parse({ ids: [3, 1, 2] }).ids).toHaveLength(3);
  });
});
```

- [ ] **Step 7: Run the test — confirm it fails**

Run: `cd packages/shared && pnpm vitest run`
Expected: FAIL — `nodeViewSchema` is not exported.

- [ ] **Step 8: Add the schemas**

Append to `packages/shared/src/schemas.ts`:

```ts
// A single node as shown in the UI: live "now"/delay come from mihomo, not the DB.
export const nodeItemSchema = z.object({
  name: z.string(),
  type: z.string(),
  delay: z.number().nullable(), // null = unreachable or not yet tested
  udp: z.boolean().optional(),
});
export type NodeItem = z.infer<typeof nodeItemSchema>;

// The PROXY select group: currently selected node + all selectable members.
export const nodeViewSchema = z.object({
  now: z.string().nullable(),
  all: z.array(nodeItemSchema),
});
export type NodeView = z.infer<typeof nodeViewSchema>;

// ── tRPC input schemas ────────────────────────────────────────────
export const idInput = z.object({ id: z.number().int() });
export const reorderInput = z.object({ ids: z.array(z.number().int()) });
export const selectNodeInput = z.object({ group: z.string().min(1), name: z.string().min(1) });
export const delayInput = z.object({ name: z.string().min(1) });
export const setSettingInput = z.object({ key: z.string().min(1), value: z.string() });
```

- [ ] **Step 9: Run shared tests — confirm they pass**

Run: `cd packages/shared && pnpm vitest run`
Expected: PASS (all schema tests).

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/config/env.ts packages/server/src/config/env.test.ts \
        packages/server/package.json packages/shared/src/schemas.ts \
        packages/shared/src/schemas.test.ts pnpm-lock.yaml
git commit -m "feat(shared,server): phase 2 contract groundwork (NodeView, tRPC IO, mihomo config env)"
```

---

### Task 2: Source parsers (pure)

**Files:**
- Create: `packages/server/src/modules/sources/parse.ts`
- Test: `packages/server/src/modules/sources/parse.test.ts`

Ported from `combine/parse.js`. Pure functions, no I/O. Output proxy objects conform to `@submerge/shared` `Proxy` (loose object: required `name/type/server/port`, extra mihomo keys pass through).

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/modules/sources/parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectKind, extractSubUrl, parseVless, parseProxiesFromText } from "./parse.js";

describe("extractSubUrl", () => {
  it("returns a plain https url as-is", () => {
    expect(extractSubUrl("https://ex.com/sub")).toBe("https://ex.com/sub");
  });
  it("extracts ?url= from a client deep-link", () => {
    expect(extractSubUrl("clash://install-config?url=https%3A%2F%2Fex.com%2Fs")).toBe("https://ex.com/s");
  });
  it("extracts an embedded url from incy/happ-add style links", () => {
    expect(extractSubUrl("happ://add/https://ex.com/s")).toBe("https://ex.com/s");
  });
  it("returns null when there is no url", () => {
    expect(extractSubUrl("vless://uuid@host:443")).toBeNull();
  });
});

describe("detectKind", () => {
  it("detects vless", () => expect(detectKind("vless://u@h:443")).toBe("vless"));
  it("detects encrypted happ", () => expect(detectKind("happ://crypt5/abc")).toBe("happ"));
  it("detects a subscription url", () => expect(detectKind("https://ex.com/sub")).toBe("sub"));
  it("detects a client deep-link as sub", () =>
    expect(detectKind("clash://install-config?url=https%3A%2F%2Fex.com%2Fs")).toBe("sub"));
  it("throws on an empty string", () => expect(() => detectKind("")).toThrow());
  it("rejects non-vless single nodes", () => expect(() => detectKind("trojan://x@h:443")).toThrow());
});

describe("parseVless", () => {
  it("parses a reality tcp node", () => {
    const p = parseVless(
      "vless://11111111-1111-1111-1111-111111111111@ex.com:443?security=reality&type=tcp&sni=deepl.com&pbk=KEY&sid=SID&flow=xtls-rprx-vision&fp=chrome#NL",
    );
    expect(p).toMatchObject({
      name: "NL",
      type: "vless",
      server: "ex.com",
      port: 443,
      uuid: "11111111-1111-1111-1111-111111111111",
      tls: true,
      servername: "deepl.com",
      flow: "xtls-rprx-vision",
      "client-fingerprint": "chrome",
    });
    expect((p as Record<string, unknown>)["reality-opts"]).toEqual({ "public-key": "KEY", "short-id": "SID" });
  });
  it("parses a ws node with host header and default name", () => {
    const p = parseVless("vless://uuid@ex.com:8443?security=tls&type=ws&host=cdn.ex.com&path=%2Fws");
    expect(p.name).toBe("ex.com:8443");
    expect(p.network).toBe("ws");
    expect((p as Record<string, unknown>)["ws-opts"]).toEqual({
      path: "/ws",
      headers: { Host: "cdn.ex.com" },
    });
  });
  it("throws when the uuid is missing", () => {
    expect(() => parseVless("vless://@ex.com:443")).toThrow();
  });
});

describe("parseProxiesFromText", () => {
  it("parses clash/mihomo yaml", () => {
    const yaml = "proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n";
    const out = parseProxiesFromText(yaml);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("A");
  });
  it("parses a v2ray/xray vnext outbound", () => {
    const json = JSON.stringify({
      remarks: "R",
      outbounds: [
        {
          protocol: "vless",
          settings: { vnext: [{ address: "ex.com", port: 443, users: [{ id: "u", flow: "xtls-rprx-vision" }] }] },
          streamSettings: { network: "tcp", security: "reality", realitySettings: { publicKey: "K", shortId: "S", serverName: "sni" } },
        },
      ],
    });
    const out = parseProxiesFromText(json);
    expect(out[0]).toMatchObject({ name: "R", server: "ex.com", port: 443, uuid: "u", tls: true });
  });
  it("parses a sing-box vless outbound", () => {
    const json = JSON.stringify({
      outbounds: [
        { type: "vless", tag: "SB", server: "ex.com", server_port: 443, uuid: "u", tls: { enabled: true, server_name: "sni" } },
      ],
    });
    const out = parseProxiesFromText(json);
    expect(out[0]).toMatchObject({ name: "SB", server: "ex.com", port: 443, uuid: "u", tls: true, servername: "sni" });
  });
  it("parses a base64 list of vless links", () => {
    const list = "vless://u@ex.com:443#A\nvless://u@ex.com:8443#B";
    const b64 = Buffer.from(list, "utf8").toString("base64");
    const out = parseProxiesFromText(b64);
    expect(out.map((p) => p.name)).toEqual(["A", "B"]);
  });
  it("returns an empty array for unrecognized text", () => {
    expect(parseProxiesFromText("not a subscription")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `cd packages/server && pnpm vitest run src/modules/sources/parse.test.ts`
Expected: FAIL — `./parse.js` does not exist.

- [ ] **Step 3: Implement the parsers**

Create `packages/server/src/modules/sources/parse.ts`:

```ts
// Ingest layer: parse node sources (ported from combine/parse.js).
//  - vless:// (ws+tls / tcp+reality / grpc / xhttp / http)
//  - subscriptions: clash/mihomo yaml | base64 list | v2ray/xray JSON | sing-box JSON
//  - happ:// is handled separately via the happ-decoder client (see ingest.ts)
import type { Proxy } from "@submerge/shared";
import { sourceKindSchema, type SourceKind } from "@submerge/shared";
import yaml from "js-yaml";

// ── Extract a subscription URL from a client deep-link ──────────────
// Covers scheme://action?url=<encoded> (clash/sing-box/v2rayng) and
// scheme://action/<plain-url> (incy/happ-add/streisand/hiddify).
export function extractSubUrl(value: string): string | null {
  const v = (value || "").trim();
  if (/^https?:\/\//i.test(v)) return v; // already a url
  try {
    const u = new URL(v);
    const q = u.searchParams.get("url") || u.searchParams.get("link");
    if (q && /^https?:\/\//i.test(q)) return q; // ?url=<encoded>
  } catch {
    /* not a URL */
  }
  const m = v.match(/https?:\/\/[^\s"'<>]+/i); // http(s) somewhere in the string
  if (m) {
    try {
      return decodeURIComponent(m[0]);
    } catch {
      return m[0];
    }
  }
  return null;
}

// ── Auto-detect the source kind ─────────────────────────────────────
export function detectKind(value: string): SourceKind {
  const v = (value || "").trim();
  if (!v) throw new Error("empty string");
  if (v.startsWith("vless://")) return "vless";
  if (/^happ:\/\/crypt/i.test(v)) return "happ"; // encrypted happ → decoder
  if (/^(vmess|trojan|ss|ssr|hysteria2?|tuic):\/\//i.test(v))
    throw new Error("single nodes are only supported for vless:// (use a subscription for the rest)");
  if (extractSubUrl(v)) return "sub"; // url or client deep-link (incy/clash/sing-box/happ-add/…)
  if (/^happ:\/\//i.test(v)) return "happ"; // happ:// without an embedded url → decoder
  try {
    const d = Buffer.from(v.replace(/\s+/g, ""), "base64").toString("utf8");
    if (d.includes("://")) return "sub"; // base64 subscription content pasted directly
  } catch {
    /* not base64 */
  }
  throw new Error("could not detect kind: expected vless:// , happ:// , a subscription URL, or a client deep-link");
}

// Asserts the detected kind is a valid SourceKind via the shared schema.
export function detectKindSafe(value: string): SourceKind {
  return sourceKindSchema.parse(detectKind(value));
}

// ── vless:// → mihomo proxy ─────────────────────────────────────────
export function parseVless(uri: string): Proxy {
  const u = new URL(uri.trim());
  if (u.protocol !== "vless:") throw new Error("not a vless:// link");
  const q = u.searchParams;
  const server = u.hostname;
  const port = Number(u.port) || 443;
  const uuid = decodeURIComponent(u.username);
  if (!uuid) throw new Error("could not parse the UUID");
  const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : `${server}:${port}`;

  const security = q.get("security") || "none";
  const net = q.get("type") || "tcp";
  const sni = q.get("sni") || q.get("host") || server;
  const fp = q.get("fp") || "chrome";
  const flow = q.get("flow") || "";
  const host = q.get("host") || "";
  const path = q.get("path") ? decodeURIComponent(q.get("path") as string) : "/";

  const p: Record<string, unknown> = {
    name,
    type: "vless",
    server,
    port,
    uuid,
    udp: true,
    "client-fingerprint": fp,
    network: net === "h2" ? "http" : net,
  };
  if (flow) p.flow = flow;
  if (security === "tls" || security === "reality") {
    p.tls = true;
    p.servername = sni;
    if (security === "reality")
      p["reality-opts"] = { "public-key": q.get("pbk") || "", "short-id": q.get("sid") || "" };
  }
  if (net === "ws") p["ws-opts"] = { path, headers: { Host: host || sni } };
  else if (net === "grpc") p["grpc-opts"] = { "grpc-service-name": q.get("serviceName") || path.replace(/^\//, "") };
  else if (net === "http" || net === "h2") p["h2-opts"] = { path, host: host ? [host] : [sni] };
  else if (net === "xhttp") p["xhttp-opts"] = { path, host: host || sni, mode: q.get("mode") || "auto" };
  return p as Proxy;
}

// ── v2ray/xray JSON outbound → mihomo proxy (best-effort, Happ format) ──
function v2rayOutboundToMihomo(ob: any, remark?: string): Proxy | null {
  if (!ob || ob.protocol !== "vless") return null; // freedom/blackhole/direct skipped
  const vnext = ob.settings?.vnext?.[0];
  const user = vnext?.users?.[0];
  if (!vnext || !user) return null;
  const ss = ob.streamSettings || {};
  const net = ss.network || "tcp";
  const p: Record<string, unknown> = {
    name: remark || ob.tag || `${vnext.address}:${vnext.port}`,
    type: "vless",
    server: vnext.address,
    port: Number(vnext.port),
    uuid: user.id,
    udp: true,
    network: net === "h2" ? "http" : net,
  };
  if (user.flow) p.flow = user.flow;
  const sec = ss.security || "none";
  if (sec === "tls" || sec === "reality") {
    p.tls = true;
    const t = ss.tlsSettings || ss.realitySettings || {};
    p.servername = t.serverName || vnext.address;
    if (t.fingerprint) p["client-fingerprint"] = t.fingerprint;
    if (sec === "reality") {
      const r = ss.realitySettings || {};
      p["reality-opts"] = { "public-key": r.publicKey || "", "short-id": r.shortId || "" };
    }
  }
  if (net === "ws") p["ws-opts"] = { path: ss.wsSettings?.path || "/", headers: ss.wsSettings?.headers || {} };
  else if (net === "grpc") p["grpc-opts"] = { "grpc-service-name": ss.grpcSettings?.serviceName || "" };
  return p as Proxy;
}

// ── sing-box outbound → mihomo proxy (type/server/server_port) ──────
function singBoxOutboundToMihomo(ob: any): Proxy | null {
  if (!ob || ob.type !== "vless" || !ob.server) return null;
  const net = ob.transport?.type || "tcp";
  const p: Record<string, unknown> = {
    name: ob.tag || `${ob.server}:${ob.server_port}`,
    type: "vless",
    server: ob.server,
    port: Number(ob.server_port),
    uuid: ob.uuid,
    udp: true,
    network: net,
  };
  if (ob.flow) p.flow = ob.flow;
  const tls = ob.tls;
  if (tls?.enabled) {
    p.tls = true;
    p.servername = tls.server_name || ob.server;
    if (tls.utls?.fingerprint) p["client-fingerprint"] = tls.utls.fingerprint;
    if (tls.reality?.enabled)
      p["reality-opts"] = { "public-key": tls.reality.public_key || "", "short-id": tls.reality.short_id || "" };
  }
  if (net === "ws") p["ws-opts"] = { path: ob.transport?.path || "/", headers: ob.transport?.headers || {} };
  else if (net === "grpc") p["grpc-opts"] = { "grpc-service-name": ob.transport?.service_name || "" };
  return p as Proxy;
}

// ── Parse subscription body text into mihomo proxies ────────────────
export function parseProxiesFromText(text: string): Proxy[] {
  // 1) clash/mihomo yaml
  try {
    const doc = yaml.load(text) as { proxies?: unknown[] } | undefined;
    if (doc && Array.isArray(doc.proxies) && doc.proxies.length) return doc.proxies as Proxy[];
  } catch {
    /* not yaml */
  }

  // 2) v2ray/xray JSON (array of profiles with outbounds, or {outbounds:[…]})
  try {
    const j = JSON.parse(text);
    const profiles: any[] | null = Array.isArray(j) ? j : j.outbounds ? [j] : null;
    if (profiles) {
      const out: Proxy[] = [];
      for (const prof of profiles)
        for (const ob of prof.outbounds || []) {
          const p = v2rayOutboundToMihomo(ob, prof.remarks) || singBoxOutboundToMihomo(ob);
          if (p) out.push(p);
        }
      if (out.length) return out;
    }
  } catch {
    /* not json */
  }

  // 3) base64 list or plain list of links
  let decoded = text;
  try {
    const b = Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8");
    if (b.includes("://")) decoded = b;
  } catch {
    /* not base64 */
  }
  const out: Proxy[] = [];
  for (const line of decoded.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("vless://")) continue;
    try {
      out.push(parseVless(s));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}
```

> **Note on `any`:** the v2ray/sing-box helpers parse arbitrary external JSON; `any` here mirrors the PoC's untyped traversal and is contained to these two functions. Biome may warn — if it errors the build, add a scoped `// biome-ignore lint/suspicious/noExplicitAny: external untyped JSON` on the parameter lines.

- [ ] **Step 4: Run the test — confirm it passes**

Run: `cd packages/server && pnpm vitest run src/modules/sources/parse.test.ts`
Expected: PASS (all parser tests).

- [ ] **Step 5: Lint check (parsers touch `any`)**

Run: `cd ~/Developer/submerge && pnpm lint`
Expected: no errors. If `noExplicitAny` errors, add the scoped `biome-ignore` comments noted above and re-run.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/modules/sources/parse.ts packages/server/src/modules/sources/parse.test.ts
git commit -m "feat(server): port source parsers (detectKind/parseVless/parseProxiesFromText) + tests"
```

---

### Task 3: mihomo client (Clash REST API)

**Files:**
- Create: `packages/server/src/clients/mihomo.ts`
- Test: `packages/server/src/clients/mihomo.test.ts`

Isolated client: every response is `.parse()`d; `Authorization: Bearer <secret>` on every call; a 5s timeout via `AbortSignal.timeout`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/clients/mihomo.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProxies, getDelay, selectProxy, reloadConfig } from "./mihomo.js";

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(handler));
}
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

afterEach(() => vi.unstubAllGlobals());

describe("mihomo client", () => {
  it("parses /proxies and sends the auth header", async () => {
    let seenAuth = "";
    mockFetch((url, init) => {
      seenAuth = new Headers(init?.headers).get("authorization") ?? "";
      expect(url).toContain("/proxies");
      return json({ proxies: { PROXY: { name: "PROXY", type: "Selector", now: "A", all: ["A"], history: [] } } });
    });
    const res = await getProxies();
    expect(res.proxies.PROXY?.now).toBe("A");
    expect(seenAuth).toMatch(/^Bearer /);
  });

  it("parses a delay response", async () => {
    mockFetch(() => json({ delay: 123 }));
    expect(await getDelay("A")).toEqual({ delay: 123 });
  });

  it("returns delay null shape on an error status", async () => {
    mockFetch(() => json({ message: "timeout" }, { status: 408 }));
    await expect(getDelay("A")).rejects.toThrow();
  });

  it("selects a proxy via PUT", async () => {
    let method = "";
    mockFetch((_url, init) => {
      method = init?.method ?? "";
      return new Response(null, { status: 204 });
    });
    await selectProxy("PROXY", "A");
    expect(method).toBe("PUT");
  });

  it("reloads the config via PUT /configs", async () => {
    let body = "";
    mockFetch((url, init) => {
      expect(url).toContain("/configs");
      body = String(init?.body ?? "");
      return new Response(null, { status: 204 });
    });
    await reloadConfig("/root/.config/mihomo/config.yaml");
    expect(JSON.parse(body)).toEqual({ path: "/root/.config/mihomo/config.yaml" });
  });

  it("throws when mihomo returns 500 on proxies", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    await expect(getProxies()).rejects.toThrow(/mihomo/i);
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `cd packages/server && pnpm vitest run src/clients/mihomo.test.ts`
Expected: FAIL — `./mihomo.js` does not exist.

- [ ] **Step 3: Implement the client**

Create `packages/server/src/clients/mihomo.ts`:

```ts
// Isolated mihomo (Clash) REST API client. Every response is Zod-parsed.
import { z } from "zod";
import { env } from "../config/env.js";

const TIMEOUT_MS = 5000;
const TEST_URL = "https://www.gstatic.com/generate_204";

const historyEntrySchema = z.object({ time: z.string(), delay: z.number() });
// mihomo returns far more fields; pin only what we read, pass the rest through.
const mihomoProxySchema = z.looseObject({
  name: z.string(),
  type: z.string(),
  now: z.string().optional(),
  all: z.array(z.string()).optional(),
  udp: z.boolean().optional(),
  history: z.array(historyEntrySchema).default([]),
});
export type MihomoProxy = z.infer<typeof mihomoProxySchema>;

const proxiesResponseSchema = z.object({ proxies: z.record(z.string(), mihomoProxySchema) });
export type ProxiesResponse = z.infer<typeof proxiesResponseSchema>;

const delayResponseSchema = z.object({ delay: z.number() });
export type DelayResponse = z.infer<typeof delayResponseSchema>;

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${env.MIHOMO_API}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${env.MIHOMO_SECRET}` },
  });
}

export async function getProxies(): Promise<ProxiesResponse> {
  const r = await call("/proxies");
  if (!r.ok) throw new Error(`mihomo /proxies returned HTTP ${r.status}`);
  return proxiesResponseSchema.parse(await r.json());
}

export async function getDelay(name: string): Promise<DelayResponse> {
  const q = `timeout=3000&url=${encodeURIComponent(TEST_URL)}`;
  const r = await call(`/proxies/${encodeURIComponent(name)}/delay?${q}`);
  if (!r.ok) throw new Error(`mihomo delay for "${name}" returned HTTP ${r.status}`);
  return delayResponseSchema.parse(await r.json());
}

export async function selectProxy(group: string, name: string): Promise<void> {
  const r = await call(`/proxies/${encodeURIComponent(group)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`mihomo select ${group}→${name} returned HTTP ${r.status}`);
}

export async function reloadConfig(targetPath: string): Promise<void> {
  const r = await call("/configs?force=true", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: targetPath }),
  });
  if (!r.ok) throw new Error(`mihomo reload returned HTTP ${r.status}`);
}
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `cd packages/server && pnpm vitest run src/clients/mihomo.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/clients/mihomo.ts packages/server/src/clients/mihomo.test.ts
git commit -m "feat(server): isolated mihomo client (proxies/delay/select/reload) + Zod + tests"
```

---

### Task 4: happ-decoder client

**Files:**
- Create: `packages/server/src/clients/happDecoder.ts`
- Test: `packages/server/src/clients/happDecoder.test.ts`

Wraps `POST /decode {link, hwid}`. happ-decoder injects `X-Hwid` itself via mitmproxy; the client only forwards the boolean flag. 70s timeout (Happ binary is slow). Response is Zod-parsed.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/clients/happDecoder.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeHapp } from "./happDecoder.js";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

afterEach(() => vi.unstubAllGlobals());

describe("happDecoder client", () => {
  it("posts {link,hwid} and parses ok response", async () => {
    let sentBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        expect(url).toContain("/decode");
        sentBody = JSON.parse(String(init?.body));
        return json({ ok: true, url: "https://ex.com/s", body: "proxies:\n  - {}" });
      }),
    );
    const res = await decodeHapp("happ://crypt5/abc", true);
    expect(res.ok).toBe(true);
    expect(res.url).toBe("https://ex.com/s");
    expect(sentBody).toEqual({ link: "happ://crypt5/abc", hwid: true });
  });

  it("throws when the decoder reports ok:false", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ ok: false, error: "expired" })));
    await expect(decodeHapp("happ://crypt5/abc", false)).rejects.toThrow(/expired/);
  });

  it("throws a clear error when the decoder is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(decodeHapp("happ://crypt5/abc", false)).rejects.toThrow(/happ-decoder/);
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `cd packages/server && pnpm vitest run src/clients/happDecoder.test.ts`
Expected: FAIL — `./happDecoder.js` does not exist.

- [ ] **Step 3: Implement the client**

Create `packages/server/src/clients/happDecoder.ts`:

```ts
// Isolated happ-decoder client: POST /decode {link, hwid}.
// The decoder runs the official Happ binary and injects X-Hwid via mitmproxy
// when hwid=true; we only forward the flag. Response is Zod-parsed.
import { z } from "zod";
import { env } from "../config/env.js";

const TIMEOUT_MS = 70_000; // Happ binary + Xvfb startup is slow

const decodeResponseSchema = z.object({
  ok: z.boolean(),
  url: z.string().optional(),
  body: z.string().optional(),
  error: z.string().optional(),
});
export type DecodeResponse = z.infer<typeof decodeResponseSchema>;

export async function decodeHapp(link: string, useHwid: boolean): Promise<DecodeResponse> {
  let r: Response;
  try {
    r = await fetch(`${env.HAPP_DECODER_URL}/decode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ link: link.trim(), hwid: !!useHwid }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`happ-decoder unreachable/timeout (${env.HAPP_DECODER_URL}): ${msg}`);
  }
  const parsed = decodeResponseSchema.safeParse(await r.json().catch(() => ({})));
  if (!parsed.success) throw new Error(`happ-decoder returned an unexpected response (HTTP ${r.status})`);
  const data = parsed.data;
  if (!r.ok || !data.ok) throw new Error(data.error || `happ-decoder returned HTTP ${r.status}`);
  return data;
}
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `cd packages/server && pnpm vitest run src/clients/happDecoder.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/clients/happDecoder.ts packages/server/src/clients/happDecoder.test.ts
git commit -m "feat(server): isolated happ-decoder client (POST /decode) + Zod + tests"
```

---

### Task 5: settings service (+ HWID bootstrap)

**Files:**
- Create: `packages/server/src/modules/settings/service.ts`
- Test: `packages/server/src/modules/settings/service.test.ts`

Key-value settings over the `settings` table. `getOrCreateHwid` ports the PoC bootstrap IIFE: prefer the DB value, then `env.HWID_FILE`, else generate; persist to DB and mirror to the file (best-effort) so happ-decoder agrees.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/modules/settings/service.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.js";
import { getAllSettings, getSetting, setSetting, getOrCreateHwid } from "./service.js";

function freshDb() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  return db;
}

afterEach(() => vi.unstubAllGlobals());

describe("settings service", () => {
  it("sets, gets, and lists settings", () => {
    const db = freshDb();
    setSetting(db, "theme", "dark");
    expect(getSetting(db, "theme")).toBe("dark");
    expect(getSetting(db, "missing")).toBeUndefined();
    setSetting(db, "poll", "5");
    expect(getAllSettings(db)).toEqual({ theme: "dark", poll: "5" });
  });

  it("upserts an existing key", () => {
    const db = freshDb();
    setSetting(db, "theme", "dark");
    setSetting(db, "theme", "light");
    expect(getSetting(db, "theme")).toBe("light");
  });

  it("generates a hwid, persists it, and mirrors it to the file", () => {
    const db = freshDb();
    const file = join(mkdtempSync(join(tmpdir(), "submerge-")), "hwid.txt");
    const hwid = getOrCreateHwid(db, file);
    expect(hwid).toMatch(/^[0-9a-f]{32}$/);
    expect(getSetting(db, "hwid")).toBe(hwid); // persisted in DB
    expect(readFileSync(file, "utf8").trim()).toBe(hwid); // mirrored to file
    expect(getOrCreateHwid(db, file)).toBe(hwid); // stable on second call
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `cd packages/server && pnpm vitest run src/modules/settings/service.test.ts`
Expected: FAIL — `./service.js` does not exist.

- [ ] **Step 3: Implement the service**

Create `packages/server/src/modules/settings/service.ts`:

```ts
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { env } from "../../config/env.js";
import { settings } from "../../db/schema.js";

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value;
}

export function getAllSettings(db: Db): Record<string, string> {
  const rows = db.select().from(settings).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function setSetting(db: Db, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

// Stable per-instance HWID (ADR-0002). Prefer DB, then the mirror file, else
// generate. Always persist to DB and mirror to the file (best-effort) so the
// happ-decoder sidecar — which reads HWID_FILE unchanged — uses the same value.
export function getOrCreateHwid(db: Db, file: string = env.HWID_FILE): string {
  const existing = getSetting(db, "hwid");
  if (existing) {
    mirrorHwid(file, existing);
    return existing;
  }
  let hwid = "";
  if (existsSync(file)) {
    try {
      hwid = readFileSync(file, "utf8").trim();
    } catch {
      /* unreadable; fall through to generate */
    }
  }
  if (!hwid) hwid = randomBytes(16).toString("hex");
  setSetting(db, "hwid", hwid);
  mirrorHwid(file, hwid);
  return hwid;
}

function mirrorHwid(file: string, hwid: string): void {
  try {
    writeFileSync(file, hwid);
  } catch {
    /* file path not writable (e.g. local dev without /mihomo) — DB is source of truth */
  }
}
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `cd packages/server && pnpm vitest run src/modules/settings/service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/settings/service.ts packages/server/src/modules/settings/service.test.ts
git commit -m "feat(server): settings service (kv + HWID bootstrap, ADR-0002) + tests"
```

---

### Task 6: source ingest (fetch + happ + orchestration)

**Files:**
- Create: `packages/server/src/modules/sources/ingest.ts`
- Test: `packages/server/src/modules/sources/ingest.test.ts`

Ports `fetchSubscription` and `ingestHapp` from `combine/parse.js`, plus an `ingestSource` orchestrator that dispatches on `detectKind`. Returns `{ kind, label, proxies }` — no DB writes here (that is the service's job in Task 9). HWID value is passed in by the caller (the service reads it from settings).

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/modules/sources/ingest.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSubscription, ingestSource } from "./ingest.js";

const text = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });
afterEach(() => vi.unstubAllGlobals());

describe("fetchSubscription", () => {
  it("fetches and parses a clash-yaml subscription", async () => {
    vi.stubGlobal("fetch", vi.fn(() => text("proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n")));
    const proxies = await fetchSubscription("https://ex.com/sub", false);
    expect(proxies[0]?.name).toBe("A");
  });

  it("adds X-Hwid + X-Device-Os only when useHwid is true", async () => {
    const seen: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return text("proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n");
      }),
    );
    await fetchSubscription("https://ex.com/sub", false, "HW");
    await fetchSubscription("https://ex.com/sub", true, "HW");
    expect(seen[0]?.get("x-hwid")).toBeNull();
    expect(seen[1]?.get("x-hwid")).toBe("HW");
    expect(seen[1]?.get("x-device-os")).toBe("Android");
  });

  it("throws on a non-ok subscription response", async () => {
    vi.stubGlobal("fetch", vi.fn(() => text("nope", { status: 503 })));
    await expect(fetchSubscription("https://ex.com/sub", false)).rejects.toThrow(/HTTP 503/);
  });

  it("throws when the subscription has no nodes", async () => {
    vi.stubGlobal("fetch", vi.fn(() => text("garbage with no nodes")));
    await expect(fetchSubscription("https://ex.com/sub", false)).rejects.toThrow(/no nodes/i);
  });
});

describe("ingestSource", () => {
  it("ingests a single vless node", async () => {
    const res = await ingestSource("vless://u@ex.com:443?security=tls#NL", false);
    expect(res.kind).toBe("vless");
    expect(res.label).toBe("NL");
    expect(res.proxies).toHaveLength(1);
  });

  it("ingests a subscription url with the label set to the url", async () => {
    vi.stubGlobal("fetch", vi.fn(() => text("proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n")));
    const res = await ingestSource("https://ex.com/sub", false);
    expect(res.kind).toBe("sub");
    expect(res.label).toBe("https://ex.com/sub");
    expect(res.proxies).toHaveLength(1);
  });

  it("ingests inline pasted subscription text (no url)", async () => {
    const list = Buffer.from("vless://u@ex.com:443#A", "utf8").toString("base64");
    const res = await ingestSource(list, false);
    expect(res.kind).toBe("sub");
    expect(res.label).toBe("inline subscription");
    expect(res.proxies[0]?.name).toBe("A");
  });

  it("ingests happ:// via the decoder, deriving nodes from the decoded body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        new Response(
          JSON.stringify({ ok: true, url: "https://ex.com/s", body: "proxies:\n  - {name: H, type: vless, server: ex.com, port: 443, uuid: u}\n" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const res = await ingestSource("happ://crypt5/abc", true, "HW");
    expect(res.kind).toBe("happ");
    expect(res.label).toContain("happ");
    expect(res.proxies[0]?.name).toBe("H");
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `cd packages/server && pnpm vitest run src/modules/sources/ingest.test.ts`
Expected: FAIL — `./ingest.js` does not exist.

- [ ] **Step 3: Implement ingest**

Create `packages/server/src/modules/sources/ingest.ts`:

```ts
import type { Proxy, SourceKind } from "@submerge/shared";
import { decodeHapp } from "../../clients/happDecoder.js";
import { detectKind, extractSubUrl, parseProxiesFromText, parseVless } from "./parse.js";

export interface IngestResult {
  kind: SourceKind;
  label: string;
  proxies: Proxy[];
}

// Fetch an https subscription and parse its body into proxies.
// X-Hwid is sent only when useHwid is set (ADR-0002): device-bound providers
// need it, but sending it elsewhere can burn device-slot limits.
export async function fetchSubscription(url: string, useHwid = false, hwid = ""): Promise<Proxy[]> {
  const headers: Record<string, string> = { "User-Agent": "clash.meta" };
  if (useHwid && hwid) {
    headers["X-Hwid"] = hwid;
    headers["X-Device-Os"] = "Android";
  }
  const res = await fetch(url.trim(), { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`subscription returned HTTP ${res.status}`);
  const proxies = parseProxiesFromText(await res.text());
  if (!proxies.length) throw new Error("subscription had no nodes (clash-yaml / v2ray-json / base64)");
  return proxies;
}

// happ:// → happ-decoder → sub-url/body → proxies.
export async function ingestHapp(link: string, useHwid = false, hwid = ""): Promise<{ via: string; proxies: Proxy[] }> {
  const decoded = await decodeHapp(link, useHwid);
  let proxies = decoded.body ? parseProxiesFromText(decoded.body) : [];
  if (!proxies.length && decoded.url) {
    try {
      proxies = await fetchSubscription(decoded.url, useHwid, hwid);
    } catch {
      /* fall through to the diagnostic below */
    }
  }
  if (!proxies.length) {
    const looksDecoded =
      decoded.body && (decoded.body.includes('"outbounds"') || decoded.body.includes("proxies:") || decoded.body.includes("://"));
    if (looksDecoded)
      throw new Error(`happ decoded (${decoded.url || "—"}) but has no active nodes — the subscription is likely expired`);
    throw new Error(`happ decoded (${decoded.url || "—"}) but the subscription format was not recognized`);
  }
  return { via: decoded.url || "happ", proxies };
}

// Dispatch on detected kind and return a normalized ingest result (no DB writes).
export async function ingestSource(value: string, useHwid = false, hwid = ""): Promise<IngestResult> {
  const kind = detectKind(value);
  if (kind === "vless") {
    const proxy = parseVless(value);
    return { kind, label: proxy.name, proxies: [proxy] };
  }
  if (kind === "sub") {
    const url = extractSubUrl(value);
    const proxies = url ? await fetchSubscription(url, useHwid, hwid) : parseProxiesFromText(value);
    if (!proxies.length) throw new Error("subscription had no nodes");
    return { kind, label: url ?? "inline subscription", proxies };
  }
  // happ
  const { via, proxies } = await ingestHapp(value, useHwid, hwid);
  return { kind, label: `happ → ${via}`, proxies };
}
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `cd packages/server && pnpm vitest run src/modules/sources/ingest.test.ts`
Expected: PASS (all ingest tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/sources/ingest.ts packages/server/src/modules/sources/ingest.test.ts
git commit -m "feat(server): source ingest (fetchSubscription/ingestHapp/ingestSource) + tests"
```

---

### Task 7: nodes config generation (pure)

**Files:**
- Create: `packages/server/src/modules/nodes/config.ts`
- Test: `packages/server/src/modules/nodes/config.test.ts`

Ports `combine/generate.js`. `dedupeNames` replaces the PoC's random suffix with a deterministic one (`-2`, `-3`) for stable configs and testable output. `buildConfig` uses `env.MIHOMO_SECRET` instead of the hardcoded PoC `"poc"`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/modules/nodes/config.test.ts`:

```ts
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import type { Proxy } from "@submerge/shared";
import { buildConfig, dedupeNames } from "./config.js";

const proxy = (name: string): Proxy => ({ name, type: "vless", server: "ex.com", port: 443, uuid: "u" });

describe("dedupeNames", () => {
  it("leaves unique names untouched", () => {
    expect(dedupeNames([proxy("A"), proxy("B")]).map((p) => p.name)).toEqual(["A", "B"]);
  });
  it("disambiguates duplicates deterministically", () => {
    expect(dedupeNames([proxy("A"), proxy("A"), proxy("A")]).map((p) => p.name)).toEqual(["A", "A-2", "A-3"]);
  });
});

describe("buildConfig", () => {
  it("emits PROXY + AUTO groups and a MATCH rule for a populated config", () => {
    const cfg = yaml.load(buildConfig([proxy("A"), proxy("B")])) as any;
    expect(cfg["mixed-port"]).toBe(7890);
    const groups = cfg["proxy-groups"];
    expect(groups[0].name).toBe("PROXY");
    expect(groups[0].proxies).toEqual(["AUTO", "A", "B", "DIRECT"]);
    expect(groups[1].name).toBe("AUTO");
    expect(groups[1].proxies).toEqual(["A", "B"]);
    expect(cfg.rules).toEqual(["MATCH,PROXY"]);
  });
  it("falls back to DIRECT when there are no proxies", () => {
    const cfg = yaml.load(buildConfig([])) as any;
    expect(cfg["proxy-groups"][1].proxies).toEqual(["DIRECT"]);
    expect(cfg.rules).toEqual(["MATCH,DIRECT"]);
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `cd packages/server && pnpm vitest run src/modules/nodes/config.test.ts`
Expected: FAIL — `./config.js` does not exist.

- [ ] **Step 3: Implement config generation**

Create `packages/server/src/modules/nodes/config.ts`:

```ts
// Generate the mihomo config.yaml from a set of proxies (ported from generate.js).
import type { Proxy } from "@submerge/shared";
import yaml from "js-yaml";
import { env } from "../../config/env.js";

// Ensure unique proxy names (mihomo requires it). Deterministic suffix so the
// generated config is stable across reloads and testable (PoC used Math.random).
export function dedupeNames(proxies: Proxy[]): Proxy[] {
  const seen = new Map<string, number>();
  return proxies.map((p) => {
    const count = seen.get(p.name) ?? 0;
    seen.set(p.name, count + 1);
    return count === 0 ? p : { ...p, name: `${p.name}-${count + 1}` };
  });
}

export function buildConfig(proxies: Proxy[]): string {
  const unique = dedupeNames(proxies);
  const names = unique.map((p) => p.name);
  const cfg = {
    "mixed-port": 7890,
    "allow-lan": true,
    "bind-address": "*",
    mode: "rule",
    "log-level": "info",
    ipv6: false,
    "external-controller": "0.0.0.0:9090",
    secret: env.MIHOMO_SECRET,
    proxies: unique,
    "proxy-groups": [
      { name: "PROXY", type: "select", proxies: ["AUTO", ...names, "DIRECT"] },
      {
        name: "AUTO",
        type: "url-test",
        url: "https://www.gstatic.com/generate_204",
        interval: 300,
        tolerance: 50,
        proxies: names.length ? names : ["DIRECT"],
      },
    ],
    rules: [names.length ? "MATCH,PROXY" : "MATCH,DIRECT"],
  };
  return yaml.dump(cfg, { lineWidth: -1 });
}
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `cd packages/server && pnpm vitest run src/modules/nodes/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/nodes/config.ts packages/server/src/modules/nodes/config.test.ts
git commit -m "feat(server): mihomo config generation (buildConfig + deterministic dedupe) + tests"
```

---

### Task 8: nodes service (collect / apply / list / delay / select)

**Files:**
- Create: `packages/server/src/modules/nodes/service.ts`
- Test: `packages/server/src/modules/nodes/service.test.ts`

`collectProxies` gathers snapshots from **enabled** sources ordered by `sortOrder, id`. `applyConfig` writes the generated YAML to `configPath` and reloads mihomo via the client. `listNodes` normalizes the mihomo PROXY group into the shared `NodeView` (delay = last history entry, else null). `testDelay`/`selectNode` delegate to the client.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/modules/nodes/service.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import { applyConfig, collectProxies, listNodes } from "./service.js";

function freshDb() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  return db;
}
const proxy = (name: string) => ({ name, type: "vless", server: "ex.com", port: 443, uuid: "u" });
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

afterEach(() => vi.unstubAllGlobals());

describe("collectProxies", () => {
  it("gathers enabled sources by sortOrder and skips disabled ones", () => {
    const db = freshDb();
    db.insert(sources).values({ kind: "sub", value: "b", label: "b", sortOrder: 1, proxies: [proxy("B")] }).run();
    db.insert(sources).values({ kind: "sub", value: "a", label: "a", sortOrder: 0, proxies: [proxy("A")] }).run();
    db.insert(sources).values({ kind: "sub", value: "d", label: "d", sortOrder: 2, enabled: false, proxies: [proxy("D")] }).run();
    expect(collectProxies(db).map((p) => p.name)).toEqual(["A", "B"]);
  });
});

describe("applyConfig", () => {
  it("writes the generated config and reloads mihomo", async () => {
    const db = freshDb();
    db.insert(sources).values({ kind: "sub", value: "a", label: "a", proxies: [proxy("A")] }).run();
    const configPath = join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
    let reloaded = false;
    vi.stubGlobal("fetch", vi.fn((url: string) => { if (String(url).includes("/configs")) reloaded = true; return new Response(null, { status: 204 }); }));
    const res = await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    expect(res.nodes).toBe(1);
    expect(reloaded).toBe(true);
    const cfg = yaml.load(readFileSync(configPath, "utf8")) as any;
    expect(cfg.proxies[0].name).toBe("A");
  });
});

describe("listNodes", () => {
  it("normalizes the PROXY group into a NodeView with delays", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      json({
        proxies: {
          PROXY: { name: "PROXY", type: "Selector", now: "A", all: ["A", "B"], history: [] },
          A: { name: "A", type: "vless", udp: true, history: [{ time: "t", delay: 50 }] },
          B: { name: "B", type: "vless", history: [] },
        },
      }),
    ));
    const view = await listNodes();
    expect(view.now).toBe("A");
    expect(view.all).toEqual([
      { name: "A", type: "vless", delay: 50, udp: true },
      { name: "B", type: "vless", delay: null },
    ]);
  });

  it("returns an empty view when there is no PROXY group", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ proxies: {} })));
    const view = await listNodes();
    expect(view).toEqual({ now: null, all: [] });
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `cd packages/server && pnpm vitest run src/modules/nodes/service.test.ts`
Expected: FAIL — `./service.js` does not exist.

- [ ] **Step 3: Implement the service**

Create `packages/server/src/modules/nodes/service.ts`:

```ts
import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { NodeItem, NodeView, Proxy } from "@submerge/shared";
import { asc } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { env } from "../../config/env.js";
import { getDelay, getProxies, reloadConfig, selectProxy } from "../../clients/mihomo.js";
import type { Db } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import { buildConfig } from "./config.js";

// Gather proxy snapshots from enabled sources, ordered by sortOrder then id.
export function collectProxies(db: Db): Proxy[] {
  const rows = db.select().from(sources).where(eq(sources.enabled, true)).orderBy(asc(sources.sortOrder), asc(sources.id)).all();
  return rows.flatMap((r) => r.proxies as Proxy[]);
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
  if (!group || !group.all) return { now: null, all: [] };
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
```

> **Note:** merge the two `node:fs` imports and two `drizzle-orm` imports into single import statements to satisfy Biome's import grouping. Shown separately above only for clarity.

- [ ] **Step 4: Run the test — confirm it passes**

Run: `cd packages/server && pnpm vitest run src/modules/nodes/service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/nodes/service.ts packages/server/src/modules/nodes/service.test.ts
git commit -m "feat(server): nodes service (collect/apply/list/delay/select) + tests"
```

---

### Task 9: sources service (CRUD + ingest + reload)

**Files:**
- Create: `packages/server/src/modules/sources/service.ts`
- Test: `packages/server/src/modules/sources/service.test.ts`

Stitches ingest + DB + config reload. `addSource` ingests, snapshots proxies, inserts at the end (max `sortOrder` + 1), then re-applies the config. `refreshSource` re-ingests using the stored `value`/`hwid`. `toggleSource`/`reorderSources`/`removeSource` mutate then re-apply. HWID is read from settings via `getOrCreateHwid`. All write paths call `applyConfig`, so tests stub `fetch` (used by both ingest fetches and the mihomo reload) and pass an explicit `configPath`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/modules/sources/service.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.js";
import { addSource, listSources, removeSource, reorderSources, toggleSource } from "./service.js";

function freshDb() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  return db;
}
const tmpConfig = () => join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
const hwidFile = () => join(mkdtempSync(join(tmpdir(), "submerge-")), "hwid.txt");

// Subscriptions resolve to one node; mihomo reload returns 204.
function stubNet(subBody = "proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n") {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      String(url).includes("9090") || String(url).includes("/configs")
        ? new Response(null, { status: 204 })
        : new Response(subBody, { status: 200 }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("sources service", () => {
  it("adds a vless source, snapshots its proxies, and lists it", async () => {
    const db = freshDb();
    stubNet();
    const src = await addSource(db, { value: "vless://u@ex.com:443?security=tls#NL", hwid: false }, tmpConfig(), hwidFile());
    expect(src.kind).toBe("vless");
    expect(src.label).toBe("NL");
    expect(src.proxies).toHaveLength(1);
    expect(src.sortOrder).toBe(0);
    const list = await listSources(db);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(src.id);
  });

  it("appends sources with increasing sortOrder", async () => {
    const db = freshDb();
    stubNet();
    const a = await addSource(db, { value: "vless://u@ex.com:443#A", hwid: false }, tmpConfig(), hwidFile());
    const b = await addSource(db, { value: "vless://u@ex.com:443#B", hwid: false }, tmpConfig(), hwidFile());
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);
  });

  it("toggles enabled and removes a source", async () => {
    const db = freshDb();
    stubNet();
    const src = await addSource(db, { value: "vless://u@ex.com:443#A", hwid: false }, tmpConfig(), hwidFile());
    const toggled = await toggleSource(db, src.id, tmpConfig());
    expect(toggled.enabled).toBe(false);
    await removeSource(db, src.id, tmpConfig());
    expect(await listSources(db)).toHaveLength(0);
  });

  it("reorders sources by id list", async () => {
    const db = freshDb();
    stubNet();
    const a = await addSource(db, { value: "vless://u@ex.com:443#A", hwid: false }, tmpConfig(), hwidFile());
    const b = await addSource(db, { value: "vless://u@ex.com:443#B", hwid: false }, tmpConfig(), hwidFile());
    await reorderSources(db, [b.id, a.id], tmpConfig());
    const list = await listSources(db);
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]); // listSources orders by sortOrder
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `cd packages/server && pnpm vitest run src/modules/sources/service.test.ts`
Expected: FAIL — `./service.js` does not exist.

- [ ] **Step 3: Implement the service**

Create `packages/server/src/modules/sources/service.ts`:

```ts
import type { AddSourceInput, Source } from "@submerge/shared";
import { asc, eq, sql } from "drizzle-orm";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import { applyConfig } from "../nodes/service.js";
import { getOrCreateHwid } from "../settings/service.js";
import { ingestSource } from "./ingest.js";

// Map a DB row to the shared Source shape (proxies already decoded by Drizzle json mode).
function toSource(row: typeof sources.$inferSelect): Source {
  return {
    id: row.id,
    kind: row.kind as Source["kind"],
    value: row.value,
    label: row.label,
    hwid: row.hwid,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    proxies: row.proxies,
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
): Promise<Source> {
  const hwid = input.hwid ? getOrCreateHwid(db, hwidFile) : "";
  const result = await ingestSource(input.value, input.hwid, hwid);
  const maxRow = db.select({ max: sql<number>`coalesce(max(${sources.sortOrder}), -1)` }).from(sources).get();
  const sortOrder = (maxRow?.max ?? -1) + 1;
  const row = db
    .insert(sources)
    .values({
      kind: result.kind,
      value: input.value,
      label: result.label,
      hwid: input.hwid,
      sortOrder,
      proxies: result.proxies,
    })
    .returning()
    .get();
  await applyConfig(db, configPath);
  return toSource(row);
}

export async function removeSource(db: Db, id: number, configPath: string = env.MIHOMO_CONFIG_PATH): Promise<void> {
  db.delete(sources).where(eq(sources.id, id)).run();
  await applyConfig(db, configPath);
}

export async function refreshSource(
  db: Db,
  id: number,
  configPath: string = env.MIHOMO_CONFIG_PATH,
  hwidFile: string = env.HWID_FILE,
): Promise<Source> {
  const row = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!row) throw new Error(`source ${id} not found`);
  const hwid = row.hwid ? getOrCreateHwid(db, hwidFile) : "";
  const result = await ingestSource(row.value, row.hwid, hwid);
  const updated = db
    .update(sources)
    .set({ label: result.label, proxies: result.proxies, updatedAt: sql`(current_timestamp)` })
    .where(eq(sources.id, id))
    .returning()
    .get();
  await applyConfig(db, configPath);
  return toSource(updated);
}

export async function toggleSource(db: Db, id: number, configPath: string = env.MIHOMO_CONFIG_PATH): Promise<Source> {
  const row = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!row) throw new Error(`source ${id} not found`);
  const updated = db.update(sources).set({ enabled: !row.enabled }).where(eq(sources.id, id)).returning().get();
  await applyConfig(db, configPath);
  return toSource(updated);
}

export async function reorderSources(db: Db, ids: number[], configPath: string = env.MIHOMO_CONFIG_PATH): Promise<void> {
  db.transaction((tx) => {
    ids.forEach((id, index) => {
      tx.update(sources).set({ sortOrder: index }).where(eq(sources.id, id)).run();
    });
  });
  await applyConfig(db, configPath);
}
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `cd packages/server && pnpm vitest run src/modules/sources/service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/sources/service.ts packages/server/src/modules/sources/service.test.ts
git commit -m "feat(server): sources service (CRUD + ingest + reload) + tests"
```

---

### Task 10: tRPC routers (sources / nodes / settings) + mount

**Files:**
- Create: `packages/server/src/modules/sources/router.ts`
- Create: `packages/server/src/modules/nodes/router.ts`
- Create: `packages/server/src/modules/settings/router.ts`
- Modify: `packages/server/src/trpc/router.ts`
- Test: `packages/server/src/trpc/router.test.ts` (extend)

Routers are thin: validate input with shared schemas, dispatch to services with the singleton `db`. The procedures use the production `db` and default config paths, so the router test stubs `fetch` to exercise the full chain through a `createCaller`.

- [ ] **Step 1: Create the sources router**

Create `packages/server/src/modules/sources/router.ts`:

```ts
import { addSourceInput, idInput, reorderInput } from "@submerge/shared";
import { db } from "../../db/client.js";
import { publicProcedure, router } from "../../trpc/trpc.js";
import { addSource, listSources, refreshSource, removeSource, reorderSources, toggleSource } from "./service.js";

export const sourcesRouter = router({
  list: publicProcedure.query(() => listSources(db)),
  add: publicProcedure.input(addSourceInput).mutation(({ input }) => addSource(db, input)),
  remove: publicProcedure.input(idInput).mutation(({ input }) => removeSource(db, input.id)),
  refresh: publicProcedure.input(idInput).mutation(({ input }) => refreshSource(db, input.id)),
  toggle: publicProcedure.input(idInput).mutation(({ input }) => toggleSource(db, input.id)),
  reorder: publicProcedure.input(reorderInput).mutation(({ input }) => reorderSources(db, input.ids)),
});
```

- [ ] **Step 2: Create the nodes router**

Create `packages/server/src/modules/nodes/router.ts`:

```ts
import { delayInput, selectNodeInput } from "@submerge/shared";
import { publicProcedure, router } from "../../trpc/trpc.js";
import { listNodes, selectNode, testDelay } from "./service.js";

export const nodesRouter = router({
  list: publicProcedure.query(() => listNodes()),
  delay: publicProcedure.input(delayInput).mutation(({ input }) => testDelay(input.name)),
  select: publicProcedure.input(selectNodeInput).mutation(({ input }) => selectNode(input.group, input.name)),
});
```

- [ ] **Step 3: Create the settings router**

Create `packages/server/src/modules/settings/router.ts`:

```ts
import { setSettingInput } from "@submerge/shared";
import { db } from "../../db/client.js";
import { publicProcedure, router } from "../../trpc/trpc.js";
import { getAllSettings, setSetting } from "./service.js";

export const settingsRouter = router({
  get: publicProcedure.query(() => getAllSettings(db)),
  set: publicProcedure.input(setSettingInput).mutation(({ input }) => {
    setSetting(db, input.key, input.value);
    return { ok: true as const };
  }),
});
```

- [ ] **Step 4: Mount the routers**

Replace `packages/server/src/trpc/router.ts` with:

```ts
import { nodesRouter } from "../modules/nodes/router.js";
import { settingsRouter } from "../modules/sources/../nodes/../settings/router.js";
import { sourcesRouter } from "../modules/sources/router.js";
import { publicProcedure, router } from "./trpc.js";

export const appRouter = router({
  health: router({
    // Returns ok + current server version — used as a liveness check
    ping: publicProcedure.query(() => ({ ok: true, version: "0.2.0" })),
  }),
  sources: sourcesRouter,
  nodes: nodesRouter,
  settings: settingsRouter,
});

// Re-exported for the web package (Phase 3)
export type AppRouter = typeof appRouter;
```

> Fix the messy `settings` import path to the clean form `import { settingsRouter } from "../modules/settings/router.js";` — the line above is intentionally wrong so you verify the import resolves; Biome's organize-imports will also flag it.

- [ ] **Step 5: Extend the router test**

Replace `packages/server/src/trpc/router.test.ts` with:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "./router.js";
import { createCallerFactory } from "./trpc.js";

const createCaller = createCallerFactory(appRouter);
const caller = () => createCaller({ authed: true });

afterEach(() => vi.unstubAllGlobals());

describe("appRouter", () => {
  it("health.ping returns ok", async () => {
    const res = await caller().health.ping();
    expect(res.ok).toBe(true);
    expect(typeof res.version).toBe("string");
  });

  it("nodes.list normalizes mihomo proxies", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      new Response(JSON.stringify({ proxies: { PROXY: { name: "PROXY", type: "Selector", now: "A", all: ["A"], history: [] }, A: { name: "A", type: "vless", history: [] } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));
    const view = await caller().nodes.list();
    expect(view.now).toBe("A");
    expect(view.all[0]?.name).toBe("A");
  });

  it("settings.set then settings.get round-trips", async () => {
    await caller().settings.set({ key: "theme", value: "dark" });
    const all = await caller().settings.get();
    expect(all.theme).toBe("dark");
  });
});
```

> **Note:** `settings.*` and `sources.*` procedures use the singleton `db` (a file at `env.DB_PATH`). The test writes a real row; that is acceptable for an integration smoke check. If you prefer isolation, the existing module-level tests (Tasks 5/8/9) already cover the in-memory paths — this test only verifies the routers wire up and types flow end-to-end.

- [ ] **Step 6: Run the router test — confirm it passes**

Run: `cd packages/server && pnpm vitest run src/trpc/router.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/modules/sources/router.ts packages/server/src/modules/nodes/router.ts \
        packages/server/src/modules/settings/router.ts packages/server/src/trpc/router.ts \
        packages/server/src/trpc/router.test.ts
git commit -m "feat(server): tRPC routers (sources/nodes/settings) mounted on appRouter + tests"
```

---

### Task 11: Phase gate — full suite, lint, typecheck

**Files:** none (verification + cleanup only)

- [ ] **Step 1: Run the full test suite**

Run: `cd ~/Developer/submerge && pnpm test`
Expected: all Vitest tests pass (shared + server: parsers, clients, settings, ingest, config, nodes, sources, router).

- [ ] **Step 2: Typecheck the whole workspace**

Run: `pnpm typecheck`
Expected: `tsc -b` clean — no type errors across shared + server.

- [ ] **Step 3: Lint + format check**

Run: `pnpm lint`
Expected: Biome reports no errors. If formatting differs, run `pnpm format` and re-commit.

- [ ] **Step 4: Clean up the test-created DB artifact (if any)**

Run: `git status --short`
Expected: no stray `data/*.db` staged (they are git-ignored per AGENTS.md). If the router test created `packages/server/data/submerge.db`, confirm it is ignored.

- [ ] **Step 5: Final commit (if format changed anything)**

```bash
git add -A
git commit -m "chore(server): phase 2 gate — lint/format/typecheck green" || echo "nothing to commit"
```

---

## Self-Review (performed while writing)

- **Spec coverage (Phase 2, spec §6/§8):**
  - `detectKind`, `extractSubUrl`, `parseVless`, `parseProxiesFromText` (clash-yaml/v2ray-vnext/sing-box/base64) → Task 2 ✓
  - `fetchSubscription` (per-source X-Hwid + X-Device-Os) → Task 6 ✓
  - `ingestHapp` via happ-decoder `POST /decode {link,hwid}` → Tasks 4 + 6 ✓
  - mihomo client reload/proxies/select/delay → Task 3 ✓
  - config.yaml generation (mixed-port, PROXY select + AUTO url-test, rules) + reload → Tasks 7 + 8 ✓
  - tRPC routers `sources` (list/add/remove/refresh/toggle/reorder), `nodes` (list/delay/select), `settings` (get/set) → Task 10 ✓
  - shared Zod schemas for proxy/source/settings/nodeview → Tasks 1 (existing proxy/source from Phase 1) ✓
  - External responses `.parse()`d (mihomo, happ-decoder) → Tasks 3, 4 ✓
  - HWID per-source, off by default, stable shared value (ADR-0002) → Tasks 5, 6 ✓
- **Out of scope (correctly deferred):** real-time SSE/`live` subscription → Phase 4; auth middleware → Phase 5; RU-direct routing + deploy wiring of HWID_FILE/config volume → Phase 6.
- **Placeholder scan:** every code step contains full code; no TODO/TBD. Two deliberately-wrong lines (Task 2 `any` lint note, Task 10 settings import path) are flagged inline with the fix — they are verification prompts, not placeholders.
- **Type consistency:** `IngestResult {kind,label,proxies}` (Task 6) consumed by `addSource`/`refreshSource` (Task 9); `NodeView`/`NodeItem` (Task 1) produced by `listNodes` (Task 8) and returned by `nodes.list` (Task 10); `applyConfig(db, configPath?, targetPath?)` signature consistent across Tasks 8/9; `getOrCreateHwid(db, file?)` consistent across Tasks 5/9; client function names (`getProxies/getDelay/selectProxy/reloadConfig`, `decodeHapp`) consistent across Tasks 3/4/6/8.
- **DRY/YAGNI:** parsers and config are pure and shared; services own Drizzle directly (no repositories); no DI container (db/path params only).

## Execution note

happ-decoder/mihomo are not contacted by the unit tests (all `fetch` is stubbed), so this phase is fully testable without Docker. A live end-to-end smoke (real mihomo + happ-decoder) belongs to Phase 6 when compose switches to the new server.
