import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./client.js";

/**
 * Runs all pending Drizzle migrations from the drizzle/ folder.
 * Safe to call on startup — applies only unapplied migrations.
 */
export function runMigrations() {
  migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
}

// Allow running directly: `node src/db/migrate.ts`
if (import.meta.url === `file://${process.argv[1]}`) runMigrations();
