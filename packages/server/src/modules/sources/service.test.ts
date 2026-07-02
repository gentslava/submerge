import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import {
  addSource,
  backfillSubUrls,
  listSources,
  refreshSource,
  removeSource,
  reorderSources,
  toggleSource,
} from "./service.js";

function freshDb() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  return db;
}
const tmpConfig = () => join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
const hwidFile = () => join(mkdtempSync(join(tmpdir(), "submerge-")), "hwid.txt");

// Subscriptions resolve to one node; mihomo reload returns 204.
function stubNet(
  subBody = "proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n",
) {
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
    const { source: src } = await addSource(
      db,
      { value: "vless://u@ex.com:443?security=tls#NL", hwid: false },
      tmpConfig(),
      hwidFile(),
    );
    expect(src.kind).toBe("vless");
    expect(src.label).toBe("NL");
    expect(src.proxies).toHaveLength(1);
    expect(src.sortOrder).toBe(0);
    const list = await listSources(db);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(src.id);
  });

  it("rejects a duplicate source value (trimmed) without inserting it", async () => {
    const db = freshDb();
    stubNet();
    await addSource(db, { value: "vless://u@ex.com:443#A", hwid: false }, tmpConfig(), hwidFile());
    await expect(
      // same value with surrounding whitespace — must still be caught
      addSource(db, { value: "  vless://u@ex.com:443#A  ", hwid: false }, tmpConfig(), hwidFile()),
    ).rejects.toThrow(/уже добавлен/);
    expect(await listSources(db)).toHaveLength(1);
  });

  it("appends sources with increasing sortOrder", async () => {
    const db = freshDb();
    stubNet();
    const { source: a } = await addSource(
      db,
      { value: "vless://u@ex.com:443#A", hwid: false },
      tmpConfig(),
      hwidFile(),
    );
    const { source: b } = await addSource(
      db,
      { value: "vless://u@ex.com:443#B", hwid: false },
      tmpConfig(),
      hwidFile(),
    );
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);
  });

  it("toggles enabled and removes a source", async () => {
    const db = freshDb();
    stubNet();
    const { source: src } = await addSource(
      db,
      { value: "vless://u@ex.com:443#A", hwid: false },
      tmpConfig(),
      hwidFile(),
    );
    const toggled = await toggleSource(db, src.id, tmpConfig());
    expect(toggled.source.enabled).toBe(false);
    await removeSource(db, src.id, tmpConfig());
    expect(await listSources(db)).toHaveLength(0);
  });

  it("persists the source and reports applied:false when the engine reload fails", async () => {
    const db = freshDb();
    // subscription fetch works, but the mihomo reload endpoint is down
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        String(url).includes("/configs")
          ? new Response("engine down", { status: 503 })
          : new Response(
              "proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n",
              { status: 200 },
            ),
      ),
    );
    const { source: src, applied } = await addSource(
      db,
      { value: "https://ex.com/sub", hwid: false },
      tmpConfig(),
      hwidFile(),
    );
    expect(applied).toBe(false);
    expect(src.proxies).toHaveLength(1);
    expect(await listSources(db)).toHaveLength(1); // saved despite the failed reload
    const toggled = await toggleSource(db, src.id, tmpConfig());
    expect(toggled.applied).toBe(false);
    expect(toggled.source.enabled).toBe(false);
  });

  it("reorders sources by id list", async () => {
    const db = freshDb();
    stubNet();
    const { source: a } = await addSource(
      db,
      { value: "vless://u@ex.com:443#A", hwid: false },
      tmpConfig(),
      hwidFile(),
    );
    const { source: b } = await addSource(
      db,
      { value: "vless://u@ex.com:443#B", hwid: false },
      tmpConfig(),
      hwidFile(),
    );
    await reorderSources(db, [b.id, a.id], tmpConfig());
    const list = await listSources(db);
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]); // listSources orders by sortOrder
  });

  it("re-ingests and updates the snapshot on refresh", async () => {
    const db = freshDb();
    stubNet(); // first ingest → node "A"
    const { source: src } = await addSource(
      db,
      { value: "https://ex.com/sub", hwid: false },
      tmpConfig(),
      hwidFile(),
    );
    expect(src.proxies[0]?.name).toBe("A");
    stubNet("proxies:\n  - {name: Z, type: vless, server: ex.com, port: 443, uuid: u}\n"); // re-ingest → node "Z"
    const refreshed = await refreshSource(db, src.id, tmpConfig(), hwidFile());
    expect(refreshed.source.proxies[0]?.name).toBe("Z"); // snapshot was refreshed, not stale
    expect(typeof refreshed.source.updatedAt).toBe("string");
  });

  it("throws when refreshing a missing source", async () => {
    const db = freshDb();
    await expect(refreshSource(db, 9999, tmpConfig(), hwidFile())).rejects.toThrow(
      "source 9999 not found",
    );
  });

  it("rejects a happ link that decodes to an already-added subscription", async () => {
    const db = freshDb();
    // Two DIFFERENT ciphertexts (crypt5 is non-deterministic) → the SAME sub URL.
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/decode")) {
          return new Response(
            JSON.stringify({
              ok: true,
              url: "https://provider.example/sub/abc",
              body: "proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (String(url).includes("/configs") || String(url).includes("9090"))
          return new Response(null, { status: 204 });
        return new Response(
          "proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n",
          { status: 200 },
        );
      }),
    );
    await addSource(db, { value: "happ://crypt5/blobONE", hwid: false }, tmpConfig(), hwidFile());
    await expect(
      addSource(db, { value: "happ://crypt5/blobTWO", hwid: false }, tmpConfig(), hwidFile()),
    ).rejects.toThrow(/та же подписка/);
    expect(await listSources(db)).toHaveLength(1);
  });

  it("rejects a deep-link wrapping an already-added subscription url", async () => {
    const db = freshDb();
    stubNet();
    await addSource(db, { value: "https://ex.com/sub", hwid: false }, tmpConfig(), hwidFile());
    await expect(
      addSource(
        db,
        // client deep-link wrapping the same url — different raw string
        { value: "clash://install-config?url=https%3A%2F%2Fex.com%2Fsub", hwid: false },
        tmpConfig(),
        hwidFile(),
      ),
    ).rejects.toThrow(/та же подписка/);
    expect(await listSources(db)).toHaveLength(1);
  });

  it("backfills sub_url for a pre-migration sub row so dedup then catches it", async () => {
    const db = freshDb();
    // Simulate a row added before sub_url existed: insert directly with subUrl null.
    db.insert(sources)
      .values({ kind: "sub", value: "https://ex.com/sub", label: "old", subUrl: null })
      .run();
    backfillSubUrls(db);
    expect(db.select().from(sources).all()[0]?.subUrl).toBe("https://ex.com/sub");
    // …and a deep-link wrapping the same url is now rejected.
    stubNet();
    await expect(
      addSource(
        db,
        { value: "clash://install-config?url=https%3A%2F%2Fex.com%2Fsub", hwid: false },
        tmpConfig(),
        hwidFile(),
      ),
    ).rejects.toThrow(/та же подписка/);
  });
});
