import { createServer } from "node:http";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import pino from "pino";
import { env } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { liveHub } from "./live/singleton.js";
import { appRouter } from "./trpc/router.js";

const log = pino({ name: "submerge" });

// Apply any pending DB migrations before accepting connections
runMigrations();

// Begin polling mihomo + pumping its traffic stream; fans out to live subscribers
liveHub.start();

const trpcHandler = createHTTPHandler({
  router: appRouter,
  // auth is added in Phase 5; for now all requests are considered authed
  createContext: () => ({ authed: true }),
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

  res.writeHead(404);
  res.end("not found");
});

server.listen(env.PORT, () => log.info(`submerge server on :${env.PORT}`));

// Graceful shutdown: stop the hub, then stop accepting new connections and exit
const shutdown = () => {
  liveHub.stop();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
