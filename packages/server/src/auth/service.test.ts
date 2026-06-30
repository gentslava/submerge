import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessions } from "../db/schema.js";
import {
  createSession,
  deleteSession,
  isRateLimited,
  recordLoginFailure,
  resetRateLimit,
  validateSession,
  verifyPassword,
} from "./service.js";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE sessions (id text PRIMARY KEY NOT NULL, expires_at integer NOT NULL);");
  return drizzle(sqlite);
}

describe("auth service", () => {
  beforeEach(() => resetRateLimit());
  afterEach(() => resetRateLimit());

  it("verifies the admin password with argon2id", async () => {
    expect(await verifyPassword("s3cret", "s3cret")).toBe(true);
    expect(await verifyPassword("s3cret", "wrong")).toBe(false);
    expect(await verifyPassword(undefined, "anything")).toBe(false); // auth disabled
  });

  it("creates, validates, and deletes a session", () => {
    const db = freshDb();
    const { id, expiresAt } = createSession(db);
    expect(id).toHaveLength(64); // 32 bytes hex
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(validateSession(db, id)).toBe(true);
    expect(validateSession(db, "nope")).toBe(false);
    deleteSession(db, id);
    expect(validateSession(db, id)).toBe(false);
  });

  it("treats an expired session as invalid", () => {
    const db = freshDb();
    db.insert(sessions)
      .values({ id: "old", expiresAt: Date.now() - 1000 })
      .run();
    expect(validateSession(db, "old")).toBe(false);
  });

  it("rate-limits after too many failures", () => {
    for (let i = 0; i < 5; i++) {
      expect(isRateLimited()).toBe(false);
      recordLoginFailure();
    }
    expect(isRateLimited()).toBe(true);
  });
});
