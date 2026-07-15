import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { createAppContext } from "./auth/context.js";
import { pruneExpiredSessions } from "./auth/service.js";
import { setMihomoSecret } from "./clients/mihomo.js";
import { env } from "./config/env.js";
import { db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { liveHub } from "./live/singleton.js";
import { log } from "./log.js";
import { ensureDefaultChannel, ensureDirectChannel } from "./modules/channels/service.js";
import { applyConfig, readMihomoSecret } from "./modules/nodes/service.js";
import { backfillSubUrls } from "./modules/sources/service.js";
import { contentTypeFor, safeResolve } from "./static.js";
import { appRouter } from "./trpc/router.js";

// Built web SPA served alongside /trpc and /healthz (same origin).
const WEB_DIST = resolve(env.WEB_DIST);
const INDEX_HTML = resolve(WEB_DIST, "index.html");

async function serveStatic(url: string, res: ServerResponse): Promise<void> {
  const file = safeResolve(WEB_DIST, url);
  try {
    if (file) {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": contentTypeFor(file) });
      res.end(body);
      return;
    }
  } catch {
    /* missing file → fall through to index.html (SPA route) */
  }
  try {
    const html = await readFile(INDEX_HTML);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

// Apply any pending DB migrations before accepting connections
runMigrations();

// Seed the Default channel on first boot (idempotent — no-op if already present).
ensureDefaultChannel(db);
ensureDirectChannel(db);

// Backfill sub_url for pre-migration sub/deep-link rows so dedup covers them.
backfillSubUrls(db);

// Abandoned sessions are otherwise pruned only if their exact id is looked up
// again — sweep the expired ones on boot so the table can't grow unbounded.
pruneExpiredSessions(db);

// Use the panel-set mihomo secret (if any) before talking to the engine.
setMihomoSecret(readMihomoSecret(db));

// Regenerate + reload the mihomo config from the current DB state on boot. Without
// this, a restart leaves the engine on whatever config is on disk, which can drift
// from the DB (the UI's source of truth): channels/rules show in the panel while the
// engine routes their domains through the global PROXY node because their rules aren't
// in the running config. The config file is written synchronously here (so mihomo
// reads the fresh file on its own start); the reload is best-effort and fire-and-forget
// so a not-yet-ready engine can't block or crash boot — the live loop keeps it in sync.
void applyConfig(db).catch((err) => log.warn({ err }, "boot config apply failed"));

// Begin polling mihomo + pumping its traffic stream; fans out to live subscribers
liveHub.start();

const trpcHandler = createHTTPHandler({
  router: appRouter,
  createContext: ({ req, res }) => createAppContext({ req, res }),
});

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.startsWith("/trpc")) {
    // Strip the /trpc prefix so the tRPC handler sees procedure paths only
    req.url = url.slice("/trpc".length) || "/";
    trpcHandler(req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    void serveStatic(url, res);
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(env.PORT, env.HOST, () =>
  log.info({ host: env.HOST, port: env.PORT }, "submerge server listening"),
);

// Graceful shutdown: stop the hub, then stop accepting new connections and exit
const shutdown = () => {
  liveHub.stop();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
