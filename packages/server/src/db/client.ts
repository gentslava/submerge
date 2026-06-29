import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

/**
 * Creates a Drizzle database instance backed by better-sqlite3.
 * Uses WAL journal mode for improved concurrent read performance.
 * Pass ":memory:" for in-process testing without touching the filesystem.
 */
export function createDb(path: string = env.DB_PATH) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;

// Module-level singleton using the path from environment config.
export const db = createDb();
