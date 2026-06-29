import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import type { Context } from "../trpc/trpc.js";
import { parseCookies, SESSION_COOKIE } from "./cookies.js";
import { validateSession } from "./service.js";

// Build the per-request tRPC context. When ADMIN_PASSWORD is unset, auth is
// disabled and every request is treated as authenticated (authed = true).
export function createAppContext(opts: { req: IncomingMessage; res: ServerResponse }): Context {
  const authRequired = Boolean(env.ADMIN_PASSWORD);
  const sid = parseCookies(opts.req.headers.cookie)[SESSION_COOKIE];
  const authed = !authRequired || validateSession(db, sid);
  return { authed, authRequired, req: opts.req, res: opts.res };
}
