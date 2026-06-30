import { loginInput, sessionStatusSchema } from "@submerge/shared";
import { TRPCError } from "@trpc/server";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { publicProcedure, router } from "../trpc/trpc.js";
import {
  clearSessionCookie,
  parseCookies,
  SESSION_COOKIE,
  serializeSessionCookie,
} from "./cookies.js";
import {
  createSession,
  deleteSession,
  isRateLimited,
  recordLoginFailure,
  resetRateLimit,
  SESSION_TTL_SEC,
  verifyPassword,
} from "./service.js";

export const authRouter = router({
  me: publicProcedure.query(({ ctx }) =>
    sessionStatusSchema.parse({ authed: ctx.authed, required: ctx.authRequired }),
  ),

  login: publicProcedure.input(loginInput).mutation(async ({ ctx, input }) => {
    if (!env.ADMIN_PASSWORD) return { ok: true as const }; // auth disabled → no-op success
    if (isRateLimited()) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Слишком много попыток" });
    }
    const ok = await verifyPassword(env.ADMIN_PASSWORD, input.password);
    if (!ok) {
      recordLoginFailure();
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Неверный пароль" });
    }
    resetRateLimit();
    const { id } = createSession(db);
    ctx.res.setHeader("Set-Cookie", serializeSessionCookie(id, SESSION_TTL_SEC, env.COOKIE_SECURE));
    return { ok: true as const };
  }),

  logout: publicProcedure.mutation(({ ctx }) => {
    const sid = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE];
    if (sid) deleteSession(db, sid);
    ctx.res.setHeader("Set-Cookie", clearSessionCookie(env.COOKIE_SECURE));
    return { ok: true as const };
  }),
});
