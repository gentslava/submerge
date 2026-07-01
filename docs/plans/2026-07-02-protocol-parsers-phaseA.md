# Non-vless protocol parsers — Phase A implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest hysteria2/vmess/trojan/ss/tuic nodes from single links and v2ray/sing-box JSON, stop dropping non-vless nodes silently, and label QUIC transports correctly.

**Architecture:** All work is in the server ingest layer (`packages/server/src/modules/sources/parse.ts` + `ingest.ts`), plus a small web badge tweak. A single `SINGLE_LINK` dispatch table (scheme → {kind, parser}) drives both `detectKind` and `parseSingleLink`; JSON converters gain per-protocol branches; `parseProxiesFromText` returns a `{proxies, skipped}` shape so the UI can report unsupported nodes. No registry/DI (ADR-0004) — plain functions + a dispatch object.

**Tech Stack:** Node 24, strict TypeScript (ESM, `nodenext`), Zod 4, Vitest, Biome. Run server tests with `pnpm -F @submerge/server test`, web with `pnpm -F @submerge/web test`. Gate before every commit: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`.

**Spec:** [docs/specs/2026-07-02-protocol-parsers-design.md](../specs/2026-07-02-protocol-parsers-design.md)

---

## File structure

- `packages/shared/src/schemas.ts` — `sourceKindSchema` gains protocol literals (no migration).
- `packages/server/src/modules/sources/parse.ts` — `schemeOf`, `SINGLE_LINK` table, `parseSingleLink`, per-protocol parsers (`parseHysteria2`, `parseTrojan`, `parseVmess`, `parseShadowsocks`, `parseTuic`), JSON dispatch branches, `parseProxiesFromText` `{proxies, skipped}` return.
- `packages/server/src/modules/sources/ingest.ts` — `IngestResult.skipped`, `SINGLE_LINK_KINDS` dispatch.
- `packages/server/src/modules/sources/service.ts` + `router.ts` — thread `skipped` to the add-source result.
- `packages/web/src/features/nodes/nodeView.ts` — protocol-aware transport default (QUIC).
- `packages/web` add-source flow — skipped toast; per-kind labels.

Conventions: each new proxy is built as `Record<string, unknown>` then returned `as ProxyConfig` (matches `parseVless`). Query values are read via `URL`/`URLSearchParams`. `udp: true` is set on proxies that support it (all here except ss). Comments/commit messages in English.

---

## Task 1: Single-link dispatch scaffold (behavior-preserving refactor)

Introduce the `SINGLE_LINK` table and `parseSingleLink`, and route single-link ingestion through them. Only `vless` is wired; every other single-node scheme keeps throwing its informative error. No behavior change.

**Files:**
- Modify: `packages/shared/src/schemas.ts` (`sourceKindSchema`)
- Modify: `packages/server/src/modules/sources/parse.ts`
- Modify: `packages/server/src/modules/sources/ingest.ts:161-165`
- Test: `packages/server/src/modules/sources/parse.test.ts`

- [ ] **Step 0: Add all protocol literals to `sourceKindSchema`**

Do this first so `SINGLE_LINK_KINDS` (Step 5) type-checks. In `schemas.ts`, change:

```ts
export const sourceKindSchema = z.enum(["sub", "vless", "happ"]);
```
to
```ts
export const sourceKindSchema = z.enum([
  "sub",
  "happ",
  "vless",
  "hysteria2",
  "vmess",
  "trojan",
  "ss",
  "tuic",
]);
```

Existing `kind='vless'` rows stay valid → **no DB migration**. `detectKind` won't
*return* the new literals until each protocol's slice registers its parser, so
adding them now is inert.

- [ ] **Step 1: Write the failing test**

Add to `parse.test.ts`:

```ts
import { detectKind, parseSingleLink } from "./parse.js";

describe("parseSingleLink", () => {
  it("dispatches vless:// to parseVless", () => {
    const p = parseSingleLink("vless://uuid@ex.com:443?type=tcp#N");
    expect(p.type).toBe("vless");
    expect(p.server).toBe("ex.com");
  });
  it("rejects an unsupported single-node scheme", () => {
    expect(() => parseSingleLink("ssr://whatever")).toThrow(/unsupported/i);
  });
});

describe("detectKind single links", () => {
  it("detects vless", () => expect(detectKind("vless://u@h:443")).toBe("vless"));
  it("still rejects not-yet-supported single links with a clear message", () => {
    expect(() => detectKind("trojan://p@h:443")).toThrow(/not supported yet|subscription/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @submerge/server test -- parse.test.ts`
Expected: FAIL — `parseSingleLink` is not exported.

- [ ] **Step 3: Add the dispatch table + `schemeOf` + `parseSingleLink`**

In `parse.ts`, after `parseVless` (around line 104), add:

```ts
// Return the URL scheme with its colon ("vless:") for a scheme://… string, else null.
function schemeOf(value: string): string | null {
  const m = value.match(/^([a-z][a-z0-9.+-]*):\/\//i);
  return m ? `${(m[1] as string).toLowerCase()}:` : null;
}

// Single-node link schemes we can parse → { source kind stored, parser }. The kind
// IS the protocol (personalized). Grows one entry per protocol slice. `hy2:` is an
// alias registered alongside `hysteria2:` in the hysteria2 slice.
const SINGLE_LINK: Record<string, { kind: SourceKind; parse: (uri: string) => ProxyConfig }> = {
  "vless:": { kind: "vless", parse: parseVless },
};

// Single-node schemes we recognize but don't support yet (ssr never). Shrinks as
// slices move a scheme into SINGLE_LINK. Kept only for a helpful detectKind error.
const UNSUPPORTED_SINGLE = new Set([
  "vmess:",
  "trojan:",
  "ss:",
  "ssr:",
  "hysteria:",
  "hysteria2:",
  "hy2:",
  "tuic:",
]);

// Dispatch a single-node link to its protocol parser.
export function parseSingleLink(uri: string): ProxyConfig {
  const scheme = schemeOf(uri.trim());
  const entry = scheme ? SINGLE_LINK[scheme] : undefined;
  if (!entry) throw new Error(`unsupported single-node link: ${scheme ?? uri.slice(0, 12)}`);
  return entry.parse(uri);
}
```

- [ ] **Step 4: Rewrite `detectKind` to use the table**

Replace the body of `detectKind` (lines 34-54) with:

```ts
export function detectKind(value: string): SourceKind {
  const v = (value || "").trim();
  if (!v) throw new Error("empty string");
  const scheme = schemeOf(v);
  if (scheme && SINGLE_LINK[scheme]) return SINGLE_LINK[scheme].kind; // supported single link
  if (/^happ:\/\/crypt/i.test(v)) return "happ"; // encrypted happ → decoder
  if (scheme && UNSUPPORTED_SINGLE.has(scheme))
    throw new Error(
      `single ${scheme.slice(0, -1)} links aren't supported yet — use a subscription instead`,
    );
  if (extractSubUrl(v)) return "sub"; // url or client deep-link
  if (/^happ:\/\//i.test(v)) return "happ"; // happ:// without an embedded url → decoder
  try {
    const d = Buffer.from(v.replace(/\s+/g, ""), "base64").toString("utf8");
    if (d.includes("://")) return "sub"; // base64 subscription pasted directly
  } catch {
    /* base64 decode never throws in Node; the :// check filters non-subscription input */
  }
  throw new Error(
    "could not detect kind: expected a single-node link, happ:// , a subscription URL, or a client deep-link",
  );
}
```

- [ ] **Step 5: Route ingest through `parseSingleLink`**

In `ingest.ts`, replace lines 162-165:

```ts
  if (kind === "vless") {
    const proxy = parseVless(value);
    return { kind, label: proxy.name, proxies: [proxy], meta: null };
  }
```

with a single-link branch (add `SINGLE_LINK_KINDS` near the top of `ingest.ts`, after the imports):

```ts
// Kinds whose `value` is one single-node link (vs. a subscription/happ source).
const SINGLE_LINK_KINDS = new Set<SourceKind>(["vless", "hysteria2", "vmess", "trojan", "ss", "tuic"]);
```

```ts
  if (SINGLE_LINK_KINDS.has(kind)) {
    const proxy = parseSingleLink(value);
    return { kind, label: proxy.name, proxies: [proxy], meta: null };
  }
```

Update the `ingest.ts` import to add `parseSingleLink`:

```ts
import { detectKind, extractSubUrl, parseProxiesFromText, parseSingleLink } from "./parse.js";
```

(`parseVless` is no longer referenced directly in `ingest.ts` — remove it from the import to satisfy Biome's no-unused rule.)

- [ ] **Step 6: Run tests + gates**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`
Expected: PASS (all existing tests + the two new ones). Full `pnpm typecheck` (not the per-package one) because `sourceKindSchema` changed in `packages/shared` — `tsc -b` rebuilds shared for the server/web to see the new literals.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/schemas.ts packages/server/src/modules/sources/parse.ts packages/server/src/modules/sources/ingest.ts packages/server/src/modules/sources/parse.test.ts
git commit -m "refactor(sources): per-protocol kinds + single-link dispatch table

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Surface a skipped-node count (`parseProxiesFromText` → {proxies, skipped})

Change the parse return shape so unsupported nodes are counted, thread it through ingest → service → router, and toast it on manual add.

**Files:**
- Modify: `packages/server/src/modules/sources/parse.ts:177-225`
- Modify: `packages/server/src/modules/sources/ingest.ts` (3 call sites + `IngestResult`)
- Modify: `packages/server/src/modules/sources/service.ts`, `router.ts`
- Modify: `packages/web` add-source mutation handler
- Test: `parse.test.ts`, `ingest.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `parse.test.ts`:

```ts
import { parseProxiesFromText } from "./parse.js";

describe("parseProxiesFromText skipped", () => {
  it("returns parsed proxies and a deduped list of skipped schemes", () => {
    const body = "vless://u@ex.com:443#A\nssr://xxx\nssr://yyy\n";
    const { proxies, skipped } = parseProxiesFromText(body);
    expect(proxies.map((p) => p.name)).toEqual(["A"]);
    expect(skipped).toEqual(["ssr"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @submerge/server test -- parse.test.ts`
Expected: FAIL — `parseProxiesFromText` returns an array, `.proxies`/`.skipped` are undefined.

- [ ] **Step 3: Change `parseProxiesFromText` to return `{proxies, skipped}`**

Add the result type above the function and rewrite it (keep the three-branch structure; clash-yaml has no skips, JSON/list branches record unsupported schemes/types):

```ts
export interface ParsedProxies {
  proxies: ProxyConfig[];
  skipped: string[]; // deduped unsupported protocol/scheme names (e.g. ["ssr"])
}

export function parseProxiesFromText(text: string): ParsedProxies {
  // 1) clash/mihomo yaml — pass-through, no skips
  try {
    const doc = yaml.load(text) as { proxies?: unknown[] } | undefined;
    if (doc && Array.isArray(doc.proxies) && doc.proxies.length)
      return { proxies: doc.proxies as ProxyConfig[], skipped: [] };
  } catch {
    /* not yaml */
  }

  const skipped = new Set<string>();

  // 2) v2ray/xray or sing-box JSON outbounds
  try {
    const j = JSON.parse(text);
    // biome-ignore lint/suspicious/noExplicitAny: external untyped JSON
    const profiles: any[] | null = Array.isArray(j) ? j : j.outbounds ? [j] : null;
    if (profiles) {
      const out: ProxyConfig[] = [];
      for (const prof of profiles)
        for (const ob of prof.outbounds || []) {
          const p = v2rayOutboundToMihomo(ob, prof.remarks) || singBoxOutboundToMihomo(ob);
          if (p) out.push(p);
          else {
            const t = ob?.protocol || ob?.type;
            if (t && !["freedom", "blackhole", "direct", "dns", "block"].includes(t)) skipped.add(String(t));
          }
        }
      if (out.length || skipped.size) return { proxies: out, skipped: [...skipped] };
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
    /* base64 decode never throws in Node; the :// check filters non-subscription input */
  }
  const out: ProxyConfig[] = [];
  for (const line of decoded.split(/\r?\n/)) {
    const s = line.trim();
    const scheme = schemeOf(s);
    if (!scheme) continue;
    if (SINGLE_LINK[scheme]) {
      try {
        out.push(SINGLE_LINK[scheme].parse(s));
      } catch {
        /* skip malformed line */
      }
    } else {
      skipped.add(scheme.slice(0, -1)); // "ssr:" → "ssr"
    }
  }
  return { proxies: out, skipped: [...skipped] };
}
```

- [ ] **Step 4: Update the three `ingest.ts` call sites + `IngestResult`**

`IngestResult` (line 5) gains `skipped`:

```ts
export interface IngestResult {
  kind: SourceKind;
  label: string;
  proxies: ProxyConfig[];
  meta: SubscriptionMeta | null;
  skipped: string[]; // unsupported protocols dropped during parse (manual-add notice)
}
```

`fetchSubscription` (line ~113) — change:

```ts
  const proxies = parseProxiesFromText(await res.text());
```
to
```ts
  const { proxies, skipped } = parseProxiesFromText(await res.text());
```
and return `skipped` from it (add `skipped` to its return object and to `SubResult`/whatever type it uses; if it returns `{ proxies, info }`, make it `{ proxies, info, skipped }`).

`ingestHapp` (line ~127) — change:

```ts
  let proxies = decoded.body ? parseProxiesFromText(decoded.body) : [];
```
to
```ts
  const parsed = decoded.body ? parseProxiesFromText(decoded.body) : { proxies: [], skipped: [] };
  let proxies = parsed.proxies;
```
and include `parsed.skipped` in `ingestHapp`'s returned object.

`ingestSource` — set `skipped` on every returned `IngestResult`:
- single-link branch: `skipped: []`
- `sub` (URL): `skipped` from `fetchSubscription`
- `sub` (inline): `const { proxies, skipped } = parseProxiesFromText(value);` then `skipped`
- `happ`: `skipped` from `ingestHapp`

- [ ] **Step 5: Thread `skipped` to the tRPC add-source result**

In `service.ts` `add(...)`, find the current return value (whatever it returns for
the created source — a `Source` object or the inserted row mapped to one) and wrap
it with the skipped list, keeping the existing source payload under `source`:

```ts
  // was: return <theCreatedSource>;
  return { source: <theCreatedSource>, skipped: result.skipped };
```

The router's `add` return type is inferred through tRPC, so no shared schema edit
is needed — but the web caller now reads `data.source` instead of `data` (Step 6).
If any other caller of `service.add` exists (grep `\.add(` in `packages/server`),
update it to read `.source`.

- [ ] **Step 6: Toast skipped on manual add (web)**

In the web add-source mutation `onSuccess` (search `useMutation` around the sources add form, e.g. `packages/web/src/features/sources/…`), read `data.skipped` and toast when non-empty:

```ts
onSuccess: (data) => {
  if (data.skipped?.length) {
    toast.warning(`Пропущено ${data.skipped.length}: неподдерживаемые протоколы (${data.skipped.join(", ")})`);
  }
  // …existing success handling (uses data.source now)…
},
```

- [ ] **Step 7: Update existing tests that call `parseProxiesFromText`**

In `parse.test.ts` and `ingest.test.ts`, any existing `parseProxiesFromText(x)` used as an array must become `parseProxiesFromText(x).proxies`. Grep: `grep -rn "parseProxiesFromText" packages/server/src` and fix each assertion.

- [ ] **Step 8: Run gates**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(sources): surface skipped unsupported nodes on manual add

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: hysteria2 (URI + sing-box JSON + kind + QUIC badge)

**Files:**
- Modify: `packages/server/src/modules/sources/parse.ts` (`parseHysteria2`, `SINGLE_LINK`, `UNSUPPORTED_SINGLE`, `singBoxOutboundToMihomo`)
- Modify: `packages/web/src/features/nodes/nodeView.ts` (`transportBadge`)
- Test: `parse.test.ts`, `packages/web/src/features/nodes/nodeView.test.ts`

(The `hysteria2` enum literal was already added in Task 1 Step 0.)

- [ ] **Step 2: Write the failing test (URI + JSON)**

Add to `parse.test.ts`:

```ts
import { detectKind, parseHysteria2, parseProxiesFromText, parseSingleLink } from "./parse.js";

describe("parseHysteria2", () => {
  it("maps a hysteria2:// URI to a mihomo proxy", () => {
    const p = parseHysteria2(
      "hysteria2://pass@ex.com:443/?sni=real.ex.com&obfs=salamander&obfs-password=ob&insecure=1#DE",
    );
    expect(p).toMatchObject({
      name: "DE",
      type: "hysteria2",
      server: "ex.com",
      port: 443,
      password: "pass",
      sni: "real.ex.com",
      obfs: "salamander",
      "obfs-password": "ob",
      "skip-cert-verify": true,
    });
  });
  it("accepts the hy2:// alias and defaults the name to host:port", () => {
    const p = parseHysteria2("hy2://pw@ex.com:8443");
    expect(p.type).toBe("hysteria2");
    expect(p.name).toBe("ex.com:8443");
  });
  it("is reachable via detectKind + parseSingleLink", () => {
    expect(detectKind("hysteria2://pw@ex.com:443")).toBe("hysteria2");
    expect(parseSingleLink("hy2://pw@ex.com:443").type).toBe("hysteria2");
  });
  it("maps a sing-box hysteria2 outbound", () => {
    const { proxies } = parseProxiesFromText(
      JSON.stringify({
        outbounds: [
          {
            type: "hysteria2",
            tag: "HY",
            server: "ex.com",
            server_port: 443,
            password: "pw",
            obfs: { type: "salamander", password: "ob" },
            tls: { server_name: "ex.com", insecure: false },
          },
        ],
      }),
    );
    expect(proxies[0]).toMatchObject({ type: "hysteria2", server: "ex.com", port: 443, password: "pw", obfs: "salamander" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -F @submerge/server test -- parse.test.ts`
Expected: FAIL — `parseHysteria2` not exported; sing-box branch returns null.

- [ ] **Step 4: Implement `parseHysteria2` + register it**

In `parse.ts`, after `parseVless`:

```ts
// ── hysteria2:// (and hy2://) → mihomo proxy ────────────────────────
export function parseHysteria2(uri: string): ProxyConfig {
  const raw = uri.trim();
  // Port hopping "host:port,<ranges>" — URL() rejects the comma, so pull ranges out first.
  let ports: string | undefined;
  const cleaned = raw.replace(/(:\d+),([\d,-]+)/, (_m, port: string, ranges: string) => {
    ports = ranges;
    return port;
  });
  const u = new URL(cleaned);
  if (u.protocol !== "hysteria2:" && u.protocol !== "hy2:") throw new Error("not a hysteria2:// link");
  const q = u.searchParams;
  const server = u.hostname;
  const port = Number(u.port) || 443;
  // auth: "pass" or "user:pass" (password is the meaningful half); URL puts it in username/password.
  const password = decodeURIComponent(u.password || u.username || "");
  const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : `${server}:${port}`;
  const p: Record<string, unknown> = {
    name,
    type: "hysteria2",
    server,
    port,
    password,
    udp: true,
  };
  const sni = q.get("sni");
  if (sni) p.sni = sni;
  if (q.get("insecure") === "1") p["skip-cert-verify"] = true;
  const obfs = q.get("obfs");
  if (obfs) {
    p.obfs = obfs;
    const op = q.get("obfs-password");
    if (op) p["obfs-password"] = op;
  }
  if (ports) p.ports = ports;
  return p as ProxyConfig;
}
```

Register it in `SINGLE_LINK` and remove its schemes from `UNSUPPORTED_SINGLE`:

```ts
const SINGLE_LINK: Record<string, { kind: SourceKind; parse: (uri: string) => ProxyConfig }> = {
  "vless:": { kind: "vless", parse: parseVless },
  "hysteria2:": { kind: "hysteria2", parse: parseHysteria2 },
  "hy2:": { kind: "hysteria2", parse: parseHysteria2 },
};

const UNSUPPORTED_SINGLE = new Set(["vmess:", "trojan:", "ss:", "ssr:", "hysteria:", "tuic:"]);
```

- [ ] **Step 5: Add the hysteria2 branch to `singBoxOutboundToMihomo`**

In `singBoxOutboundToMihomo`, before the `if (ob?.type !== "vless" …)` guard, add:

```ts
  if (ob?.type === "hysteria2" && ob.server) {
    const p: Record<string, unknown> = {
      name: ob.tag || `${ob.server}:${ob.server_port}`,
      type: "hysteria2",
      server: ob.server,
      port: Number(ob.server_port),
      password: ob.password,
      udp: true,
    };
    if (ob.obfs?.type) {
      p.obfs = ob.obfs.type;
      if (ob.obfs.password) p["obfs-password"] = ob.obfs.password;
    }
    if (ob.tls?.server_name) p.sni = ob.tls.server_name;
    if (ob.tls?.insecure) p["skip-cert-verify"] = true;
    return p as ProxyConfig;
  }
```

- [ ] **Step 6: Make the transport badge protocol-aware (QUIC)**

In `packages/web/src/features/nodes/nodeView.ts`, replace `transportBadge`:

```ts
// QUIC-family proxy types have no tcp/tls transport — their transport is QUIC.
const QUIC_TYPES = new Set(["hysteria", "hysteria2", "tuic"]);

// Transport badge for a real node (uppercased: TCP/WS/GRPC/…). `node.network` wins;
// otherwise QUIC for QUIC-family types, TCP for the tcp family. null when neither
// transport nor a real-node signal is known (e.g. a group).
export function transportBadge(node: NodeItem): string | null {
  if (node.network) return node.network.toUpperCase();
  if (node.type && QUIC_TYPES.has(node.type.toLowerCase())) return "QUIC";
  if (node.security) return "TCP";
  return null;
}
```

Add web tests to `nodeView.test.ts` inside the transport describe block:

```ts
    expect(transportBadge({ ...node("x"), type: "hysteria2" })).toBe("QUIC");
    expect(transportBadge({ ...node("x"), type: "Tuic" })).toBe("QUIC");
    expect(transportBadge({ ...node("x"), type: "hysteria2", network: "ws" })).toBe("WS"); // network wins
```

- [ ] **Step 7: Run gates**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(sources): hysteria2 single-link + sing-box JSON ingest, QUIC badge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: trojan

**Files:** `parse.ts` (`parseTrojan`, `SINGLE_LINK`, `UNSUPPORTED_SINGLE`, `singBoxOutboundToMihomo`), `parse.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { parseTrojan } from "./parse.js";

describe("parseTrojan", () => {
  it("maps trojan://pass@host:port?sni=&type= to a mihomo proxy", () => {
    const p = parseTrojan("trojan://secret@ex.com:443?sni=ex.com&type=tcp#TR");
    expect(p).toMatchObject({
      name: "TR",
      type: "trojan",
      server: "ex.com",
      port: 443,
      password: "secret",
      sni: "ex.com",
      network: "tcp",
    });
  });
  it("is reachable via detectKind", () => {
    expect(detectKind("trojan://p@ex.com:443")).toBe("trojan");
  });
});
```

- [ ] **Step 2: Run test → FAIL** (`parseTrojan` not exported).

Run: `pnpm -F @submerge/server test -- parse.test.ts`

- [ ] **Step 3: Implement `parseTrojan` + register**

```ts
// ── trojan:// → mihomo proxy ────────────────────────────────────────
export function parseTrojan(uri: string): ProxyConfig {
  const u = new URL(uri.trim());
  if (u.protocol !== "trojan:") throw new Error("not a trojan:// link");
  const q = u.searchParams;
  const server = u.hostname;
  const port = Number(u.port) || 443;
  const password = decodeURIComponent(u.username || "");
  const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : `${server}:${port}`;
  const net = q.get("type") || "tcp";
  const p: Record<string, unknown> = {
    name,
    type: "trojan",
    server,
    port,
    password,
    udp: true,
    network: net === "h2" ? "http" : net,
  };
  const sni = q.get("sni") || q.get("host");
  if (sni) p.sni = sni;
  if (q.get("allowInsecure") === "1") p["skip-cert-verify"] = true;
  const fp = q.get("fp");
  if (fp) p["client-fingerprint"] = fp;
  if (net === "ws")
    p["ws-opts"] = {
      path: q.get("path") ? decodeURIComponent(q.get("path") as string) : "/",
      headers: { Host: q.get("host") || sni || server },
    };
  else if (net === "grpc")
    p["grpc-opts"] = { "grpc-service-name": q.get("serviceName") || "" };
  return p as ProxyConfig;
}
```

Register: add `"trojan:": { kind: "trojan", parse: parseTrojan }` to `SINGLE_LINK`; remove `"trojan:"` from `UNSUPPORTED_SINGLE`.

- [ ] **Step 4: Add trojan branch to the JSON converters**

In `v2rayOutboundToMihomo`, change the top guard so trojan is mapped. Replace `if (ob?.protocol !== "vless") return null;` with a dispatch: keep the existing vless body under `if (ob?.protocol === "vless") { … }`, then add:

```ts
  if (ob?.protocol === "trojan") {
    const s = ob.settings?.servers?.[0];
    if (!s) return null;
    const ss = ob.streamSettings || {};
    const net = ss.network || "tcp";
    const p: Record<string, unknown> = {
      name: remark || ob.tag || `${s.address}:${s.port}`,
      type: "trojan",
      server: s.address,
      port: Number(s.port),
      password: s.password,
      udp: true,
      network: net === "h2" ? "http" : net,
    };
    const t = ss.tlsSettings || {};
    if (t.serverName) p.sni = t.serverName;
    if (t.fingerprint) p["client-fingerprint"] = t.fingerprint;
    if (net === "ws") p["ws-opts"] = { path: ss.wsSettings?.path || "/", headers: ss.wsSettings?.headers || {} };
    return p as ProxyConfig;
  }
  return null;
```

In `singBoxOutboundToMihomo`, add before the vless guard:

```ts
  if (ob?.type === "trojan" && ob.server) {
    const p: Record<string, unknown> = {
      name: ob.tag || `${ob.server}:${ob.server_port}`,
      type: "trojan",
      server: ob.server,
      port: Number(ob.server_port),
      password: ob.password,
      udp: true,
    };
    if (ob.tls?.server_name) p.sni = ob.tls.server_name;
    if (ob.tls?.insecure) p["skip-cert-verify"] = true;
    return p as ProxyConfig;
  }
```

- [ ] **Step 5: Run gates → PASS.**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(sources): trojan single-link + JSON ingest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: vmess

vmess single links are `vmess://<base64 of a JSON object>` (v2rayN schema: `add,port,id,aid,net,type,host,path,tls,sni,ps`).

**Files:** `parse.ts` (`parseVmess`, registration, `v2rayOutboundToMihomo`, `singBoxOutboundToMihomo`), `parse.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { parseVmess } from "./parse.js";

describe("parseVmess", () => {
  it("maps a vmess:// base64 JSON link", () => {
    const conf = {
      v: "2", ps: "VM", add: "ex.com", port: "443", id: "uuid-1",
      aid: "0", net: "ws", type: "none", host: "ex.com", path: "/ws", tls: "tls", sni: "ex.com",
    };
    const uri = `vmess://${Buffer.from(JSON.stringify(conf)).toString("base64")}`;
    const p = parseVmess(uri);
    expect(p).toMatchObject({
      name: "VM", type: "vmess", server: "ex.com", port: 443,
      uuid: "uuid-1", alterId: 0, cipher: "auto", network: "ws", tls: true, servername: "ex.com",
    });
    expect(p["ws-opts"]).toEqual({ path: "/ws", headers: { Host: "ex.com" } });
  });
  it("is reachable via detectKind", () => {
    const uri = `vmess://${Buffer.from(JSON.stringify({ add: "h", port: "1", id: "u" })).toString("base64")}`;
    expect(detectKind(uri)).toBe("vmess");
  });
});
```

- [ ] **Step 2: Run test → FAIL.**

Run: `pnpm -F @submerge/server test -- parse.test.ts`

- [ ] **Step 3: Implement `parseVmess` + register**

```ts
// ── vmess:// (base64 v2rayN JSON) → mihomo proxy ────────────────────
export function parseVmess(uri: string): ProxyConfig {
  const b64 = uri.trim().replace(/^vmess:\/\//i, "");
  let conf: Record<string, unknown>;
  try {
    conf = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    throw new Error("could not parse the vmess:// payload");
  }
  const str = (k: string) => (conf[k] == null ? "" : String(conf[k]));
  const server = str("add");
  const port = Number(str("port")) || 443;
  const net = str("net") || "tcp";
  const p: Record<string, unknown> = {
    name: str("ps") || `${server}:${port}`,
    type: "vmess",
    server,
    port,
    uuid: str("id"),
    alterId: Number(str("aid")) || 0,
    cipher: "auto",
    udp: true,
    network: net === "h2" ? "http" : net,
  };
  if (str("tls") === "tls") {
    p.tls = true;
    p.servername = str("sni") || str("host") || server;
  }
  const host = str("host");
  const path = str("path") || "/";
  if (net === "ws") p["ws-opts"] = { path, headers: { Host: host || str("sni") || server } };
  else if (net === "grpc") p["grpc-opts"] = { "grpc-service-name": path.replace(/^\//, "") };
  return p as ProxyConfig;
}
```

Register `"vmess:": { kind: "vmess", parse: parseVmess }`; remove `"vmess:"` from `UNSUPPORTED_SINGLE`.

- [ ] **Step 4: Add vmess branch to the JSON converters**

In `v2rayOutboundToMihomo`, add a `ob?.protocol === "vmess"` branch (vnext/users like vless, plus `cipher: "auto"`, `alterId: user.alterId ?? 0`, `type: "vmess"`):

```ts
  if (ob?.protocol === "vmess") {
    const vnext = ob.settings?.vnext?.[0];
    const user = vnext?.users?.[0];
    if (!vnext || !user) return null;
    const ss = ob.streamSettings || {};
    const net = ss.network || "tcp";
    const p: Record<string, unknown> = {
      name: remark || ob.tag || `${vnext.address}:${vnext.port}`,
      type: "vmess",
      server: vnext.address,
      port: Number(vnext.port),
      uuid: user.id,
      alterId: user.alterId ?? 0,
      cipher: user.security || "auto",
      udp: true,
      network: net === "h2" ? "http" : net,
    };
    if ((ss.security || "none") === "tls") {
      p.tls = true;
      const t = ss.tlsSettings || {};
      p.servername = t.serverName || vnext.address;
    }
    if (net === "ws") p["ws-opts"] = { path: ss.wsSettings?.path || "/", headers: ss.wsSettings?.headers || {} };
    return p as ProxyConfig;
  }
```

In `singBoxOutboundToMihomo`, add before the vless guard:

```ts
  if (ob?.type === "vmess" && ob.server) {
    const p: Record<string, unknown> = {
      name: ob.tag || `${ob.server}:${ob.server_port}`,
      type: "vmess",
      server: ob.server,
      port: Number(ob.server_port),
      uuid: ob.uuid,
      alterId: ob.alter_id ?? 0,
      cipher: ob.security || "auto",
      udp: true,
    };
    if (ob.tls?.enabled) {
      p.tls = true;
      p.servername = ob.tls.server_name || ob.server;
    }
    return p as ProxyConfig;
  }
```

- [ ] **Step 5: Run gates → PASS.**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(sources): vmess single-link + JSON ingest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: shadowsocks (ss)

SIP002 form: `ss://<base64url(method:password)>@host:port#name` (also the legacy `ss://base64(method:password@host:port)#name`).

**Files:** `parse.ts` (`parseShadowsocks`, registration, `singBoxOutboundToMihomo`), `parse.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { parseShadowsocks } from "./parse.js";

describe("parseShadowsocks", () => {
  it("maps a SIP002 ss:// link", () => {
    const userinfo = Buffer.from("aes-256-gcm:secret").toString("base64url");
    const p = parseShadowsocks(`ss://${userinfo}@ex.com:8388#SS`);
    expect(p).toMatchObject({ name: "SS", type: "ss", server: "ex.com", port: 8388, cipher: "aes-256-gcm", password: "secret" });
  });
  it("is reachable via detectKind", () => {
    const userinfo = Buffer.from("aes-256-gcm:pw").toString("base64url");
    expect(detectKind(`ss://${userinfo}@ex.com:8388`)).toBe("ss");
  });
});
```

- [ ] **Step 2: Run test → FAIL.**

Run: `pnpm -F @submerge/server test -- parse.test.ts`

- [ ] **Step 3: Implement `parseShadowsocks` + register**

```ts
// ── ss:// (SIP002, with legacy fallback) → mihomo proxy ─────────────
export function parseShadowsocks(uri: string): ProxyConfig {
  const raw = uri.trim();
  const hash = raw.indexOf("#");
  const name = hash >= 0 ? decodeURIComponent(raw.slice(hash + 1)) : "";
  const body = (hash >= 0 ? raw.slice(0, hash) : raw).replace(/^ss:\/\//i, "");
  let cipher: string;
  let password: string;
  let server: string;
  let port: number;
  const at = body.lastIndexOf("@");
  if (at >= 0) {
    // SIP002: base64url(method:password) @ host:port
    const [method, pass] = Buffer.from(body.slice(0, at), "base64url").toString("utf8").split(":");
    cipher = method || "";
    password = pass || "";
    const hostPort = body.slice(at + 1);
    const c = hostPort.lastIndexOf(":");
    server = hostPort.slice(0, c);
    port = Number(hostPort.slice(c + 1)) || 8388;
  } else {
    // legacy: base64(method:password@host:port)
    const dec = Buffer.from(body, "base64").toString("utf8");
    const m = dec.match(/^(.*?):(.*)@(.*):(\d+)$/);
    if (!m) throw new Error("could not parse the ss:// payload");
    [, cipher, password, server, port] = [m[0], m[1] as string, m[2] as string, m[3] as string, Number(m[4])] as [string, string, string, string, number];
  }
  return {
    name: name || `${server}:${port}`,
    type: "ss",
    server,
    port,
    cipher,
    password,
    udp: true,
  } as ProxyConfig;
}
```

Register `"ss:": { kind: "ss", parse: parseShadowsocks }`; remove `"ss:"` from `UNSUPPORTED_SINGLE`.

- [ ] **Step 4: Add ss branch to `singBoxOutboundToMihomo`**

```ts
  if (ob?.type === "shadowsocks" && ob.server) {
    return {
      name: ob.tag || `${ob.server}:${ob.server_port}`,
      type: "ss",
      server: ob.server,
      port: Number(ob.server_port),
      cipher: ob.method,
      password: ob.password,
      udp: true,
    } as ProxyConfig;
  }
```

(v2ray/xray rarely emits shadowsocks outbounds; skip that path — a `shadowsocks` xray outbound will fall through and be counted as skipped, which is acceptable.)

- [ ] **Step 5: Run gates → PASS.**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(sources): shadowsocks single-link + sing-box ingest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: tuic

`tuic://<uuid>:<password>@host:port?sni=&alpn=&congestion_control=#name`. mihomo type `tuic` (uuid + password, QUIC).

**Files:** `parse.ts` (`parseTuic`, registration, `singBoxOutboundToMihomo`), `parse.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { parseTuic } from "./parse.js";

describe("parseTuic", () => {
  it("maps a tuic:// URI", () => {
    const p = parseTuic("tuic://uuid-1:secret@ex.com:443?sni=ex.com&congestion_control=bbr#TU");
    expect(p).toMatchObject({
      name: "TU", type: "tuic", server: "ex.com", port: 443,
      uuid: "uuid-1", password: "secret", sni: "ex.com", "congestion-controller": "bbr",
    });
  });
  it("is reachable via detectKind", () => {
    expect(detectKind("tuic://u:p@ex.com:443")).toBe("tuic");
  });
});
```

- [ ] **Step 2: Run test → FAIL.**

Run: `pnpm -F @submerge/server test -- parse.test.ts`

- [ ] **Step 3: Implement `parseTuic` + register**

```ts
// ── tuic:// → mihomo proxy ──────────────────────────────────────────
export function parseTuic(uri: string): ProxyConfig {
  const u = new URL(uri.trim());
  if (u.protocol !== "tuic:") throw new Error("not a tuic:// link");
  const q = u.searchParams;
  const server = u.hostname;
  const port = Number(u.port) || 443;
  const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : `${server}:${port}`;
  const p: Record<string, unknown> = {
    name,
    type: "tuic",
    server,
    port,
    uuid: decodeURIComponent(u.username || ""),
    password: decodeURIComponent(u.password || ""),
    udp: true,
  };
  const sni = q.get("sni");
  if (sni) p.sni = sni;
  const alpn = q.get("alpn");
  if (alpn) p.alpn = alpn.split(",");
  const cc = q.get("congestion_control");
  if (cc) p["congestion-controller"] = cc;
  if (q.get("allow_insecure") === "1") p["skip-cert-verify"] = true;
  return p as ProxyConfig;
}
```

Register `"tuic:": { kind: "tuic", parse: parseTuic }`; remove `"tuic:"` from `UNSUPPORTED_SINGLE` (leaving only `"ssr:"` and `"hysteria:"`).

- [ ] **Step 4: Add tuic branch to `singBoxOutboundToMihomo`**

```ts
  if (ob?.type === "tuic" && ob.server) {
    const p: Record<string, unknown> = {
      name: ob.tag || `${ob.server}:${ob.server_port}`,
      type: "tuic",
      server: ob.server,
      port: Number(ob.server_port),
      uuid: ob.uuid,
      password: ob.password,
      udp: true,
    };
    if (ob.tls?.server_name) p.sni = ob.tls.server_name;
    if (ob.congestion_control) p["congestion-controller"] = ob.congestion_control;
    return p as ProxyConfig;
  }
```

- [ ] **Step 5: Run gates → PASS.**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(sources): tuic single-link + sing-box ingest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Final review + web kind labels

- [ ] **Step 1: Per-kind labels/icons in web**

Find where `source.kind` is displayed (grep `kind` in `packages/web/src/features/sources`). Add labels for the new kinds so they don't render raw (e.g. a `KIND_LABEL: Record<string, string>` with `hysteria2: "Hysteria2"`, `vmess: "VMess"`, `trojan: "Trojan"`, `ss: "Shadowsocks"`, `tuic: "TUIC"`, `vless: "VLESS"`, `sub: "Подписка"`, `happ: "Happ"`; unknown → the raw kind). If kind is not currently shown, skip this step.

- [ ] **Step 2: Full gates + manual sanity**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`
Expected: PASS. Then a manual check: `parseProxiesFromText` of a mixed body (vless + hysteria2 + ssr) returns 2 proxies and `skipped: ["ssr"]`.

- [ ] **Step 3: Run the independent review gate**

Run `/code-review` on the full diff (per AGENTS.md final-review gate) and resolve findings before shipping.

- [ ] **Step 4: Commit any review fixes, then stop for user sign-off before push**

The repo deploys on push to master — do not push until the user asks.

```bash
git add -A
git commit -m "feat(sources): web kind labels for non-vless protocols

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Real-sample calibration:** field names above match the canonical formats in the spec's research. Provider variants exist; if a real subscription parses wrong, adjust the specific mapper and add a fixture — the TDD structure makes this a one-test change.
- **`as ProxyConfig` casts** are intentional: `proxySchema` is a `looseObject`, so extra protocol fields pass through unvalidated (same as `parseVless`).
- **Don't touch `buildConfig`** — it writes proxies untyped; mihomo accepts every type above natively.
- **exactOptionalPropertyTypes:** set optional fields conditionally (`if (x) p.foo = x`), never assign `undefined` — matches the existing `parseVless` style.
