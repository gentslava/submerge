import { randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { eq, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_TTL_SEC = SESSION_TTL_MS / 1000;

// Memoize the Argon2id hash of the configured admin password (by value) so we
// hash once, not per login. verify() is slow + constant-time by design. The
// cache lives only in memory (≈1 entry — the env password); rotating the
// password takes effect on process restart.
const hashCache = new Map<string, Promise<string>>();
export async function verifyPassword(
  adminPassword: string | undefined,
  submitted: string,
): Promise<boolean> {
  // Both undefined and "" mean auth is disabled — never authenticate.
  if (!adminPassword) return false;
  let h = hashCache.get(adminPassword);
  if (!h) {
    h = hash(adminPassword);
    hashCache.set(adminPassword, h);
  }
  return verify(await h, submitted);
}

export function createSession(db: Db): { id: string; expiresAt: number } {
  const id = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.insert(sessions).values({ id, expiresAt }).run();
  return { id, expiresAt };
}

export function validateSession(db: Db, id: string | undefined): boolean {
  if (!id) return false;
  const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!row) return false;
  if (row.expiresAt <= Date.now()) {
    db.delete(sessions).where(eq(sessions.id, id)).run(); // prune expired
    return false;
  }
  return true;
}

export function deleteSession(db: Db, id: string): void {
  db.delete(sessions).where(eq(sessions.id, id)).run();
}

// validateSession prunes an expired row only when that exact id is presented
// again; abandoned sessions would accumulate forever. Called on boot.
export function pruneExpiredSessions(db: Db): void {
  db.delete(sessions).where(lte(sessions.expiresAt, Date.now())).run();
}

// In-memory sliding-window rate limit (single admin; no Redis). 5 fails / 60 s.
const RL_MAX = 5;
const RL_WINDOW_MS = 60_000;
let failures: number[] = [];
export function isRateLimited(): boolean {
  const cutoff = Date.now() - RL_WINDOW_MS;
  failures = failures.filter((t) => t > cutoff);
  return failures.length >= RL_MAX;
}
export function recordLoginFailure(): void {
  failures.push(Date.now());
}
export function resetRateLimit(): void {
  failures = [];
}
